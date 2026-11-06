// ─── StripePulse · idempotent webhook processor ─────────────────────────────
// The app's real webhook receiver. Guarantees:
//  1. Signature verification (live: Stripe SDK; sim: identical HMAC scheme).
//  2. Idempotency via the unique index on webhook_events.eventId — a
//     redelivered event that was already processed is acknowledged with 200
//     but executes ZERO writes.
//  3. Atomic multi-document writes inside a genuine MongoDB replica-set
//     transaction; any failure aborts and rolls back everything.
//  4. On processing failure the endpoint responds 500 exactly like Stripe
//     expects, and the event is queued for redelivery with exponential
//     backoff (handled by the scheduler).

import type { Db, ClientSession, WithTransactionCallback, Document } from 'mongodb';
import { collections, getDb, getFlag } from './mongo';
import { getGateway, type StripeEvent } from './gateway';
import { verifySignature } from './crypto';
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
      const status = event.type === 'customer.subscription.deleted'
        ? 'canceled'
        : (obj.status as string) ?? 'active';
      const periods = subPeriods(obj);
      const now = new Date().toISOString();
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
      await c.subscriptions.updateOne(
        { subscriptionId } as { subscriptionId: string },
        { $set: set, $setOnInsert: { createdAt: now, customerId: obj.customer as string } },
        { upsert: true, session },
      );
      ops.push({
        operation: 'update',
        collection: 'subscriptions',
        detail: `${subscriptionId} · status=${status}`,
      });
      break;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const paid = event.type === 'invoice.paid';
      const invoiceId = obj.id as string;
      const subscriptionId = (obj.subscription as string) ?? md.subscription_id;
      const attempt = Number(md.attempt ?? obj.attempt_count ?? 1);
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
        } as Document,
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

