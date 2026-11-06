import type { Document } from 'mongodb';

import { collections, getDb, getFlag, setFlag } from '@/lib/stripepulse/mongo';
import { completeStep } from '@/lib/stripepulse/recorder';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ dbFailure: await getFlag('db_failure') });
}

export async function PUT(req: Request) {
  const { enabled } = (await req.json()) as { enabled: boolean };
  await setFlag('db_failure', Boolean(enabled));

  // When the operator disables the injection, mark the recovery step of any
  // running db-failure run (real state change, recorded where it happens).
  if (!enabled) {
    const db = await getDb();
    const c = collections(db);
    const activeRun = await c.runs
      .find({ scenario: 'db_failure_recovery', status: 'running' } as Document)
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (activeRun) {
      await completeStep(activeRun._id, 'injection_disabled', {
        disabledAt: new Date().toISOString(),
        by: 'operator via dashboard / API',
        note: 'Next redelivery will be processed normally',
      });
    }
  }
  return Response.json({ dbFailure: enabled });
}
