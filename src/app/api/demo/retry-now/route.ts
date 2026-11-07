import { tick, ensureScheduler } from '@/lib/stripepulse/scheduler';
import { guardDemoRequest } from '@/lib/stripepulse/guard';

export const dynamic = 'force-dynamic';

/** Manual scheduler tick — "Process due retries now" button + tests. */
export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'tick', limit: 30, windowMs: 60_000 });
  if (denied) return denied;

  ensureScheduler();
  const result = await tick();
  return Response.json({ ok: true, ...result });
}
