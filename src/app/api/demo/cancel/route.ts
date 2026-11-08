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
    if (message.includes('already canceled')) {
      return Response.json({ error: message }, { status: 409 });
    }
    // Cancellation blocked by the DB-failure injection: the write truly did
    // not happen and the service is temporarily unable to finish — 503 with
    // the run id so the operator can inspect it (QA finding INFO-5).
    if (message.startsWith('Cancellation did not commit')) {
      return Response.json({ error: message, runId: /run (\S+)/.exec(message)?.[1] }, { status: 503 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