export async function processWebhook(
  raw: string,
  signature: string | null,
): Promise<ProcessResult> {
  const t0 = Date.now();
  const db = await getDb();
  const c = collections(db);
  const gateway = getGateway();

  // ── 1 · Signature verification ────────────────────────────────────────────
  let verified = false;
  let verifyReason = '';
  let event: StripeEvent | null = null;
  try {
    if (gateway.mode === 'live') {
      event = await gateway.constructWebhookEvent(raw, signature ?? '');
      verified = true;
    } else {
      const v = verifySignature(raw, signature);
      verifyReason = v.reason ?? '';
      if (v.ok) {
        event = await gateway.constructWebhookEvent(raw, signature ?? '');
        verified = true;
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

  const runId = ((event.data.object as Record<string, unknown>).metadata as Record<string, string>)
    ?.run_id ?? undefined;

  // ── 2 · Idempotency guard (unique index on eventId) ──────────────────────
  const now = new Date().toISOString();
  let attempts = 1;
  let isRetry = false;
  try {
    await c.events.insertOne({
      _id: event.id,
      eventId: event.id,
      runId,
      type: event.type,
      payloadRaw: raw,
      status: 'received',
      attempts: 1,
      signatureVerified: true,
      deliveries: [],
      createdAt: now,
    } as Document);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 11000) throw e;
    // Event already known — decide duplicate vs. legitimate retry.
    const existing = await c.events.findOne({ eventId: event.id } as { eventId: string });
    if (!existing) {
      // Extremely rare: duplicate key but doc vanished. Retry insert once.
      return processWebhook(raw, signature);
    }
    if (existing.status === 'processed' || existing.status === 'duplicate') {
      // ── DUPLICATE: acknowledge, execute zero writes ──────────────────────
      await c.events.updateOne(
        { eventId: event.id } as { eventId: string },
        { $push: { deliveries: { at: now, httpStatus: 200, duplicate: true } }, $set: { status: 'duplicate' } },
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
        request: { eventId: event.id, type: event.type, redelivery: true },
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
    // status 'failed' or stale 'received': this is a legitimate redelivery retry
    isRetry = true;
    attempts = existing.attempts + 1;
    await c.events.updateOne(
      { eventId: event.id } as { eventId: string },
      {
        $set: { status: 'processing', lastError: undefined, nextRetryAt: undefined },
        $inc: { attempts: 1 },
      },
    );
  }

  // ── 3 · Atomic processing (real MongoDB transaction) ─────────────────────
  const mutating = MUTATING.has(event.type);
  const ops: OpRecord[] = [];
  const injectionEnabled = mutating ? await getFlag('db_failure') : false;

  if (mutating && injectionEnabled) {
    // Fail BEFORE any write — mirrors a DB outage. Transaction not even opened.
    const backoffMs = Math.min(2000 * 2 ** (attempts - 1), 30_000);
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    await c.events.updateOne(
      { eventId: event.id } as { eventId: string },
      {
        $set: {
          status: 'failed',
          lastError: 'InjectedDbFailure: demo DB failure flag is enabled',
          nextRetryAt,
        },
        $push: { deliveries: { at: now, httpStatus: 500, duplicate: false } },
      },
    );
    await logDb({
      runId,
      operation: mutating ? 'transaction' : 'none',
      collection: 'multiple',
      detail: `INJECTED FAILURE before write · ${event.type} · tx aborted, nothing persisted`,
      result: 'failed',
      transaction: true,
    });
    await logApi({
      runId,
      direction: 'inbound',
      component: 'app webhook endpoint',
      method: 'POST',
      path: WEBHOOK_PATH,
      statusCode: 500,
      durationMs: Date.now() - t0,
      request: { eventId: event.id, type: event.type, attempt: attempts },
      response: { error: 'Database write failed', nextRetryAt, retryStrategy: 'exponential backoff' },
    });
    if (runId) {
      await failStep(runId, 'webhook_delivery', {
        eventId: event.id,
        statusCode: 500,
        attempt: attempts,
        error: 'DB write failed — Stripe will redeliver',
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
        nextRetryAt,
        attempts,
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
    const backoffMs = Math.min(2000 * 2 ** (attempts - 1), 30_000);
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    await c.events.updateOne(
      { eventId: event.id } as { eventId: string },
      {
        $set: { status: 'failed', lastError: handlerError.message, nextRetryAt },
        $push: { deliveries: { at: now, httpStatus, duplicate: false } },
      },
    );
    for (const op of ops) {
      await logDb({ runId, operation: op.operation, collection: op.collection, detail: op.detail, result: 'failed', transaction: true });
    }
    await logApi({
      runId,
      direction: 'inbound',
      component: 'app webhook endpoint',
      method: 'POST',
      path: WEBHOOK_PATH,
      statusCode: 500,
      durationMs,
      request: { eventId: event.id, type: event.type, attempt: attempts },
      response: { error: handlerError.message, nextRetryAt },
    });
    if (runId) {
      await failStep(runId, 'db_transaction', { error: handlerError.message, attempt: attempts });
      await failStep(runId, 'webhook_delivery', { eventId: event.id, statusCode: 500 });
    }
    return { httpStatus: 500, body: { error: handlerError.message, eventId: event.id, nextRetryAt } };
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
      operation: op.operation,
      collection: op.collection,
      detail: op.detail,
      result: op.operation === 'none' ? 'read-only' : 'ok',
      transaction: true,
    });
  }
  await logApi({
    runId,
    direction: 'inbound',
    component: 'app webhook endpoint',
    method: 'POST',
    path: WEBHOOK_PATH,
    statusCode: 200,
    durationMs,
    request: { eventId: event.id, type: event.type, redelivery: isRetry || undefined, attempt: attempts },
    response: { received: true, duplicate: false, writesExecuted: ops.filter((o) => o.operation !== 'none').length },
  });

  if (runId) {
    await completeStep(runId, 'webhook_delivery', {
      eventId: event.id,
      type: event.type,
      statusCode: 200,
      attempt: attempts,
      ...(isRetry ? { note: 'accepted on redelivery' } : {}),
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
        writes: ops.filter((o) => o.operation !== 'none').map((o) => `${o.operation} ${o.collection}: ${o.detail}`),
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
      writesExecuted: ops.filter((o) => o.operation !== 'none').length,
    },
  };
}
