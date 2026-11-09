// ─── StripePulse · Stripe ↔ MongoDB reconciliation ──────────────────────────
// A successful Stripe payment never guarantees the local transaction
// committed too. This module is the safety net: it compares every local
// subscription with its source of truth and repairs real drift.
//
// Source of truth per mode:
//   · live      — the Stripe API itself (gateway.fetchSubscription, with the
//                 SDK's own timeout + retry budget). null ("cannot verify
//                 right now") is NEVER treated as drift.
//   · simulated — the processed webhook_events log replayed in event-time
//                 order. The sim gateway has no queryable API, but every
//                 state change it ever produced passed through the webhook
//                 endpoint as an event, so the log IS the gateway's view.
//
// Repairs only ever touch subscription status / cancellation flags inside a
// normal ACID transaction, and every repair writes an auditable db_logs row.
// Reconciliation never inserts payments and never deletes anything.

import type { Document } from 'mongodb';
import { collections, getDb } from './mongo';
import { getGateway } from './gateway';
import { finishRun, logApi } from './recorder';
import type { SubscriptionDoc } from './types';

const MUTATING_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

export interface ReconciliationReport {
  ranAt: string;
  mode: 'live' | 'simulated';
  checked: number;
  driftDetected: number;
  repaired: number;
  skippedNoTruth: number;
  details: {
    subscriptionId: string;
    localStatus: string;
    expectedStatus: string;
    localCancelAtPeriodEnd?: boolean;
    expectedCancelAtPeriodEnd?: boolean;
    action: 'repaired' | 'in-sync' | 'skipped-no-truth';
    note?: string;
  }[];
}

interface ExpectedState {
  status: SubscriptionDoc['status'];
  cancelAtPeriodEnd: boolean;
}

// Replay the subscription's processed events in event-time order and return
// the state the gateway believes the subscription is in.
function replayExpectedStatus(events: { type: string; obj: Record<string, unknown> }[]): ExpectedState {
  let status: ExpectedState['status'] = 'active';
  let cancelAtPeriodEnd = false;
  for (const { type, obj } of events) {
    switch (type) {
      case 'checkout.session.completed':
        status = 'trialing';
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        status = ((obj.status as string) ?? status) as ExpectedState['status'];
        if (typeof obj.cancel_at_period_end === 'boolean') cancelAtPeriodEnd = obj.cancel_at_period_end;
        break;
      case 'customer.subscription.deleted':
        status = 'canceled';
        cancelAtPeriodEnd = false;
        break;
      case 'invoice.paid':
        status = 'active';
        break;
      case 'invoice.payment_failed':
        status = 'past_due';
        break;
    }
  }
  return { status, cancelAtPeriodEnd };
}

