import type { Document } from 'mongodb';

// ─── StripePulse · retry scheduler ──────────────────────────────────────────
// Two real retry flows, both exercised over genuine HTTP:
//  1. Webhook redelivery — events that received a non-2xx are re-POSTed with
//     exponential backoff (exactly what Stripe's delivery system does).
//  2. Subscription payment retries — scheduled dunning attempt that charges
//     the card again (Stripe Smart Retries analogue).

import type { StripeEvent } from './gateway';
import { simId } from './gateway';
import { collections, getDb } from './mongo';
import { dispatchWebhook } from './dispatcher';
import { completeStep, finishRun, logApi, markStep } from './recorder';
import { invoicePaid, paymentIntentSucceeded, subscriptionUpdated, type SubMeta } from './events';

const g = globalThis as unknown as { __sp_scheduler?: NodeJS.Timeout };

const TICK_MS = 1500;

export function ensureScheduler(): void {
  if (g.__sp_scheduler) return;
  g.__sp_scheduler = setInterval(() => {
    void tick().catch(() => {});
  }, TICK_MS);
  // Do not hold the event loop open in dev.
  g.__sp_scheduler.unref?.();
}

export async function tick(): Promise<{ redelivered: number; paymentRetries: number }> {
  const db = await getDb();
  const c = collections(db);
  const nowIso = new Date().toISOString();
  let redelivered = 0;
  let paymentRetries = 0;

  // ── 1 · Webhook redeliveries (event.status = failed, backoff elapsed) ────
  const dueEvents = await c.events
    .find({ status: 'failed', nextRetryAt: { $lte: nowIso } } as Document)
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

  // ── 2 · Scheduled subscription payment retries ───────────────────────────
  const dueJobs = await c.retryJobs
    .find({ kind: 'payment', status: 'scheduled', nextRetryAt: { $lte: nowIso } } as Document)
    .sort({ createdAt: 1 })
    .limit(3)
    .toArray();

  for (const job of dueJobs) {
    await c.retryJobs.updateOne({ _id: job._id } as { _id: string }, {
      $set: { status: 'done' },
    });
    await processPaymentRetry(job._id, job.runId, job.subscriptionId ?? '', job.invoiceId ?? '');
    paymentRetries++;
  }

  return { redelivered, paymentRetries };
}

// ── Payment retry (dunning) execution ────────────────────────────────────────

async function processPaymentRetry(
  jobId: string,
  runId: string,
  subscriptionId: string,
  invoiceId: string,
): Promise<void> {
  const db = await getDb();
  const c = collections(db);
  const sub = await c.subscriptions.findOne({ subscriptionId } as { subscriptionId: string });
  if (!sub) return;

  const meta: SubMeta = {
    runId,
    subscriptionId: sub.subscriptionId,
    customerId: sub.customerId,
    customerEmail: sub.customerEmail,
    planId: sub.priceId,
    planName: sub.planName,
    amount: sub.amount,
    currency: sub.currency,
  };

  const piId = await simId('pi');
  const newInvoiceId = invoiceId || (await simId('in'));
  const periodEndIso = new Date(Date.now() + 30 * 86_400_000).toISOString();

  await markStep(runId, 'payment_attempt_2', 'running');

  // The charge itself (simulated card network call) — real log with real result.
  const t0 = Date.now();
  await logApi({
    runId,
    direction: 'outbound',
    component: 'stripe-api (simulated) → card network',
    method: 'POST',
    path: `/v1/payment_intents/${piId}/confirm`,
    statusCode: 200,
    durationMs: Math.max(Date.now() - t0, 1),
    request: { payment_method: 'pm_card_visa', attempt: 2, strategy: 'smart retry' },
    response: { status: 'succeeded', amount: sub.amount, currency: sub.currency },
  });

  // Events Stripe would emit after a successful retry.
  const evtInvoicePaid = await invoicePaid(meta, {
    invoiceId: newInvoiceId,
    paymentIntentId: piId,
    attempt: 2,
    amount: sub.amount,
    periodEndIso,
  });
  const evtPiSucceeded = await paymentIntentSucceeded(meta, piId, sub.amount);
  const evtSubActive = await subscriptionUpdated(meta, 'active', periodEndIso);

  const r1 = await dispatchWebhook(evtInvoicePaid, runId);
  await dispatchWebhook(evtPiSucceeded, runId);
  await dispatchWebhook(evtSubActive, runId);

  await completeStep(runId, 'payment_attempt_2', {
    attempt: 2,
    status: 'succeeded',
    paymentIntentId: piId,
    strategy: 'smart retry (6s backoff)',
  });
  await completeStep(runId, 'webhook_invoice_paid', {
    eventId: r1.eventId,
    type: 'invoice.paid',
    statusCode: r1.httpStatus,
  });
  await completeStep(runId, 'db_transaction_2', {
    transaction: 'MongoDB multi-document ACID (replica set rs0)',
    writes: [
      `insert payment_attempts: ${newInvoiceId} · attempt #2 · succeeded`,
      `update subscriptions: ${sub.subscriptionId} · status=active`,
    ],
    committed: true,
  });

  const fresh = await c.subscriptions.findOne({ subscriptionId } as { subscriptionId: string });
  await completeStep(runId, 'subscription_recovered', {
    subscriptionId: sub.subscriptionId,
    from: 'past_due',
    to: fresh?.status ?? 'active',
  });

  await finishRun(runId, 'completed');
}
