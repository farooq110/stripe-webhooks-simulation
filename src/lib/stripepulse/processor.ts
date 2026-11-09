// ─── StripePulse · idempotent webhook processor ─────────────────────────────
// The app's real webhook receiver. Guarantees:
//  1. Signature verification (live: Stripe SDK; sim: identical HMAC scheme).
//  2. Idempotency via the unique index on webhook_events.eventId — a
//     redelivered event that was already processed is acknowledged with 200
//     but executes ZERO writes.
//  3. Concurrency safety: processing a claimed event is reserved to exactly
//     one request. Parallel deliveries of the same new event wait for the
//     winner and mirror its outcome instead of racing it (QA finding BUG-1).
//  4. Atomic multi-document writes inside a genuine MongoDB replica-set
//     transaction; any failure aborts and rolls back everything.
//  5. On processing failure the endpoint responds 500 exactly like Stripe
//     expects, and the event is queued for redelivery with exponential
//     backoff (handled by the scheduler).
//  6. Stale events (created well before the subscription's last update) are
//     recorded but cannot drag newer subscription state backwards (BUG-2).

import type { Db, ClientSession, WithTransactionCallback, Document } from 'mongodb';
import { collections, getDb, getFlag } from './mongo';
import { getGateway, type StripeEvent } from './gateway';
import { verifySignature } from './crypto';
import { config, webhookBackoffMs } from './config';
import { completeStep, failStep, logApi, logDb } from './recorder';

export const WEBHOOK_PATH = '/api/webhooks/stripe';

export class InjectedDbFailure extends Error {
  constructor() {
    super('Injected DB write failure (demo flag db_failure enabled)');
    this.name = 'InjectedDbFailure';
  }
}

/** Event types that cause database writes. */
const MUTATING = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

interface OpRecord {
  operation: string;
  collection: string;
  detail: string;
}

export interface ProcessResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

function subPeriods(obj: Record<string, unknown>): { start: string; end: string } {
  const toIso = (v: unknown) =>
    typeof v === 'number' ? new Date(v * 1000).toISOString() : new Date().toISOString();
  return { start: toIso(obj.current_period_start), end: toIso(obj.current_period_end) };
}

// Deliveries can be delayed legitimately (backoff, redelivery, network). But
// an event created noticeably BEFORE the subscription's last update is history
// replayed out of order — applying it would drag newer state backwards.
// 20s comfortably exceeds every legitimate in-app delay (delivery is ≤ a few
// seconds even with scheduler ticks), while QA's stale repro is 3600s old.
const STALE_EVENT_SKEW_MS = 20_000;

// Ops that represent a real database write (used for the writesExecuted
// counter — skips and log-only notes must not be counted, QA INFO-1).
const writeCount = (ops: OpRecord[]) =>
  ops.filter((o) => o.operation !== 'none' && o.operation !== 'skip').length;

// Full history of webhook deliveries recorded on the run's webhook_delivery
// step, so multiple deliveries of a run no longer merge invisibly
// (QA finding INFO-2). Capped at the last 10 entries.
async function deliveryHistory(runId: string): Promise<unknown[]> {
  const step = await collections(await getDb()).steps.findOne(
    { runId, key: 'webhook_delivery' } as Document,
    { projection: { 'detail.deliveries': 1 } },
  );
  const list = (step?.detail as { deliveries?: unknown[] } | undefined)?.deliveries;
  return Array.isArray(list) ? list.slice(-9) : [];
}

function eventCreatedMs(event: StripeEvent): number {
  const created = (event as { created?: number }).created;
  return typeof created === 'number' ? created * 1000 : Date.now();
}

