// ─── StripePulse · webhook dispatcher (the "Stripe side" of the wire) ───────
// Delivers events to the app's real webhook endpoint over genuine HTTP with
// a genuine Stripe-Signature header, and records the real response.

import type { StripeEvent } from './gateway';
import { signPayload } from './crypto';
import { logApi } from './recorder';

export const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
export const WEBHOOK_PATH = '/api/webhooks/stripe';

export interface DispatchResult {
  eventId: string;
  type: string;
  httpStatus: number;
  body: Record<string, unknown>;
  durationMs: number;
}

export async function dispatchWebhook(
  event: StripeEvent,
  runId?: string,
): Promise<DispatchResult> {
  const payload = JSON.stringify(event);
  const signature = signPayload(payload);
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(`${APP_URL}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: payload,
      cache: 'no-store',
    });
  } catch (e) {
    const durationMs = Date.now() - t0;
    await logApi({
      runId,
      direction: 'outbound',
      component: 'stripe → app webhook',
      method: 'POST',
      path: WEBHOOK_PATH,
      statusCode: 0,
      durationMs,
      request: { eventId: event.id, type: event.type },
      response: { error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }

  const durationMs = Date.now() - t0;
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = { parseError: 'non-JSON response' };
  }

  await logApi({
    runId,
    direction: 'outbound',
    component: 'stripe → app webhook',
    method: 'POST',
    path: WEBHOOK_PATH,
    statusCode: res.status,
    durationMs,
    request: {
      eventId: event.id,
      type: event.type,
      signature: `Stripe-Signature: ${signature.slice(0, 42)}…`,
      payloadBytes: payload.length,
    },
    response: body,
  });

  return { eventId: event.id, type: event.type, httpStatus: res.status, body, durationMs };
}

export async function dispatchSequence(
  runId: string,
  events: StripeEvent[],
  gapMs = 120,
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  for (const evt of events) {
    results.push(await dispatchWebhook(evt, runId));
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
  }
  return results;
}
