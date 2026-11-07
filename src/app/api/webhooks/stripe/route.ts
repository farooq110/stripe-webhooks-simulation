// ─── StripePulse · the app's real webhook endpoint ──────────────────────────
// Receives Stripe webhooks (live mode: from Stripe; simulated mode: from the
// local gateway dispatcher over real HTTP). Signature verification,
// idempotency and transactional processing all happen in processor.ts.

import { processWebhook } from '@/lib/stripepulse/processor';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  ensureScheduler();
  const payload = await req.text();
  const signature = req.headers.get('Stripe-Signature');
  const result = await processWebhook(payload, signature);
  return Response.json(result.body, { status: result.httpStatus });
}
