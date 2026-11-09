import type { Document } from 'mongodb';

// ─── StripePulse · retry scheduler ──────────────────────────────────────────
// Three real retry flows, all exercised over genuine HTTP:
//  1. Webhook redelivery — events that received a non-2xx are re-POSTed with
//     exponential backoff (exactly what Stripe's delivery system does).
//  2. Payment retries — scheduled dunning attempts that charge the card again
//     (Stripe Smart Retries analogue). Attempts are counted, the job is only
//     marked done AFTER the work finishes, and exhausting the attempt limit
//     moves the subscription to 'unpaid' (QA finding BUG-4).
//  3. Crash recovery — events whose processing claim expired (a worker died
//     mid-flight) are reclaimed into the redelivery queue (QA BUG-3).

import type { StripeEvent } from './gateway';
import { simId } from './gateway';
import { collections, getDb, getFlag } from './mongo';
import { dispatchWebhook } from './dispatcher';
import { completeStep, failStep, finishRun, logApi, markStep } from './recorder';
import { config } from './config';
import { runReconciliation, type ReconciliationReport } from './reconciler';
import { invoicePaid, invoicePaymentFailed, paymentIntentSucceeded, subscriptionUpdated, type SubMeta } from './events';

const g = globalThis as unknown as { __sp_scheduler?: NodeJS.Timeout };

const TICK_MS = 1500;

const nowIso = () => new Date().toISOString();

export function ensureScheduler(): void {
  if (g.__sp_scheduler) return;
  g.__sp_scheduler = setInterval(() => {
    void tick().catch(() => {});
  }, TICK_MS);
  // Do not hold the event loop open in dev.
  g.__sp_scheduler.unref?.();
}

