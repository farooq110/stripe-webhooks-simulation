import { tick, ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

/** Manual scheduler tick — "Process due retries now" button + tests. */
export async function POST() {
  ensureScheduler();
  const result = await tick();
  return Response.json({ ok: true, ...result });
}
