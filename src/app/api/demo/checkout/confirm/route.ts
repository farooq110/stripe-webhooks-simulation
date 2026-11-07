import { confirmCheckout } from '@/lib/stripepulse/runner';
import { guardDemoRequest } from '@/lib/stripepulse/guard';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'confirm', limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const { runId } = (await req.json()) as { runId: string };
    if (!runId) return Response.json({ error: 'runId is required' }, { status: 400 });
    const result = await confirmCheckout(runId);
    if (!result.ok) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to confirm checkout' },
      { status: 500 },
    );
  }
}
