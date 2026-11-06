import { getAppState } from '@/lib/stripepulse/queries';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureScheduler();
  const state = await getAppState();
  return Response.json(state);
}
