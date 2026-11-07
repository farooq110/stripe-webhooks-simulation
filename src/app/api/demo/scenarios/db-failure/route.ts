import { startDbFailureRun } from '@/lib/stripepulse/runner';
import { guardDemoRequest } from '@/lib/stripepulse/guard';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'scenario', limit: 20, windowMs: 60_000 });
  if (denied) return denied;

  try {
    const result = await startDbFailureRun();
    return Response.json(result, { status: 201 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to start db-failure scenario' },
      { status: 500 },
    );
  }
}
