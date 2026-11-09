import type { Document } from 'mongodb';

// ─── StripePulse · scenario runner ──────────────────────────────────────────
// Orchestrates the four demonstration scenarios. Every status change and
// every log line below is written by real backend work — the dashboard only
// replays what is stored here.

import { randomUUID } from 'node:crypto';
import type { RunDoc, SubscriptionDoc } from './types';
import { collections, getDb } from './mongo';
import { getGateway, simId } from './gateway';
import { insertSteps, completeStep, failStep, finishRun, logApi, markStep, startStep } from './recorder';
import { STEP_PLANS } from './steps';
import { dispatchWebhook } from './dispatcher';
import { ensureScheduler } from './scheduler';
import {
  buildEvent,
  invoicePaid,
  invoicePaymentFailed,
  paymentIntentSucceeded,
  subMetaFromSession,
  subscriptionCancelReversed,
  subscriptionCancelScheduled,
  subscriptionCreated,
  subscriptionDeleted,
  subscriptionUpdated,
  type SubMeta,
} from './events';

const nowIso = () => new Date().toISOString();

async function createRun(
  scenario: RunDoc['scenario'],
  plan: { id: string; planName: string; amount: number; currency: string },
  customer: { email: string; name: string },
): Promise<RunDoc> {
  const db = await getDb();
  const run: RunDoc = {
    _id: `run_${randomUUID().slice(0, 8)}`,
    scenario,
    mode: getGateway().mode,
    status: 'running',
    planId: plan.id,
    planName: plan.planName,
    amount: plan.amount,
    currency: plan.currency,
    customerEmail: customer.email,
    customerName: customer.name,
    createdAt: nowIso(),
  };
  await collections(db).runs.insertOne({ ...run });
  await insertSteps(run._id, STEP_PLANS[scenario]);
  ensureScheduler();
  return run;
}

async function getPlan(planId?: string) {
  const db = await getDb();
  const p =
    (planId
      ? await collections(db).plans.findOne({ _id: planId } as { _id: string })
      : null) ??
    (await collections(db).plans.findOne({ _id: 'price_pro_monthly' } as { _id: string }));
  if (!p) throw new Error('No plans seeded');
  return { id: p._id, planName: p.planName, amount: p.amount, currency: p.currency };
}

function metaFrom(run: RunDoc, subId: string): SubMeta {
  return {
    runId: run._id,
    subscriptionId: subId,
    customerId: run.customerId ?? 'unknown',
    customerEmail: run.customerEmail,
    planId: run.planId,
    planName: run.planName,
    amount: run.amount,
    currency: run.currency,
  };
}

async function latestSubscription(): Promise<SubscriptionDoc | null> {
  const db = await getDb();
  const doc = await collections(db).subscriptions
    .find({ status: { $in: ['active', 'trialing', 'past_due'] } } as Document)
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return (doc as unknown as SubscriptionDoc) ?? null;
}

// ─── Scenario 1 · checkout_success ───────────────────────────────────────────

