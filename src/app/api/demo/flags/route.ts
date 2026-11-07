import type { Document } from 'mongodb';

import { collections, getDb, getFlag, setFlag } from '@/lib/stripepulse/mongo';
import { completeStep } from '@/lib/stripepulse/recorder';

export const dynamic = 'force-dynamic';

const KNOWN_FLAGS = ['db_failure', 'retry_failure'] as const;
type FlagName = (typeof KNOWN_FLAGS)[number];

export async function GET() {
  return Response.json({
    dbFailure: await getFlag('db_failure'),
    retryFailure: await getFlag('retry_failure'),
  });
}

export async function PUT(req: Request) {
  const body = (await req.json()) as { flag?: FlagName; enabled: boolean };
  // Backwards compatible: a bare { enabled } still means the db_failure flag.
  const flag: FlagName = body.flag === 'retry_failure' ? 'retry_failure' : 'db_failure';
  const enabled = Boolean(body.enabled);
  await setFlag(flag, enabled);

  // When the operator disables the db-failure injection, mark the recovery
  // step of any running db-failure run (real state change, recorded where it
  // happens).
  if (flag === 'db_failure' && !enabled) {
    const db = await getDb();
    const c = collections(db);
    const activeRun = await c.runs
      .find({ scenario: 'db_failure_recovery', status: 'running' } as Document)
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (activeRun) {
      await completeStep(String(activeRun._id), 'injection_disabled', {
        disabledAt: new Date().toISOString(),
        by: 'operator via dashboard / API',
        note: 'Next redelivery will be processed normally',
      });
    }
  }

  return Response.json({ flag, enabled });
}
