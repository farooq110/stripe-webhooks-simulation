import { startDbFailureRun } from '@/lib/stripepulse/runner';

export const dynamic = 'force-dynamic';

export async function POST() {
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
