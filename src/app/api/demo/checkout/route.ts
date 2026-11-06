import { startCheckoutRun } from '@/lib/stripepulse/runner';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    ensureScheduler();
    const body = (await req.json().catch(() => ({}))) as {
      planId?: string;
      email?: string;
      name?: string;
    };
    const result = await startCheckoutRun(body);
    return Response.json(result, { status: 201 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to start checkout' },
      { status: 500 },
    );
  }
}