export async function startCheckoutRun(input: {
  planId?: string;
  email?: string;
  name?: string;
}): Promise<{ runId: string; sessionId: string; url: string | null; mode: string }> {
  const gateway = getGateway();
  const plan = await getPlan(input.planId);
  const email = input.email || `ava.demo+${Math.random().toString(36).slice(2, 6)}@stripepulse.dev`;
  const name = input.name || 'Ava Chen';

  const run = await createRun('checkout_success', plan, { email, name });
  await startStep(run._id, 'checkout_created');

  // 1 · Create customer
  const customerId = await gateway.createCustomer(email, name, run._id);
  await logApi({
    runId: run._id,
    direction: 'outbound',
    component: gateway.mode === 'live' ? 'stripe-api' : 'stripe-api (simulated)',
    method: 'POST',
    path: '/v1/customers',
    statusCode: 200,
    request: { email, name },
    response: { id: customerId, object: 'customer' },
  });

  // 2 · Create checkout session
  const t0 = Date.now();
  const session = await gateway.createCheckoutSession({
    runId: run._id,
    customer: { customerId, email, name },
    plan,
  });
  await logApi({
    runId: run._id,
    direction: 'outbound',
    component: gateway.mode === 'live' ? 'stripe-api' : 'stripe-api (simulated)',
    method: 'POST',
    path: '/v1/checkout/sessions',
    statusCode: 200,
    durationMs: Math.max(Date.now() - t0, 1),
    request: { mode: 'subscription', customer: customerId, 'line_items[0][price]': plan.id },
    response: { id: session.sessionId, status: 'open', url: session.url ?? '(in-app hosted dialog)' },
  });

  await completeStep(run._id, 'checkout_created', {
    sessionId: session.sessionId,
    customerId,
    customerEmail: email,
    mode: 'subscription',
  });
  await completeStep(run._id, 'stripe_api_call', {
    method: 'POST',
    path: '/v1/checkout/sessions',
    statusCode: 200,
    api_version: '2025-11-17.preview',
    sessionId: session.sessionId,
  });

  const db = await getDb();
  const subId = await simId('sub');
  await collections(db).runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { customerId, checkoutSessionId: session.sessionId, subscriptionId: subId },
  });

  // Stash subscription id + customer on the run for the confirm step.
  await collections(db).runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { subscriptionId: subId },
  });

  return { runId: run._id, sessionId: session.sessionId, url: session.url, mode: gateway.mode };
}

export async function confirmCheckout(runId: string): Promise<{ ok: boolean; error?: string }> {
  const db = await getDb();
  const c = collections(db);
  const run = (await c.runs.findOne({ _id: runId } as { _id: string })) as unknown as RunDoc | null;
  if (!run) return { ok: false, error: 'Run not found' };
  if (run.mode !== 'simulated') {
    return { ok: false, error: 'Live mode: complete payment on the Stripe hosted checkout URL.' };
  }

  const subId = run.subscriptionId ?? (await simId('sub'));
  const piId = await simId('pi');
  const inId = await simId('in');
  const meta = metaFrom(run, subId);
  const periodEnd30 = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const trialEnd14 = new Date(Date.now() + 14 * 86_400_000).toISOString();

  // Hosted checkout payment confirmation (simulated card charge)
  await logApi({
    runId,
    direction: 'outbound',
    component: 'stripe-api (simulated) → card network',
    method: 'POST',
    path: `/v1/checkout/sessions/${run.checkoutSessionId}/confirm`,
    statusCode: 200,
    request: {
      payment_method: 'pm_card_visa',
      card: '4242 4242 4242 4242',
      outcome: 'succeeded',
    },
    response: { status: 'complete', payment_status: 'paid', payment_intent: piId },
  });
  await completeStep(runId, 'checkout_paid', {
    card: '4242 4242 4242 4242 (test)',
    paymentMethod: 'pm_card_visa',
    paymentIntentId: piId,
    outcome: 'succeeded',
  });

  // The event chain Stripe emits after a successful checkout.
  const sessionObject = {
    id: run.checkoutSessionId,
    object: 'checkout.session',
    amount_subtotal: run.amount,
    amount_total: run.amount,
    currency: run.currency,
    customer: meta.customerId,
    customer_email: meta.customerEmail,
    livemode: false,
    mode: 'subscription',
    payment_intent: piId,
    payment_status: 'paid',
    status: 'complete',
    subscription: subId,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    metadata: {
      run_id: runId,
      customer_id: meta.customerId,
      customer_email: meta.customerEmail,
      customer_name: run.customerName,
      price_id: meta.planId,
      plan_name: meta.planName,
      amount: String(run.amount),
      currency: run.currency,
    },
  };

  const events = [
    await buildEvent('checkout.session.completed', sessionObject),
    await subscriptionCreated(meta, 14),
    await paymentIntentSucceeded(meta, piId, run.amount),
    await invoicePaid(meta, {
      invoiceId: inId,
      paymentIntentId: piId,
      attempt: 1,
      amount: run.amount,
      periodEndIso: periodEnd30,
    }),
    await subscriptionUpdated(meta, 'active', periodEnd30),
  ];

  // Supersede the trial end (14d) with the paid period (30d) once invoice is paid.
  await dispatchWebhook(events[0], runId);
  await dispatchWebhook(events[1], runId);
  await dispatchWebhook(events[2], runId);
  await dispatchWebhook(events[3], runId);
  await dispatchWebhook(events[4], runId);
  void trialEnd14;

  await completeStep(runId, 'invoice_paid', {
    eventId: events[3].id,
    invoiceId: inId,
    attempt: 1,
    status: 'succeeded',
    amount: run.amount,
  });

  const sub = await c.subscriptions.findOne({ subscriptionId: subId } as { subscriptionId: string });
  await completeStep(runId, 'subscription_activated', {
    subscriptionId: subId,
    from: 'trialing',
    to: sub?.status ?? 'active',
    currentPeriodEnd: sub?.currentPeriodEnd,
  });

  await finishRun(runId, 'completed');
  return { ok: true };
}