export async function tick(): Promise<{
  redelivered: number;
  paymentRetries: number;
  reclaimed: number;
  staleJobsReclaimed?: number;
  periodEndCancellations?: number;
  reconciliation?: ReconciliationReport;
}> {
  const db = await getDb();
  const c = collections(db);
  const now = nowIso();
  let redelivered = 0;
  let paymentRetries = 0;
  let reclaimed = 0;

  // ── 0 · Reclaim events stuck in 'processing' (QA BUG-3) ─────────────────
  // A worker that died mid-processing leaves its claim behind. Once the claim
  // TTL passes, put the event back into the redelivery queue instead of
  // leaving it stuck forever.
  const stuck = await c.events.updateMany(
    { status: 'processing', claimExpiresAt: { $lt: now } } as Document,
    {
      $set: {
        status: 'failed',
        lastError: 'reclaimed: processing claim expired (worker died mid-flight)',
        nextRetryAt: now,
      },
    } as Document,
  );
  reclaimed = stuck.modifiedCount;

  // Same sweep for dunning jobs: a worker that claimed a job and died would
  // otherwise leave it in 'running' forever. The claim TTL matches the
  // webhook one — after it passes the job goes back to 'scheduled'.
  const staleClaimCutoff = new Date(Date.now() - config.claimTtlMs).toISOString();
  const staleJobs = await c.retryJobs.updateMany(
    { status: 'running', claimedAt: { $lt: staleClaimCutoff } } as Document,
    {
      $set: { status: 'scheduled', nextRetryAt: now },
      $unset: { claimedAt: '' },
    } as Document,
  );
  const staleJobsReclaimed = staleJobs.modifiedCount;

  // ── 1 · Webhook redeliveries (event.status = failed, backoff elapsed) ────
  const dueEvents = await c.events
    .find({ status: 'failed', nextRetryAt: { $lte: now } } as Document)
    .sort({ createdAt: 1 })
    .limit(5)
    .toArray();

  for (const evtDoc of dueEvents) {
    let event: StripeEvent;
    try {
      event = JSON.parse(evtDoc.payloadRaw) as StripeEvent;
    } catch {
      continue;
    }
    const res = await dispatchWebhook(event, evtDoc.runId ?? undefined);
    redelivered++;
    if (res.httpStatus === 200 && res.body.duplicate === false) {
      // Recovered — finish scenario-specific steps for db_failure runs.
      if (evtDoc.runId) {
        const run = await c.runs.findOne({ _id: evtDoc.runId } as { _id: string });
        if (run?.scenario === 'db_failure_recovery') {
          await completeStep(evtDoc.runId, 'retry_succeeded', {
            eventId: evtDoc.eventId,
            statusCode: 200,
            redelivery: true,
            attempts: (evtDoc.attempts ?? 0) + 1,
          });
          await completeStep(evtDoc.runId, 'db_transaction_ok', {
            committed: true,
            note: 'transaction committed after injection disabled',
          });
          const sub = evtDoc.runId
            ? await c.subscriptions.findOne({ runId: evtDoc.runId } as { runId: string })
            : null;
          await completeStep(evtDoc.runId, 'subscription_updated', {
            subscriptionId: sub?.subscriptionId ?? 'n/a',
            status: sub?.status ?? 'unknown',
          });
          await finishRun(evtDoc.runId, 'completed');
        }
      }
    }
  }

  // ── 2 · Scheduled subscription payment retries (QA BUG-4) ────────────────
  const dueJobs = await c.retryJobs
    .find({ kind: 'payment', status: 'scheduled', nextRetryAt: { $lte: now } } as Document)
    .sort({ createdAt: 1 })
    .limit(3)
    .toArray();

  for (const job of dueJobs) {
    // Claim the job atomically. The old code marked it 'done' BEFORE running
    // it — a crash in between lost the retry silently. Now the job sits in
    // 'running' while in flight and only reaches 'done' after real success;
    // a failed attempt reschedules with backoff until the limit is reached.
    const claimed = await c.retryJobs.findOneAndUpdate(
      { _id: job._id, status: 'scheduled', nextRetryAt: { $lte: now } } as Document,
      {
        $set: { status: 'running', claimedAt: now },
        $inc: { attempts: 1 },
      } as Document,
      { returnDocument: 'after' },
    );
    if (!claimed) continue;
    paymentRetries++;
    await processPaymentRetry(claimed as unknown as RetryJobLike);
  }

  // ── 3 · Period-end cancellation transitions (Stripe semantics) ───────────
  // A subscription flagged cancel_at_period_end stays active until the period
  // actually ends. Stripe then emits customer.subscription.deleted — we do
  // the same here, through the real webhook pipeline (signature, dedup,
  // transaction), so the local state transitions exactly like Stripe's.
  let periodEndCancellations = 0;
  const dueCancels = await c.subscriptions
    .find({
      cancelAtPeriodEnd: true,
      status: { $in: ['active', 'trialing', 'past_due'] },
      currentPeriodEnd: { $lte: now },
    } as Document)
    .limit(5)
    .toArray();
  if (dueCancels.length > 0) {
    // Dynamic import keeps the scheduler ↔ runner cycle lazy.
    const { runPeriodEndCancellation } = await import('./runner');
    for (const sub of dueCancels) {
      try {
        await runPeriodEndCancellation(sub as unknown as Parameters<typeof runPeriodEndCancellation>[0]);
        periodEndCancellations++;
      } catch {
        // The deleted event went through the normal pipeline — on failure it
        // lands in the redelivery queue and the sweep picks it up next tick.
      }
    }
  }

  // ── 4 · Periodic Stripe ↔ MongoDB reconciliation ─────────────────────────
  let reconciliation: ReconciliationReport | undefined;
  if (config.reconcileIntervalMs > 0) {
    const gRecon = globalThis as unknown as { __sp_last_reconcile_at?: number };
    const last = gRecon.__sp_last_reconcile_at ?? 0;
    if (Date.now() - last >= config.reconcileIntervalMs) {
      gRecon.__sp_last_reconcile_at = Date.now();
      try {
        reconciliation = await runReconciliation();
      } catch {
        // Reconciliation must never break the scheduler loop; the next
        // interval retries.
      }
    }
  }

  return { redelivered, paymentRetries, reclaimed, staleJobsReclaimed, periodEndCancellations, reconciliation };
}

interface RetryJobLike {
  _id: string;
  runId: string;
  subscriptionId?: string;
  invoiceId?: string;
  attempts: number;
}

// ── Payment retry (dunning) execution ────────────────────────────────────────

