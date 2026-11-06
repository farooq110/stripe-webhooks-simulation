import { getRunState } from '@/lib/stripepulse/queries';
import { observeUiPoll } from '@/lib/stripepulse/recorder';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const state = await getRunState(id);
  if (!state) return Response.json({ error: 'Run not found' }, { status: 404 });
  // The dashboard really polled — record it as the run's final UI step.
  await observeUiPoll(id, `/api/runs/${id}`);
  return Response.json(state);
}