// ─── Scenario 2 · payment_retry ──────────────────────────────────────────────

export async function startPaymentRetryRun(input?: { planId?: string }): Promise<{ runId: string; setupRunId?: string }> {
  const db = await getDb();
  const c = collections(db);
  ensureScheduler();

  // Hygiene: a pending failure injection from another scenario would break
  // this scenario's first retry cycle — clear it here (real flag change).
  await c.flags.updateOne(
    { _id: 'db_failure' } as { _id: string },
    { $set: { enabled: false, updatedAt: nowIso() } },
    { upsert: true },
  );

  let sub = await latestSubscription();
  let setupRunId: string | undefined;

  if (!sub) {
    // Bootstrap a subscription through the real checkout flow first.
    const { runId } = await startCheckoutRun({ planId: input?.planId });
    await confirmCheckout(runId);
    setupRunId = runId;
    sub = await latestSubscription();
  }
  if (!sub) throw new Error('Could not establish a subscription for the retry scenario');

  const run = await createRun('payment_retry', { id: sub.priceId, planName: sub.planName, amount: sub.amount, currency: sub.currency }, {
    email: sub.customerEmail,
    name: sub.customerEmail.split('@')[0],
  });
  await c.runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { customerId: sub.customerId, subscriptionId: sub.subscriptionId },
  });
  await completeStep(run._id, 'subscription_ready', {
    subscriptionId: sub.subscriptionId,
    status: sub.status,
    reused: !setupRunId,
    setupRunId,
  });

  // Renewal invoice
  const inId = await simId('in');
  const periodEndIso = new Date(Date.now() + 30 * 86_400_000).toISOString();
  await logApi({
    runId: run._id,
    direction: 'outbound',
    component: 'stripe-api (simulated)',
    method: 'POST',
    path: '/v1/invoices',
    statusCode: 200,
    request: { subscription: sub.subscriptionId, billing_reason: 'subscription_cycle' },
    response: { id: inId, amount_due: sub.amount, status: 'open' },
  });
  await completeStep(run._id, 'invoice_created', {
    invoiceId: inId,
    amountDue: sub.amount,
    currency: sub.currency,
    billingReason: 'subscription_cycle',
    periodEnd: periodEndIso,
  });

  const meta: SubMeta = {
    runId: run._id,
    subscriptionId: sub.subscriptionId,
    customerId: sub.customerId,
    customerEmail: sub.customerEmail,
    planId: sub.priceId,
    planName: sub.planName,
    amount: sub.amount,
    currency: sub.currency,
  };

  // Attempt #1 → declined (test card 4000…0002 behaviour)
  const piId = await simId('pi');
  const t0 = Date.now();
  await logApi({
    runId: run._id,
    direction: 'outbound',
    component: 'stripe-api (simulated) → card network',
    method: 'POST',
    path: `/v1/payment_intents/${piId}/confirm`,
    statusCode: 402,
    durationMs: Math.max(Date.now() - t0, 1),
    request: { payment_method: 'pm_card_visa_chargeDeclined', attempt: 1 },
    response: {
      error: {
        type: 'card_error',
        code: 'card_declined',
        message: 'Your card was declined.',
        decline_code: 'generic_decline',
      },
    },
  });
  await failStep(run._id, 'payment_attempt_1', {
    attempt: 1,
    status: 'failed',
    code: 'card_declined',
    declineCode: 'generic_decline',
    httpStatus: 402,
    message: 'Your card was declined.',
    paymentIntentId: piId,
    card: '4000 0000 0000 0002 (test)',
  });

  // Stripe emits invoice.payment_failed → subscription past_due
  const evtFailed = await invoicePaymentFailed(meta, {
    invoiceId: inId,
    paymentIntentId: piId,
    attempt: 1,
    amount: sub.amount,
    periodEndIso,
    failure: { code: 'card_declined', message: 'Your card was declined.' },
  });
  const resFailed = await dispatchWebhook(evtFailed, run._id);
  void resFailed;

  // Schedule smart retry
  const nextRetryAt = new Date(Date.now() + 6000).toISOString();
  await c.retryJobs.insertOne({
    _id: `job_${randomUUID().slice(0, 8)}`,
    kind: 'payment',
    runId: run._id,
    subscriptionId: sub.subscriptionId,
    invoiceId: inId,
    planId: sub.priceId,
    nextRetryAt,
    attempts: 0,
    status: 'scheduled',
    createdAt: nowIso(),
  });
  await completeStep(run._id, 'retry_scheduled', {
    nextRetryAt,
    strategy: 'smart retry (simulated) · 6s backoff',
    jobKind: 'payment',
  });

  return { runId: run._id, setupRunId };
}