async function processPaymentRetry(job: RetryJobLike): Promise<void> {
  const db = await getDb();
  const c = collections(db);
  const subscriptionId = job.subscriptionId ?? '';
  const sub = await c.subscriptions.findOne({ subscriptionId } as { subscriptionId: string });
  if (!sub) {
    // Nothing to charge — retire the job instead of leaving it running.
    await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
      $set: { status: 'done', finishedAt: nowIso(), note: 'subscription not found' },
    } as Document);
    return;
  }

  const meta: SubMeta = {
    runId: job.runId,
    subscriptionId: sub.subscriptionId,
    customerId: sub.customerId,
    customerEmail: sub.customerEmail,
    planId: sub.priceId,
    planName: sub.planName,
    amount: sub.amount,
    currency: sub.currency,
  };

  const piId = await simId('pi');
  const newInvoiceId = job.invoiceId || (await simId('in'));
  const periodEndIso = new Date(Date.now() + 30 * 86_400_000).toISOString();
  // job.attempts counts RETRY executions (1, 2, 3…). On the invoice, the
  // original declined charge is attempt #1, so retry N is invoice attempt N+1.
  // Using the raw job counter here would collide with the declined row
  // (payment_attempts._id = `${invoiceId}_a${attempt}`) and abort the transaction.
  const invoiceAttempt = job.attempts + 1;

  await markStep(job.runId, 'payment_attempt_2', 'running');

  // Demo switch: while enabled, the simulated card network declines every
  // retry. This gives the retry limit a real failure path to exercise.
  const retryFailure = await getFlag('retry_failure');

  if (retryFailure) {
    const t0 = Date.now();
    await logApi({
      runId: job.runId,
      direction: 'outbound',
      component: 'stripe-api (simulated) → card network',
      method: 'POST',
      path: `/v1/payment_intents/${piId}/confirm`,
      statusCode: 402,
      durationMs: Math.max(Date.now() - t0, 1),
      request: { payment_method: 'pm_card_visa_chargeDeclined', attempt: invoiceAttempt, strategy: 'smart retry' },
      response: {
        error: {
          type: 'card_error',
          code: 'card_declined',
          message: 'Your card was declined.',
          decline_code: 'generic_decline',
        },
      },
    });
    await failStep(job.runId, 'payment_attempt_2', {
      attempt: invoiceAttempt,
      status: 'failed',
      code: 'card_declined',
      httpStatus: 402,
      message: 'Your card was declined.',
      note: `retry ${job.attempts} of max ${config.maxPaymentRetries}`,
      paymentIntentId: piId,
    });

    const evtFailed = await invoicePaymentFailed(meta, {
      invoiceId: newInvoiceId,
      paymentIntentId: piId,
      attempt: invoiceAttempt,
      amount: sub.amount,
      periodEndIso,
      failure: { code: 'card_declined', message: 'Your card was declined.' },
    });
    await dispatchWebhook(evtFailed, job.runId);

    if (job.attempts >= config.maxPaymentRetries) {
      // Dunning gave up — mirror Stripe: the subscription ends up unpaid.
      await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
        $set: { status: 'exhausted', finishedAt: nowIso(), note: `no recovery after ${job.attempts} retries` },
      } as Document);
      const evtUnpaid = await subscriptionUpdated(meta, 'unpaid', sub.currentPeriodEnd);
      await dispatchWebhook(evtUnpaid, job.runId);
      await failStep(job.runId, 'subscription_recovered', {
        subscriptionId: sub.subscriptionId,
        result: 'retries exhausted',
        attempts: job.attempts,
        finalStatus: 'unpaid',
      });
      await finishRun(job.runId, 'failed');
      return;
    }

    // Still attempts left — reschedule with the same backoff ladder.
    const nextRetryAt = new Date(Date.now() + config.paymentRetryBackoffMs * 2 ** (job.attempts - 1)).toISOString();
    await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
      $set: { status: 'scheduled', nextRetryAt, lastError: `retry ${job.attempts} declined` },
    } as Document);
    await finishRun(job.runId, 'failed');
    return;
  }

  // The charge itself (simulated card network call) — real log with real result.
  const t0 = Date.now();
  await logApi({
    runId: job.runId,
    direction: 'outbound',
    component: 'stripe-api (simulated) → card network',
    method: 'POST',
    path: `/v1/payment_intents/${piId}/confirm`,
    statusCode: 200,
    durationMs: Math.max(Date.now() - t0, 1),
    request: { payment_method: 'pm_card_visa', attempt: invoiceAttempt, strategy: 'smart retry' },
    response: { status: 'succeeded', amount: sub.amount, currency: sub.currency },
  });

  // Events Stripe would emit after a successful retry.
  const evtInvoicePaid = await invoicePaid(meta, {
    invoiceId: newInvoiceId,
    paymentIntentId: piId,
    attempt: invoiceAttempt,
    amount: sub.amount,
    periodEndIso,
  });
  const evtPiSucceeded = await paymentIntentSucceeded(meta, piId, sub.amount);
  const evtSubActive = await subscriptionUpdated(meta, 'active', periodEndIso);

  const r1 = await dispatchWebhook(evtInvoicePaid, job.runId);
  const r2 = await dispatchWebhook(evtPiSucceeded, job.runId);
  const r3 = await dispatchWebhook(evtSubActive, job.runId);

  // The charge itself went through (logged above), so this step stays honest
  // regardless of what the webhook delivery did next.
  await completeStep(job.runId, 'payment_attempt_2', {
    attempt: invoiceAttempt,
    status: 'succeeded',
    paymentIntentId: piId,
    strategy: `smart retry (simulated) · retry ${job.attempts}`,
  });

  // MEDIUM-1: success is what the WEBHOOK committed, not what we dispatched.
  // A non-200 (e.g. injected DB failure) means nothing was written — the old
  // code completed every step and marked the job done anyway, reporting a
  // recovery that never happened.
  const delivered = r1.httpStatus === 200 && r1.body.duplicate === false;
  const fresh = await c.subscriptions.findOne({ subscriptionId } as { subscriptionId: string });
  const recovered = fresh?.status === 'active';

  if (!delivered || !recovered) {
    await failStep(job.runId, 'webhook_invoice_paid', {
      eventId: r1.eventId,
      statusCode: r1.httpStatus,
      duplicate: r1.body.duplicate === true,
      error: 'recovery webhook was not processed — nothing committed',
    });
    await failStep(job.runId, 'db_transaction_2', {
      transaction: 'MongoDB multi-document ACID (replica set rs0)',
      committed: false,
      error: `subscription status is ${fresh?.status ?? 'unknown'}, not active`,
    });
    await failStep(job.runId, 'subscription_recovered', {
      subscriptionId: sub.subscriptionId,
      currentStatus: fresh?.status ?? 'unknown',
      result: 'recovery not applied',
    });

    if (job.attempts >= config.maxPaymentRetries) {
      // Give up honestly. The charge log said succeeded but the app could not
      // record it — do NOT fabricate an 'unpaid' transition here. The failed
      // invoice.paid event stays in the redelivery queue and can still
      // recover the subscription once deliveries work again.
      await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
        $set: {
          status: 'exhausted',
          finishedAt: nowIso(),
          lastError: 'recovery webhook undelivered',
          note: `recovery not committed after ${job.attempts} attempts — redelivery queue still owns the event`,
        },
      } as Document);
      await finishRun(job.runId, 'failed');
      return;
    }

    // Still attempts left — reschedule instead of marking done (HIGH-1).
    const nextRetryAt = new Date(Date.now() + config.paymentRetryBackoffMs * 2 ** (job.attempts - 1)).toISOString();
    await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
      $set: { status: 'scheduled', nextRetryAt, lastError: `recovery webhook answered ${r1.httpStatus}` },
    } as Document);
    await finishRun(job.runId, 'failed');
    return;
  }

  await completeStep(job.runId, 'webhook_invoice_paid', {
    eventId: r1.eventId,
    type: 'invoice.paid',
    statusCode: r1.httpStatus,
  });
  await completeStep(job.runId, 'db_transaction_2', {
    transaction: 'MongoDB multi-document ACID (replica set rs0)',
    writes: [
      `insert payment_attempts: ${newInvoiceId} · attempt #${invoiceAttempt} · succeeded`,
      `update subscriptions: ${sub.subscriptionId} · status=${fresh?.status ?? 'active'}`,
    ],
    committed: true,
  });

  // Auxiliary events do not gate the recovery, but a failed delivery among
  // them must stay visible instead of being overwritten by success.
  const auxFailed = [r2, r3].filter((r) => r.httpStatus !== 200);
  await completeStep(job.runId, 'subscription_recovered', {
    subscriptionId: sub.subscriptionId,
    from: 'past_due',
    to: fresh?.status ?? 'active',
    ...(auxFailed.length > 0
      ? { note: `${auxFailed.length} auxiliary webhook(s) failed — left with the redelivery queue` }
      : {}),
  });

  // Only NOW is the job allowed to finish — after the recovery really committed.
  await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
    $set: { status: 'done', finishedAt: nowIso() },
  } as Document);

  await finishRun(job.runId, 'completed');
}