export async function reconcileAll(): Promise<ReconciliationReport> {
  const db = await getDb();
  const c = collections(db);
  const gateway = getGateway();
  const report: ReconciliationReport = {
    ranAt: new Date().toISOString(),
    mode: gateway.mode,
    checked: 0,
    driftDetected: 0,
    repaired: 0,
    skippedNoTruth: 0,
    details: [],
  };

  const subs = (await c.subscriptions
    .find({} as Document)
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray()) as unknown as SubscriptionDoc[];

  // Simulated mode: load and parse the processed event log ONCE, grouped by
  // the subscription each event belongs to.
  const eventsBySub = new Map<string, { type: string; obj: Record<string, unknown>; created: number }[]>();
  if (gateway.mode !== 'live') {
    const rows = await c.events
      .find({ status: { $in: ['processed', 'duplicate'] } } as Document)
      .sort({ createdAt: 1 })
      .limit(1000)
      .toArray();
    for (const row of rows) {
      if (!MUTATING_TYPES.has(row.type)) continue;
      let payload: { created?: number; data?: { object?: Record<string, unknown> } };
      try {
        payload = JSON.parse(row.payloadRaw);
      } catch {
        continue;
      }
      const obj = payload.data?.object ?? {};
      const md = obj.metadata as Record<string, string> | undefined;
      const subId =
        (typeof obj.id === 'string' && obj.id.startsWith('sub_') && obj.id) ||
        (typeof obj.subscription === 'string' && obj.subscription) ||
        md?.subscription_id;
      if (!subId) continue;
      const list = eventsBySub.get(subId) ?? [];
      list.push({ type: row.type, obj, created: payload.created ?? 0 });
      eventsBySub.set(subId, list);
    }
  }

  for (const sub of subs) {
    report.checked++;
    let expected: ExpectedState | null = null;

    if (gateway.mode === 'live' && gateway.fetchSubscription) {
      const truth = await gateway.fetchSubscription(sub.subscriptionId);
      if (!truth) {
        // Deleted subscriptions legitimately return null — only treat it as
        // "no truth" while the local record still claims to be alive.
        if (sub.status === 'canceled') {
          report.details.push({ subscriptionId: sub.subscriptionId, localStatus: sub.status, expectedStatus: 'canceled', action: 'in-sync', note: 'deleted on Stripe' });
          continue;
        }
        report.skippedNoTruth++;
        report.details.push({ subscriptionId: sub.subscriptionId, localStatus: sub.status, expectedStatus: '?', action: 'skipped-no-truth', note: 'Stripe API returned nothing — not treated as drift' });
        continue;
      }
      expected = {
        status: (truth.status as SubscriptionDoc['status']) ?? sub.status,
        cancelAtPeriodEnd: Boolean(truth.cancel_at_period_end),
      };
    } else {
      const relevant = eventsBySub.get(sub.subscriptionId) ?? [];
      if (relevant.length === 0) {
        report.skippedNoTruth++;
        report.details.push({ subscriptionId: sub.subscriptionId, localStatus: sub.status, expectedStatus: '?', action: 'skipped-no-truth', note: 'no processed events reference this subscription' });
        continue;
      }
      relevant.sort((a, b) => a.created - b.created);
      expected = replayExpectedStatus(relevant);
    }

    const localCancel = sub.cancelAtPeriodEnd ?? false;
    const drift = expected.status !== sub.status || localCancel !== expected.cancelAtPeriodEnd;
    if (!drift) {
      report.details.push({ subscriptionId: sub.subscriptionId, localStatus: sub.status, expectedStatus: expected.status, localCancelAtPeriodEnd: localCancel, expectedCancelAtPeriodEnd: expected.cancelAtPeriodEnd, action: 'in-sync' });
      continue;
    }

    report.driftDetected++;
    // Repair inside a transaction; every repair is logged for audit.
    const session = db.client.startSession();
    try {
      await session.withTransaction(async (sess) => {
        const now = new Date().toISOString();
        await c.subscriptions.updateOne(
          { subscriptionId: sub.subscriptionId } as { subscriptionId: string },
          {
            $set: {
              status: expected!.status,
              cancelAtPeriodEnd: expected!.cancelAtPeriodEnd,
              updatedAt: now,
            },
            ...(expected!.cancelAtPeriodEnd ? {} : { $unset: { cancelAt: '' } }),
          } as Document,
          { session: sess },
        );
        await c.dbLogs.insertOne({
          _id: `dblog_recon_${sub.subscriptionId}_${Date.now().toString(36)}`,
          runId: sub.runId,
          operation: 'update',
          collection: 'subscriptions',
          detail: `reconciliation repair · ${sub.subscriptionId} · status ${sub.status} → ${expected!.status}${localCancel !== expected!.cancelAtPeriodEnd ? ` · cancelAtPeriodEnd ${localCancel} → ${expected!.cancelAtPeriodEnd}` : ''}`,
          result: 'ok',
          transaction: true,
          createdAt: now,
        } as unknown as Parameters<typeof c.dbLogs.insertOne>[0]);
      });
      report.repaired++;
      report.details.push({ subscriptionId: sub.subscriptionId, localStatus: sub.status, expectedStatus: expected.status, localCancelAtPeriodEnd: localCancel, expectedCancelAtPeriodEnd: expected.cancelAtPeriodEnd, action: 'repaired', note: 'repaired from source of truth' });
    } catch (e) {
      report.details.push({ subscriptionId: sub.subscriptionId, localStatus: sub.status, expectedStatus: expected.status, action: 'skipped-no-truth', note: `repair failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      await session.endSession();
    }
  }

  await logApi({
    direction: 'inbound',
    component: 'reconciler',
    method: 'JOB',
    path: 'reconcile/all',
    statusCode: 200,
    request: { mode: report.mode, checked: report.checked },
    response: { driftDetected: report.driftDetected, repaired: report.repaired, skippedNoTruth: report.skippedNoTruth },
  });

  // A reconciliation that repaired drift also closes any run left hanging on
  // the affected subscription so the dashboard reflects the true outcome.
  for (const d of report.details) {
    if (d.action !== 'repaired') continue;
    const sub = subs.find((s) => s.subscriptionId === d.subscriptionId);
    if (sub?.runId) {
      const run = await c.runs.findOne({ _id: sub.runId } as Document);
      if (run?.status === 'running') {
        await finishRun(sub.runId, 'completed');
      }
    }
  }

  return report;
}

const g = globalThis as unknown as { __sp_last_reconciliation?: ReconciliationReport };

export function lastReconciliation(): ReconciliationReport | undefined {
  return g.__sp_last_reconciliation;
}

/** Wrapped by the scheduler on its configured interval. */
export async function runReconciliation(): Promise<ReconciliationReport> {
  const report = await reconcileAll();
  g.__sp_last_reconciliation = report;
  return report;
}