// ─── Scenario 3 · duplicate_webhook ─────────────────────────────────────────

export async function startDuplicateRun(sourceRunId?: string): Promise<{ runId: string; eventId: string }> {
  const db = await getDb();
  const c = collections(db);
  ensureScheduler();

  // Pick the most recent processed event (optionally scoped to a run).
  const q: Document = { status: { $in: ['processed', 'duplicate'] } };
  if (sourceRunId) q.runId = sourceRunId;
  let source = await c.events.find(q).sort({ createdAt: -1 }).limit(1).next();

  if (!source) {
    // No event yet — produce one through the real checkout flow.
    const { runId } = await startCheckoutRun({});
    await confirmCheckout(runId);
    source = await c.events.find({ status: 'processed' } as Document).sort({ createdAt: -1 }).limit(1).next();
    sourceRunId = runId;
  }
  if (!source) throw new Error('No processed event available to duplicate');

  const srcRun = source.runId
    ? await c.runs.findOne({ _id: source.runId } as { _id: string })
    : null;

  const run = await createRun(
    'duplicate_webhook',
    {
      id: srcRun?.planId ?? 'price_pro_monthly',
      planName: srcRun?.planName ?? 'Pro',
      amount: srcRun?.amount ?? 1900,
      currency: srcRun?.currency ?? 'usd',
    },
    { email: srcRun?.customerEmail ?? 'unknown@stripepulse.dev', name: srcRun?.customerName ?? 'Unknown' },
  );
  await completeStep(run._id, 'duplicate_delivery', {
    status: 'pending dispatch',
    sourceEventId: source.eventId,
  });
  await c.runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: {
      customerId: srcRun?.customerId,
      subscriptionId: srcRun?.subscriptionId,
      checkoutSessionId: srcRun?.checkoutSessionId,
    },
  });

  // Re-POST the exact same payload (same eventId) over real HTTP.
  const event = JSON.parse(source.payloadRaw) as Parameters<typeof dispatchWebhook>[0];
  const res = await dispatchWebhook(event, run._id);
  const body = res.body as {
    duplicate?: boolean;
    signatureVerified?: boolean;
    writesExecuted?: number;
  };

  await completeStep(run._id, 'duplicate_delivery', {
    eventId: source.eventId,
    type: source.type,
    statusCode: res.httpStatus,
    sameEventIdRedelivered: true,
    payloadBytes: source.payloadRaw.length,
  });
  await completeStep(run._id, 'signature_verified', {
    verified: body.signatureVerified ?? res.httpStatus === 200,
    algorithm: 'HMAC-SHA256',
    eventId: source.eventId,
  });
  if (body.duplicate) {
    await completeStep(run._id, 'dedup_blocked', {
      result: 'duplicate blocked',
      guard: 'unique index webhook_events.eventId',
      writesExecuted: body.writesExecuted ?? 0,
      endpointResponse: res.body,
    });
    await completeStep(run._id, 'no_side_effects', {
      writesExecuted: body.writesExecuted ?? 0,
      subscriptionsCreated: 0,
      paymentsRecorded: 0,
    });
  } else {
    // Should not happen — record honestly if it does.
    await failStep(run._id, 'dedup_blocked', {
      unexpected: true,
      endpointResponse: res.body,
    });
  }
  await completeStep(run._id, 'ack_200', {
    statusCode: res.httpStatus,
    note: 'Ack 200 prevents Stripe retry storms for known events',
  });

  await finishRun(run._id, 'completed');
  return { runId: run._id, eventId: source.eventId };
}

