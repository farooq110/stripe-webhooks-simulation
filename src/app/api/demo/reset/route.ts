import type { Document } from 'mongodb';

import { collections, getDb } from '@/lib/stripepulse/mongo';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';
import { guardDemoRequest } from '@/lib/stripepulse/guard';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Reset wipes the whole demo — tightest rate limit of all endpoints.
  const denied = guardDemoRequest(req, { name: 'reset', limit: 5, windowMs: 60_000 });
  if (denied) return denied;

  const db = await getDb();
  const c = collections(db);
  await Promise.all([
    c.runs.deleteMany({}),
    c.steps.deleteMany({}),
    c.events.deleteMany({}),
    c.apiLogs.deleteMany({}),
    c.dbLogs.deleteMany({}),
    c.attempts.deleteMany({}),
    c.subscriptions.deleteMany({}),
    c.customers.deleteMany({}),
    c.retryJobs.deleteMany({}),
    c.counters.deleteMany({}),
    c.flags.updateOne({ _id: 'db_failure' } as Document, { $set: { enabled: false } }),
    c.flags.updateOne({ _id: 'retry_failure' } as Document, { $set: { enabled: false } }),
  ]);
  ensureScheduler();
  return Response.json({ ok: true });
}