async function isStaleForSubscription(
  db: Db,
  session: ClientSession,
  subscriptionId: string | undefined,
  event: StripeEvent,
): Promise<boolean> {
  if (!subscriptionId) return false;
  const sub = await collections(db).subscriptions.findOne(
    { subscriptionId } as { subscriptionId: string },
    { session, projection: { updatedAt: 1 } },
  );
  if (!sub?.updatedAt) return false;
  return Date.parse(sub.updatedAt) - eventCreatedMs(event) > STALE_EVENT_SKEW_MS;
}

// A delayed invoice.paid is NOT the same as an out-of-order one. If the
// payment it reports is the LATEST attempt for the subscription and the
// subscription still sits in a failing state, the money is real and the
// subscription must recover — even when the delivery arrived late (QA finding
// HIGH-1: dropping it recorded a successful charge while the subscription
// stayed past_due forever).
async function isLatestAttemptRecovery(
  db: Db,
  session: ClientSession,
  subscriptionId: string | undefined,
  invoiceId: string,
  attempt: number,
): Promise<boolean> {
  if (!subscriptionId) return false;
  const c = collections(db);
  const sub = await c.subscriptions.findOne(
    { subscriptionId } as { subscriptionId: string },
    { session, projection: { status: 1 } },
  );
  // Only a subscription that still needs money may be recovered this way.
  if (!sub || (sub.status !== 'past_due' && sub.status !== 'unpaid')) return false;
  const latest = await c.attempts.findOne(
    { subscriptionId } as { subscriptionId: string },
    { session, sort: { attempt: -1, createdAt: -1 }, projection: { attempt: 1, invoiceId: 1 } },
  );
  // No local attempt history — trust the payment event itself.
  if (!latest) return true;
  return attempt >= latest.attempt && invoiceId === latest.invoiceId;
}