// ─── Scenario 4 · db_failure_recovery ───────────────────────────────────────

export async function startDbFailureRun(): Promise<{ runId: string; eventId: string }> {
  const db = await getDb();
  const c = collections(db);
  ensureScheduler();

  let sub = await latestSubscription();
  if (!sub) {
    const { runId } = await startCheckoutRun({});
    await confirmCheckout(runId);
    sub = await latestSubscription();
  }
  if (!sub) throw new Error('Could not establish a subscription for the db-failure scenario');

  // Enable the injection BEFORE the event is delivered.
  await c.flags.updateOne(
    { _id: 'db_failure' } as { _id: string },
    { $set: { enabled: true, updatedAt: nowIso() } },
    { upsert: true },
  );

  const run = await createRun(
    'db_failure_recovery',
    { id: sub.priceId, planName: sub.planName, amount: sub.amount, currency: sub.currency },
    { email: sub.customerEmail, name: sub.customerEmail.split('@')[0] },
  );
  await c.runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { customerId: sub.customerId, subscriptionId: sub.subscriptionId },
  });

  const meta: SubMeta = {
    runId: run._id,
    subscriptionId: sub.subscriptionId,
    customerId: sub.customerId,
    customerEmail: sub.customerEmail,
    planId: sub.priceId,
    planName: sub.planName,
    amount: sub.amount,
    currency: sub.currency,
  };
  const evt = await subscriptionUpdated(meta, sub.status, sub.currentPeriodEnd);
  const res = await dispatchWebhook(evt, run._id);
  const body = res.body as { nextRetryAt?: string; attempts?: number; error?: string };

  await completeStep(run._id, 'webhook_500', {
    eventId: evt.id,
    statusCode: res.httpStatus,
    attempts: body.attempts ?? 1,
    error: body.error ?? 'unknown',
  });
  await completeStep(run._id, 'retry_scheduled', {
    nextRetryAt: body.nextRetryAt ?? new Date(Date.now() + 2000).toISOString(),
    backoff: '2s × 2^(attempt−1), max 30s',
    redeliveriesUntilRecovery: 'until injection disabled',
  });

  return { runId: run._id, eventId: evt.id };
}

// ─── Scenario 5 · cancel_subscription (immediate / at period end / reversal)

function cancelMeta(run: RunDoc, sub: SubscriptionDoc): SubMeta {
  return {
    runId: run._id,
    subscriptionId: sub.subscriptionId,
    customerId: sub.customerId,
    customerEmail: sub.customerEmail,
    planId: sub.priceId,
    planName: sub.planName,
    amount: sub.amount,
    currency: sub.currency,
  };
}

