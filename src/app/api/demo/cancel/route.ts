import { startCancelRun } from '@/lib/stripepulse/runner';
import { guardDemoRequest } from '@/lib/stripepulse/guard';

export const dynamic = 'force-dynamic';

/** Cancel a subscription through the real webhook pipeline. */
export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'scenario', limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { subscriptionId?: string };
    const result = await startCancelRun(body);
    return Response.json(result, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to cancel subscription';
    // Cancelling something that is already cancelled is a client mistake,
    // not a server fault — answer 409 Conflict instead of a raw 500
    // (QA finding LOW-4).
    const status = message.includes('already canceled') ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}