async function handleEvent(
  db: Db,
  session: ClientSession,
  event: StripeEvent,
  runId: string,
  ops: OpRecord[],
): Promise<void> {
  const c = collections(db);
  const obj = event.data.object as Record<string, unknown>;
  const md = (obj.metadata ?? {}) as Record<string, string>;

  switch (event.type) {
    case 'checkout.session.completed': {
      const customerId = (obj.customer as string) ?? md.customer_id;
      const email = (obj.customer_email as string) ?? md.customer_email ?? 'unknown@example.com';
      const name = md.customer_name ?? email.split('@')[0];
      const now = new Date().toISOString();
      await c.customers.updateOne(
        { customerId } as { customerId: string },
        { $set: { email, name, runId }, $setOnInsert: { createdAt: now } },
        { upsert: true, session },
      );
      ops.push({ operation: 'upsert', collection: 'customers', detail: `${customerId} · ${email}` });

      const subscriptionId = obj.subscription as string | undefined;
      if (subscriptionId) {
        const periods = {
          start: now,
          end: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        };
        await c.subscriptions.updateOne(
          { subscriptionId } as { subscriptionId: string },
          {
            $set: {
              runId,
              customerId,
              customerEmail: email,
              priceId: md.price_id ?? 'unknown',
              planName: md.plan_name ?? 'Unknown',
              amount: Number(md.amount ?? 0),
              currency: md.currency ?? 'usd',
              interval: 'month',
              status: 'trialing',
              currentPeriodStart: periods.start,
              currentPeriodEnd: periods.end,
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true, session },
        );
        ops.push({
          operation: 'upsert',
          collection: 'subscriptions',
          detail: `${subscriptionId} · status=trialing · trial ends ${periods.end.slice(0, 10)}`,
        });
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = obj.id as string;
      const deleted = event.type === 'customer.subscription.deleted';
      const status = deleted ? 'canceled' : (obj.status as string) ?? 'active';
      const periods = subPeriods(obj);
      const now = new Date().toISOString();

      // Stale guard: an out-of-order event must not overwrite newer state.
      if (await isStaleForSubscription(db, session, subscriptionId, event)) {
        ops.push({
          operation: 'skip',
          collection: 'subscriptions',
          detail: `${subscriptionId} · stale event ignored (created ${eventCreatedMs(event) > 0 ? new Date(eventCreatedMs(event)).toISOString() : '?'} < last update) · status stays untouched`,
        });
        break;
      }

      const canceledAt = status === 'canceled' ? now : undefined;
      const set: Record<string, unknown> = {
        runId,
        status,
        currentPeriodStart: periods.start,
        currentPeriodEnd: periods.end,
        updatedAt: now,
      };
      if (canceledAt) set.canceledAt = canceledAt;
      if (md.price_id) set.priceId = md.price_id;
      if (md.plan_name) set.planName = md.plan_name;
      if (md.customer_email) set.customerEmail = md.customer_email;

      // Cancellation lifecycle fields (Stripe semantics): a period-end
      // cancellation keeps the subscription active but flags it; a reversal
      // clears the flag. An immediate cancellation (deleted) clears any
      // pending flag because the subscription is gone.
      if (deleted) {
        set.cancelAtPeriodEnd = false;
      } else if (typeof obj.cancel_at_period_end === 'boolean') {
        set.cancelAtPeriodEnd = obj.cancel_at_period_end;
        if (obj.cancel_at_period_end) {
          const cancelAt = typeof obj.cancel_at === 'number'
            ? new Date(obj.cancel_at * 1000).toISOString()
            : periods.end;
          set.cancelAt = cancelAt;
          set.canceledAt = (typeof obj.canceled_at === 'number'
            ? new Date(obj.canceled_at * 1000).toISOString()
            : now);
        } else {
          // Reversal — the pending cancellation is gone. cancelAt is removed
          // via $unset below (it must not appear in $set too).
          set.canceledAt = null;
        }
      }

      const unset: Record<string, unknown> = {};
      if (deleted) {
        unset.cancelAt = '';
      } else if (typeof obj.cancel_at_period_end === 'boolean' && !obj.cancel_at_period_end) {
        unset.cancelAt = '';
      }

      await c.subscriptions.updateOne(
        { subscriptionId } as { subscriptionId: string },
        { $set: set, $setOnInsert: { createdAt: now, customerId: obj.customer as string }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { upsert: true, session },
      );
      const cancelNote = set.cancelAtPeriodEnd === true
        ? ' · cancellation scheduled for period end'
        : set.cancelAtPeriodEnd === false && event.type === 'customer.subscription.updated' && typeof obj.cancel_at_period_end === 'boolean'
          ? ' · pending cancellation reversed'
          : '';
      ops.push({
        operation: 'update',
        collection: 'subscriptions',
        detail: `${subscriptionId} · status=${status}${cancelNote}`,
      });
      break;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const paid = event.type === 'invoice.paid';
      const invoiceId = obj.id as string;
      const subscriptionId = (obj.subscription as string) ?? md.subscription_id;
      const attempt = Number(md.attempt ?? obj.attempt_count ?? 1);

      // Stale guard FIRST and before any write (QA finding INFO-1): a skipped
      // event must execute zero writes, so the payment-attempt row is only
      // inserted once we know the event will actually be applied.
      //
      // Exception (QA finding HIGH-1): a delayed invoice.paid whose payment
      // is the latest attempt for a subscription that is still past_due or
      // unpaid is a legitimate late recovery, not out-of-order replay —
      // applying it is the only way the recorded state catches up with the
      // money Stripe actually took.
      if (await isStaleForSubscription(db, session, subscriptionId, event)) {
        const delayedRecovery = paid
          && (await isLatestAttemptRecovery(db, session, subscriptionId, invoiceId, attempt));
        if (!delayedRecovery) {
          ops.push({
            operation: 'skip',
            collection: 'subscriptions',
            detail: `${subscriptionId} · stale ${event.type} ignored · status left untouched`,
          });
          break;
        }
        ops.push({
          operation: 'none',
          collection: '—',
          detail: `${subscriptionId} · stale invoice.paid accepted as late recovery (latest attempt #${attempt})`,
        });
      }

      const now = new Date().toISOString();
      await c.attempts.insertOne(
        {
          _id: `${invoiceId}_a${attempt}`,
          runId,
          invoiceId,
          subscriptionId,
          paymentIntentId: (obj.payment_intent as string) ?? md.payment_intent_id ?? 'unknown',
          amount: paid ? Number(obj.amount_paid ?? 0) : Number(obj.amount_due ?? 0),
          currency: (obj.currency as string) ?? 'usd',
          attempt,
          status: paid ? 'succeeded' : 'failed',
          ...(paid
            ? {}
            : {
                failureCode:
                  ((obj.last_payment_error as { code?: string } | undefined)?.code) ?? 'card_declined',
                failureMessage:
                  ((obj.last_payment_error as { message?: string } | undefined)?.message) ??
                  'Your card was declined.',
              }),
          createdAt: now,
        },
        { session },
      );
      ops.push({
        operation: 'insert',
        collection: 'payment_attempts',
        detail: `${invoiceId} · attempt #${attempt} · ${paid ? 'succeeded' : 'failed'}`,
      });

      const periodEnd = typeof obj.period_end === 'number'
        ? new Date(obj.period_end * 1000).toISOString()
        : new Date(Date.now() + 30 * 86_400_000).toISOString();

      const nextStatus = paid ? 'active' : 'past_due';
      await c.subscriptions.updateOne(
        { subscriptionId } as { subscriptionId: string },
        {
          $set: {
            status: nextStatus,
            currentPeriodEnd: periodEnd,
            currentPeriodStart: now,
            updatedAt: now,
          },
        },
        { session },
      );
      ops.push({
        operation: 'update',
        collection: 'subscriptions',
        detail: `${subscriptionId} · status=${nextStatus}`,
      });
      break;
    }

    default:
      // Log-only event types (payment_intent.*, invoice.created, ...)
      ops.push({
        operation: 'none',
        collection: '—',
        detail: `log-only event ${event.type} · no writes required`,
      });
      break;
  }
}

// ── Duplicate acknowledgement ────────────────────────────────────────────────
// Shared by the direct-duplicate path and the sibling-mirror path: answer 200,
// record the blocked delivery, execute zero writes.
async function acknowledgeDuplicate(
  db: Db,
  event: StripeEvent,
  runId: string | undefined,
  t0: number,
  via?: 'sibling-wait',
): Promise<ProcessResult> {
  const c = collections(db);
  const now = new Date().toISOString();
  await c.events.updateOne(
    { eventId: event.id } as { eventId: string },
    {
      $push: { deliveries: { at: now, httpStatus: 200, duplicate: true } },
    },
  );
  // Mark the row duplicate only if it was never fully processed — a mirrored
  // sibling must not downgrade a 'processed' row (the event DID run once).
  await c.events.updateOne(
    { eventId: event.id, status: { $ne: 'processed' } } as Document,
    { $set: { status: 'duplicate' } },
  );
  await logDb({
    runId,
    operation: 'findUnique',
    collection: 'webhook_events',
    detail: `idempotency guard: ${event.id} already processed — blocked redelivery, 0 writes`,
    result: 'read-only',
    transaction: false,
  });
  await logApi({
    runId,
    direction: 'inbound',
    component: 'app webhook endpoint',
    method: 'POST',
    path: WEBHOOK_PATH,
    statusCode: 200,
    durationMs: Date.now() - t0,
    request: {
      eventId: event.id,
      type: event.type,
      redelivery: true,
      ...(via ? { via } : {}),
    },
    response: { received: true, duplicate: true, writesExecuted: 0 },
  });
  if (runId) {
    await completeStep(runId, 'dedup_check', {
      result: 'duplicate blocked',
      eventId: event.id,
      guard: 'unique index webhook_events.eventId',
    });
  }
  return {
    httpStatus: 200,
    body: {
      received: true,
      duplicate: true,
      signatureVerified: true,
      eventId: event.id,
      writesExecuted: 0,
    },
  };
}

// A concurrent delivery of an event another worker is processing right now.
// Wait for that worker's outcome and mirror it: 200 duplicate when it commits,
// 500 when it fails (so a real Stripe would redeliver), 200 concurrent if it
// takes too long — the scheduler still owns the event either way.
const SIBLING_WAIT_MS = 12_000;

async function waitForSiblingOutcome(
  db: Db,
  event: StripeEvent,
  runId: string | undefined,
  t0: number,
): Promise<ProcessResult> {
  const c = collections(db);
  const deadline = Date.now() + SIBLING_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const doc = await c.events.findOne(
      { eventId: event.id } as { eventId: string },
      { projection: { status: 1, lastError: 1, nextRetryAt: 1 } },
    );
    if (!doc) continue;
    if (doc.status === 'processed' || doc.status === 'duplicate') {
      return acknowledgeDuplicate(db, event, runId, t0, 'sibling-wait');
    }
    if (doc.status === 'failed') {
      await c.events.updateOne(
        { eventId: event.id } as { eventId: string },
        { $push: { deliveries: { at: new Date().toISOString(), httpStatus: 500, duplicate: false, mirrored: true } } },
      );
      await logApi({
        runId,
        direction: 'inbound',
        component: 'app webhook endpoint',
        method: 'POST',
        path: WEBHOOK_PATH,
        statusCode: 500,
        durationMs: Date.now() - t0,
        request: { eventId: event.id, type: event.type, mirrored: true },
        response: { error: doc.lastError ?? 'processing failed in another worker', mirrored: true },
      });
      return {
        httpStatus: 500,
        body: {
          error: doc.lastError ?? 'Processing failed in another worker',
          eventId: event.id,
          nextRetryAt: doc.nextRetryAt,
          mirrored: true,
        },
      };
    }
  }

  await logApi({
    runId,
    direction: 'inbound',
    component: 'app webhook endpoint',
    method: 'POST',
    path: WEBHOOK_PATH,
    statusCode: 200,
    durationMs: Date.now() - t0,
    request: { eventId: event.id, type: event.type, concurrent: true },
    response: { received: true, concurrent: true, writesExecuted: 0 },
  });
  return {
    httpStatus: 200,
    body: {
      received: true,
      concurrent: true,
      eventId: event.id,
      writesExecuted: 0,
      note: 'another worker holds the claim; scheduler owns the outcome',
    },
  };
}

export async function processWebhook(
  raw: string,
  signature: string | null,
): Promise<ProcessResult> {
  const t0 = Date.now();
  const db = await getDb();
  const c = collections(db);
  const gateway = getGateway();

  // ── 1 · Signature verification ────────────────────────────────────────────
  // The two gateway modes can never accept each other's signatures:
  //   · live → verified by the official Stripe SDK against STRIPE_WEBHOOK_SECRET
  //     (the whsec_... of the real Stripe endpoint), raw body untouched;
  //   · simulated → verified by the identical HMAC scheme against the separate
  //     STRIPE_SIM_WEBHOOK_SECRET, which is generated per process and never
  //     equals the live secret. A sim-signed payload in live mode (or a live
  //     signed payload in sim mode) fails HMAC comparison → 400.
  let verified = false;
  let verifyReason = '';
  let scheme: 'stripe-sdk' | 'sim-hmac' | null = null;
  let event: StripeEvent | null = null;
  try {
    if (gateway.mode === 'live') {
      event = await gateway.constructWebhookEvent(raw, signature ?? '');
      verified = true;
      scheme = 'stripe-sdk';
    } else {
      const v = verifySignature(raw, signature, undefined, config.signatureToleranceSeconds);
      verifyReason = v.reason ?? '';
      if (v.ok) {
        event = await gateway.constructWebhookEvent(raw, signature ?? '');
        verified = true;
        scheme = 'sim-hmac';
      }
    }
  } catch (e) {
    verifyReason = e instanceof Error ? e.message : String(e);
  }

  if (!verified || !event) {
    await logApi({
      direction: 'inbound',
      component: 'app webhook endpoint',
      method: 'POST',
      path: WEBHOOK_PATH,
      statusCode: 400,
      durationMs: Date.now() - t0,
      request: { signaturePresent: Boolean(signature) },
      response: { error: verifyReason || 'signature verification failed' },
    });
    return { httpStatus: 400, body: { error: verifyReason || 'Webhook signature verification failed' } };
  }
  const correlationId = event.id;
  const runId = ((event.data.object as Record<string, unknown>).metadata as Record<string, string>)
    ?.run_id ?? undefined;

  // ── 2 · Atomic claim (idempotency + concurrency safety, QA BUG-1) ────────
  // Exactly one request may process a given event:
  //   · a NEW event is claimed by inserting its row — the unique index turns
  //     any race into exactly one winner plus E11000 losers;
  //   · a REDELIVERY is claimed by flipping a finished/stale row back to
  //     'processing' with findOneAndUpdate — atomic, so two concurrent
  //     redeliveries cannot both win;
  //   · a delivery arriving while another worker still holds a live claim
  //     waits for that worker's outcome and mirrors it. It never processes in
  //     parallel, so the event can no longer be corrupted by the race.
  const now = new Date().toISOString();
  const claimExpiresAt = new Date(Date.now() + config.claimTtlMs).toISOString();
  let attempts = 1;
  let isRetry = false;

  try {
    await c.events.insertOne({
      _id: event.id,
      eventId: event.id,
      runId,
      type: event.type,
      payloadRaw: raw,
      status: 'processing',
      attempts: 1,
      signatureVerified: true,
      signatureScheme: scheme ?? undefined,
      deliveries: [],
      claimExpiresAt,
      createdAt: now,
    });
    // We hold the fresh claim — fall through and process.
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 11000) throw e;

    // Event already known — duplicate, legitimate retry, or concurrent sibling.
    const existing = await c.events.findOne({ eventId: event.id } as { eventId: string });
    if (!existing) {
      // Extremely rare: duplicate key but doc vanished. Retry insert once.
      return processWebhook(raw, signature);
    }

    if (existing.status === 'processed' || existing.status === 'duplicate') {
      // ── DUPLICATE: acknowledge, execute zero writes ──────────────────────
      return acknowledgeDuplicate(db, event, runId, t0);
    }

    if (existing.status === 'processing' && (existing.claimExpiresAt ?? '') > now) {
      // A live claim is held elsewhere — wait and mirror, never race.
      return waitForSiblingOutcome(db, event, runId, t0);
    }

    // Reclaimable: 'failed' (legitimate retry), legacy 'received' rows, or a
    // claim that expired because a worker died mid-processing.
    const reclaimed = await c.events.findOneAndUpdate(
      {
        eventId: event.id,
        $or: [
          { status: 'failed' },
          { status: 'received' },
          { status: 'processing', claimExpiresAt: { $lte: now } },
        ],
      } as Document,
      {
        $set: { status: 'processing', claimExpiresAt },
        $unset: { lastError: '', nextRetryAt: '' },
        $inc: { attempts: 1 },
      } as Document,
      { returnDocument: 'after' },
    );
    if (!reclaimed) {
      // Lost the reclaim race — a sibling claimed it between read and update.
      return waitForSiblingOutcome(db, event, runId, t0);
    }
    isRetry = true;
    attempts = (reclaimed.attempts as number) ?? attempts + 1;
  }

  // ── 3 · Atomic processing (real MongoDB transaction) ─────────────────────
  const mutating = MUTATING.has(event.type);
  const ops: OpRecord[] = [];
  const injectionEnabled = mutating ? await getFlag('db_failure') : false;

  if (mutating && injectionEnabled) {
    // Fail BEFORE any write — mirrors a DB outage. Transaction not even opened.
    const backoffMs = webhookBackoffMs(attempts);
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    // Dead-letter: once the redelivery budget is spent the event stops being
    // retried automatically and waits for a manual requeue (Area 3).
    const dead = attempts >= config.maxWebhookRedeliveries;
    await c.events.updateOne(
      { eventId: event.id } as { eventId: string },
      {
        $set: {
          status: dead ? 'dead' : 'failed',
          lastError: 'InjectedDbFailure: demo DB failure flag is enabled',
          nextRetryAt: dead ? undefined : nextRetryAt,
          ...(dead ? { deadAt: now } : {}),
        },
        $push: { deliveries: { at: now, httpStatus: 500, duplicate: false } },
      } as Document,
    );
    await logDb({
      runId,
      correlationId,
      operation: mutating ? 'transaction' : 'none',
      collection: 'multiple',
      detail: `INJECTED FAILURE before write · ${event.type} · tx aborted, nothing persisted`,
      result: 'failed',
      transaction: true,
    });
    await logApi({
      runId,
      correlationId,
      direction: 'inbound',
      component: 'app webhook endpoint',
      method: 'POST',
      path: WEBHOOK_PATH,
      statusCode: 500,
      durationMs: Date.now() - t0,
      request: { eventId: event.id, type: event.type, attempt: attempts },
      response: {
        error: 'Database write failed',
        nextRetryAt: dead ? undefined : nextRetryAt,
        retryStrategy: 'exponential backoff',
        ...(dead ? { deadLetter: true, note: 'redelivery budget exhausted — requeue manually' } : {}),
      },
    });
    if (runId) {
      await failStep(runId, 'webhook_delivery', {
        eventId: event.id,
        statusCode: 500,
        attempt: attempts,
        error: 'DB write failed — Stripe will redeliver',
        deliveries: [...(await deliveryHistory(runId)), { eventId: event.id, statusCode: 500, attempt: attempts, at: now }],
      });
      await failStep(runId, 'db_transaction', {
        error: 'INJECTED FAILURE · transaction aborted · nothing persisted',
        attempt: attempts,
        nextRetryAt,
      });
    }
    return {
      httpStatus: 500,
      body: {
        error: 'Database write failed',
        eventId: event.id,
        nextRetryAt: dead ? undefined : nextRetryAt,
        attempts,
        ...(dead ? { deadLetter: true } : {}),
      },
    };
  }

  let handlerError: Error | null = null;
  if (mutating) {
    const txn: WithTransactionCallback<void> = async (session) => {
      await handleEvent(db, session, event as StripeEvent, runId ?? 'unattributed', ops);
    };
    const session = db.client.startSession();
    try {
      await session.withTransaction(txn);
    } catch (e) {
      handlerError = e instanceof Error ? e : new Error(String(e));
    } finally {
      await session.endSession();
    }
  } else {
    ops.push({
      operation: 'none',
      collection: '—',
      detail: `log-only event ${event.type} · no writes required`,
    });
  }

  const httpStatus = handlerError ? 500 : 200;
  const durationMs = Date.now() - t0;

  // ── 4 · Persist outcome ───────────────────────────────────────────────────
  if (handlerError) {
    const backoffMs = webhookBackoffMs(attempts);
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    // Dead-letter after the redelivery budget is spent — the event keeps its
    // payload and delivery history for manual investigation + requeue.
    const dead = attempts >= config.maxWebhookRedeliveries;
    await c.events.updateOne(
      { eventId: event.id } as { eventId: string },
      {
        $set: {
          status: dead ? 'dead' : 'failed',
          lastError: handlerError.message,
          nextRetryAt: dead ? undefined : nextRetryAt,
          ...(dead ? { deadAt: now } : {}),
        },
        $push: { deliveries: { at: now, httpStatus, duplicate: false } },
      } as Document,
    );
    for (const op of ops) {
      await logDb({ runId, correlationId, operation: op.operation, collection: op.collection, detail: op.detail, result: 'failed', transaction: true });
    }
    await logApi({
      runId,
      correlationId,
      direction: 'inbound',
      component: 'app webhook endpoint',
      method: 'POST',
      path: WEBHOOK_PATH,
      statusCode: 500,
      durationMs,
      request: { eventId: event.id, type: event.type, attempt: attempts },
      response: {
        error: handlerError.message,
        nextRetryAt: dead ? undefined : nextRetryAt,
        ...(dead ? { deadLetter: true, note: 'redelivery budget exhausted — requeue manually' } : {}),
      },
    });
    if (runId) {
      await failStep(runId, 'db_transaction', { error: handlerError.message, attempt: attempts });
      await failStep(runId, 'webhook_delivery', {
        eventId: event.id,
        statusCode: 500,
        attempt: attempts,
        ...(dead ? { note: 'moved to dead-letter — manual requeue required' } : {}),
        deliveries: [...(await deliveryHistory(runId)), { eventId: event.id, statusCode: 500, attempt: attempts, at: now }],
      });
    }
    return {
      httpStatus: 500,
      body: {
        error: handlerError.message,
        eventId: event.id,
        nextRetryAt: dead ? undefined : nextRetryAt,
        ...(dead ? { deadLetter: true } : {}),
      },
    };
  }

  // Success path
  await c.events.updateOne(
    { eventId: event.id } as { eventId: string },
    {
      $set: { status: 'processed', processedAt: now },
      $push: { deliveries: { at: now, httpStatus: 200, duplicate: false } },
    },
  );
  for (const op of ops) {
    await logDb({
      runId,
      correlationId,
      operation: op.operation,
      collection: op.collection,
      detail: op.detail,
      result: op.operation === 'none' ? 'read-only' : 'ok',
      transaction: true,
    });
  }
  await logApi({
    runId,
    correlationId,
    direction: 'inbound',
    component: 'app webhook endpoint',
    method: 'POST',
    path: WEBHOOK_PATH,
    statusCode: 200,
    durationMs,
    request: { eventId: event.id, type: event.type, redelivery: isRetry || undefined, attempt: attempts },
    response: { received: true, duplicate: false, writesExecuted: writeCount(ops) },
  });

  if (runId) {
    await completeStep(runId, 'webhook_delivery', {
      eventId: event.id,
      type: event.type,
      statusCode: 200,
      attempt: attempts,
      ...(isRetry ? { note: 'accepted on redelivery' } : {}),
      deliveries: [...(await deliveryHistory(runId)), { eventId: event.id, statusCode: 200, attempt: attempts, at: now }],
    });
    await completeStep(runId, 'signature_verified', {
      algorithm: 'HMAC-SHA256',
      scheme: 't=<ts>,v1=<hmac(ts.payload)>',
      verified: true,
      eventId: event.id,
    });
    await completeStep(runId, 'dedup_check', {
      result: isRetry ? 'known event · retry accepted' : 'new event',
      eventId: event.id,
      guard: 'unique index webhook_events.eventId',
    });
    if (mutating) {
      await completeStep(runId, 'db_transaction', {
        transaction: 'MongoDB multi-document ACID (replica set rs0)',
        writes: ops.filter((o) => o.operation !== 'none' && o.operation !== 'skip').map((o) => `${o.operation} ${o.collection}: ${o.detail}`),
        committed: true,
        eventId: event.id,
      });
    }
  }

  return {
    httpStatus: 200,
    body: {
      received: true,
      duplicate: false,
      eventId: event.id,
      signatureScheme: scheme,
      writesExecuted: writeCount(ops),
    },
  };
}