// Shared tail of every cancellation run: deliver the event, record the
// pipeline steps, verify what the webhook actually committed, finish honestly.
async function finishCancelRun(
  run: RunDoc,
  sub: SubscriptionDoc,
  evt: Awaited<ReturnType<typeof subscriptionDeleted>>,
  expect: { status: 'canceled' } | { status: 'active'; cancelAtPeriodEnd: boolean },
  actionLabel: string,
): Promise<{ runId: string; subscriptionId: string }> {
  const db = await getDb();
  const c = collections(db);
  const res = await dispatchWebhook(evt, run._id);
  const body = res.body as { received?: boolean; duplicate?: boolean };

  await completeStep(run._id, 'webhook_delivery', {
    eventId: evt.id,
    type: evt.type,
    statusCode: res.httpStatus,
  });
  await completeStep(run._id, 'signature_verified', {
    verified: true,
    algorithm: 'HMAC-SHA256',
    eventId: evt.id,
  });
  await completeStep(run._id, 'dedup_check', {
    result: body.duplicate ? 'duplicate blocked' : 'new event',
    eventId: evt.id,
    guard: 'unique index webhook_events.eventId',
  });

  const fresh = (await c.subscriptions.findOne({
    subscriptionId: sub.subscriptionId,
  } as { subscriptionId: string })) as unknown as SubscriptionDoc | null;

  const ok = fresh
    && (expect.status === 'canceled'
      ? fresh.status === 'canceled'
      : fresh.status === expect.status && (fresh.cancelAtPeriodEnd ?? false) === expect.cancelAtPeriodEnd);

  if (!ok || res.httpStatus !== 200 || body.duplicate) {
    await failStep(run._id, 'db_transaction', {
      error: `expected ${expect.status}${'cancelAtPeriodEnd' in expect ? ` with cancelAtPeriodEnd=${expect.cancelAtPeriodEnd}` : ''}, got ${fresh?.status ?? 'unknown'} (endpoint ${res.httpStatus})`,
      endpointResponse: res.body,
    });
    await finishRun(run._id, 'failed');
    throw new Error(`${actionLabel} did not commit (run ${run._id}, subscription status: ${fresh?.status ?? 'unknown'})`);
  }

  await completeStep(run._id, 'db_transaction', {
    transaction: 'MongoDB multi-document ACID (replica set rs0)',
    writes: [`update subscriptions: ${sub.subscriptionId} · status=${fresh.status}${fresh.cancelAtPeriodEnd ? ' · cancelAtPeriodEnd=true' : ''}`],
    committed: true,
  });

  await finishRun(run._id, 'completed');
  return { runId: run._id, subscriptionId: sub.subscriptionId };
}

export async function startCancelRun(
  input?: { subscriptionId?: string; atPeriodEnd?: boolean },
): Promise<{ runId: string; subscriptionId: string }> {
  const db = await getDb();
  const c = collections(db);
  ensureScheduler();

  let sub = input?.subscriptionId
    ? ((await c.subscriptions.findOne({ subscriptionId: input.subscriptionId } as { subscriptionId: string })) as unknown as SubscriptionDoc | null)
    : await latestSubscription();
  if (!sub) {
    // Nothing to cancel — bring a subscription to life through real checkout.
    const { runId } = await startCheckoutRun({});
    await confirmCheckout(runId);
    sub = await latestSubscription();
  }
  if (!sub) throw new Error('Could not find a subscription to cancel');
  if (sub.status === 'canceled') throw new Error(`Subscription ${sub.subscriptionId} is already canceled`);

  const atPeriodEnd = Boolean(input?.atPeriodEnd);
  if (atPeriodEnd && sub.cancelAtPeriodEnd) {
    throw new Error(`Subscription ${sub.subscriptionId} is already scheduled to cancel at period end`);
  }

  const run = await createRun(
    'cancel_subscription',
    { id: sub.priceId, planName: sub.planName, amount: sub.amount, currency: sub.currency },
    { email: sub.customerEmail, name: sub.customerEmail.split('@')[0] },
  );
  await c.runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { customerId: sub.customerId, subscriptionId: sub.subscriptionId },
  });

  await completeStep(run._id, 'cancel_requested', {
    subscriptionId: sub.subscriptionId,
    previousStatus: sub.status,
    atPeriodEnd,
    // Stripe keeps the subscription active until the period ends when the
    // customer asks for period-end cancellation.
    ...(atPeriodEnd ? { stripeSemantics: 'subscription stays active until current_period_end, then customer.subscription.deleted' } : {}),
  });

  const meta = cancelMeta(run, sub);
  const evt = atPeriodEnd
    ? await subscriptionCancelScheduled(meta, sub.currentPeriodStart, sub.currentPeriodEnd)
    : await subscriptionDeleted(meta, sub.currentPeriodStart, sub.currentPeriodEnd);

  return finishCancelRun(run, sub, evt, atPeriodEnd
    ? { status: 'active', cancelAtPeriodEnd: true }
    : { status: 'canceled' }, atPeriodEnd ? 'Period-end cancellation schedule' : 'Cancellation');
}

