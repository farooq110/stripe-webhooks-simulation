// ─── StripePulse · the app's real webhook endpoint ──────────────────────────
// Receives Stripe webhooks (live mode: from Stripe; simulated mode: from the
// local gateway dispatcher over real HTTP). Signature verification,
// idempotency and transactional processing all happen in processor.ts.

import { processWebhook } from '@/lib/stripepulse/processor';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

// Stripe webhook payloads are small (a few KB, at most a few hundred KB for
// big batches). Anything larger is not a real webhook, so reject it before
// reading the whole body (QA finding INFO-3).
const MAX_WEBHOOK_BYTES = 1024 * 1024;

export async function POST(req: Request) {
  ensureScheduler();

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: 'Webhook payload too large' }, { status: 413 });
  }

  const payload = await req.text();
  if (payload.length > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: 'Webhook payload too large' }, { status: 413 });
  }

  const signature = req.headers.get('Stripe-Signature');
  const result = await processWebhook(payload, signature);
  return Response.json(result.body, { status: result.httpStatus });
}
