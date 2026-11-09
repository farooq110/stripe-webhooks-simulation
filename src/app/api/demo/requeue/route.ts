import type { Document } from 'mongodb';

import { collections, getDb } from '@/lib/stripepulse/mongo';
import { guardDemoRequest } from '@/lib/stripepulse/guard';
import { dispatchWebhook } from '@/lib/stripepulse/dispatcher';
import { logApi } from '@/lib/stripepulse/recorder';

export const dynamic = 'force-dynamic';

/**
 * Manual retry for dead-lettered (or failed) webhook events.
 *
 * Body: { eventId: "evt_..." }
 *
 * The event's stored payload is re-dispatched to the app's webhook endpoint
 * over real HTTP with a fresh signature. This is the operator's escape hatch
 * once WEBHOOK_MAX_REDELIVERIES is exhausted — nothing is processed in
 * place, everything goes through signature verification, idempotency and the
 * transactional pipeline like any other delivery.
 */
export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'requeue', limit: 20, windowMs: 60_000 });
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { eventId?: unknown };
  if (typeof body.eventId !== 'string' || !body.eventId.startsWith('evt_')) {
    return Response.json({ error: 'eventId (evt_…) is required' }, { status: 400 });
  }

  const db = await getDb();
  const c = collections(db);
  const evtDoc = await c.events.findOne({ eventId: body.eventId } as Document);
  if (!evtDoc) {
    return Response.json({ error: `No webhook event ${body.eventId}` }, { status: 404 });
  }
  if (evtDoc.status === 'dead' || evtDoc.status === 'failed') {
    // Move it back into the redelivery queue so the scheduler also owns it
    // if this manual attempt fails again.
    await c.events.updateOne(
      { eventId: evtDoc.eventId } as Document,
      {
        $set: { status: 'failed', nextRetryAt: new Date(Date.now() + 30_000).toISOString() },
        $unset: { deadAt: '' },
        $push: {
          deliveries: { at: new Date().toISOString(), httpStatus: 0, duplicate: false, manual: true },
        },
      } as Document,
    );
  } else {
    return Response.json(
      { error: `Event ${evtDoc.eventId} is ${evtDoc.status} — only failed or dead-lettered events can be requeued` },
      { status: 409 },
    );
  }

  let event: { id: string; type: string } | null = null;
  try {
    event = JSON.parse(evtDoc.payloadRaw) as { id: string; type: string };
  } catch {
    return Response.json({ error: 'Stored payload is not parseable' }, { status: 500 });
  }

  const res = await dispatchWebhook(event as Parameters<typeof dispatchWebhook>[0], evtDoc.runId ?? undefined);
  await logApi({
    runId: evtDoc.runId ?? undefined,
    correlationId: evtDoc.eventId,
    direction: 'outbound',
    component: 'operator requeue',
    method: 'POST',
    path: '/api/demo/requeue',
    statusCode: res.httpStatus,
    request: { eventId: evtDoc.eventId, type: evtDoc.type, manual: true },
    response: res.body,
  });

  return Response.json({
    ok: res.httpStatus === 200,
    eventId: evtDoc.eventId,
    delivery: { httpStatus: res.httpStatus, body: res.body },
  });
}