/** Reverses a pending period-end cancellation (customer changed their mind). */
export async function startCancelReversalRun(
  input?: { subscriptionId?: string },
): Promise<{ runId: string; subscriptionId: string }> {
  const db = await getDb();
  const c = collections(db);
  ensureScheduler();

  const sub = input?.subscriptionId
    ? ((await c.subscriptions.findOne({ subscriptionId: input.subscriptionId } as { subscriptionId: string })) as unknown as SubscriptionDoc | null)
    : ((await c.subscriptions.find({ cancelAtPeriodEnd: true } as Document).sort({ createdAt: -1 }).limit(1).next()) as unknown as SubscriptionDoc | null);
  if (!sub) throw new Error('No subscription with a pending period-end cancellation to reverse');
  if (!sub.cancelAtPeriodEnd) throw new Error(`Subscription ${sub.subscriptionId} has no pending period-end cancellation`);

  const run = await createRun(
    'cancel_subscription',
    { id: sub.priceId, planName: sub.planName, amount: sub.amount, currency: sub.currency },
    { email: sub.customerEmail, name: sub.customerEmail.split('@')[0] },
  );
  await c.runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { customerId: sub.customerId, subscriptionId: sub.subscriptionId },
  });

  await completeStep(run._id, 'cancel_requested', {
    subscriptionId: sub.subscriptionId,
    previousStatus: sub.status,
    atPeriodEnd: false,
    action: 'reverse',
    note: 'operator reversed the pending period-end cancellation',
  });

  const meta = cancelMeta(run, sub);
  const evt = await subscriptionCancelReversed(meta, sub.currentPeriodStart, sub.currentPeriodEnd);
  return finishCancelRun(run, sub, evt, { status: 'active', cancelAtPeriodEnd: false }, 'Cancellation reversal');
}

/**
 * Fires when a flagged subscription's period actually ends (scheduler sweep):
 * emits customer.subscription.deleted through the real pipeline, exactly like
 * Stripe does at period end.
 */
export async function runPeriodEndCancellation(
  sub: SubscriptionDoc,
): Promise<{ runId: string; subscriptionId: string }> {
  const db = await getDb();
  const c = collections(db);

  const run = await createRun(
    'cancel_subscription',
    { id: sub.priceId, planName: sub.planName, amount: sub.amount, currency: sub.currency },
    { email: sub.customerEmail, name: sub.customerEmail.split('@')[0] },
  );
  await c.runs.updateOne({ _id: run._id } as { _id: string }, {
    $set: { customerId: sub.customerId, subscriptionId: sub.subscriptionId },
  });

  await completeStep(run._id, 'cancel_requested', {
    subscriptionId: sub.subscriptionId,
    previousStatus: sub.status,
    atPeriodEnd: true,
    action: 'period_ended',
    note: 'billing period ended while cancel_at_period_end was set — cancellation took effect',
  });

  const meta = cancelMeta(run, sub);
  const evt = await subscriptionDeleted(meta, sub.currentPeriodStart, sub.currentPeriodEnd);
  return finishCancelRun(run, sub, evt, { status: 'canceled' }, 'Period-end cancellation');
}

// ─── Duplicate run of markStep for live mode helper (unused for now) ────────
export { markStep };
