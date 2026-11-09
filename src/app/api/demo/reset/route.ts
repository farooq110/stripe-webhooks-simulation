import type { Document } from 'mongodb';

import { collections, getDb } from '@/lib/stripepulse/mongo';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';
import { guardDemoRequest } from '@/lib/stripepulse/guard';
import { getGateway } from '@/lib/stripepulse/gateway';

export const dynamic = 'force-dynamic';

// Collections wiped by a reset. `plans` is deliberately absent — the price
// catalog is configuration, not demo data, and must survive a reset.
const DEMO_COLLECTIONS = [
  'runs',
  'steps',
  'events',
  'apiLogs',
  'dbLogs',
  'attempts',
  'subscriptions',
  'customers',
  'retryJobs',
  'counters',
] as const;

/**
 * What a reset is allowed to delete. In simulated mode the whole database IS
 * demo data, so everything goes. In live mode the local mirrors of real
 * (test-mode) Stripe records are NOT demo artifacts — they are the app's only
 * record of what Stripe holds — so reset keeps every row that belongs to a
 * live-gateway run and only wipes simulated ones.
 */
async function deletionPlan(): Promise<{ mode: string; protectedLiveRecords: boolean; counts: Record<string, number> }> {
  const db = await getDb();
  const c = collections(db);
  const live = getGateway().mode === 'live';
  const liveRunIds = live
    ? (await c.runs.find({ mode: 'live' } as Document).project({ _id: 1 }).toArray()).map((r) => String(r._id))
    : [];
  const counts: Record<string, number> = {};

  for (const key of DEMO_COLLECTIONS) {
    const coll = c[key];
    if (live && liveRunIds.length > 0) {
      counts[key] = await coll.countDocuments({ runId: { $nin: liveRunIds } } as Document);
    } else {
      counts[key] = await coll.countDocuments({});
    }
  }
  return { mode: live ? 'live' : 'simulated', protectedLiveRecords: live && liveRunIds.length > 0, counts };
}

/** Preview: exactly what a reset would delete, per collection. */
export async function GET(req: Request) {
  const denied = guardDemoRequest(req, { name: 'reset', limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  const plan = await deletionPlan();
  return Response.json({ ok: true, ...plan });
}

export async function POST(req: Request) {
  // Reset is the most destructive endpoint of the demo — tightest rate limit
  // plus the shared token gate when DEMO_API_TOKEN is configured.
  const denied = guardDemoRequest(req, { name: 'reset', limit: 5, windowMs: 60_000 });
  if (denied) return denied;

  const db = await getDb();
  const c = collections(db);
  const live = getGateway().mode === 'live';
  const liveRunIds = live
    ? (await c.runs.find({ mode: 'live' } as Document).project({ _id: 1 }).toArray()).map((r) => String(r._id))
    : [];

  const deleted: Record<string, number> = {};
  for (const key of DEMO_COLLECTIONS) {
    const coll = c[key];
    // Live-gateway records are scoped out of the wipe; in simulated mode the
    // whole collection is demo data.
    const filter = live && liveRunIds.length > 0 ? { runId: { $nin: liveRunIds } } : {};
    const res = await coll.deleteMany(filter as Document);
    deleted[key] = res.deletedCount;
  }
  // Failure injections are operator state, not data — switch them off so a
  // fresh demo never starts with injections enabled.
  await c.flags.updateOne({ _id: 'db_failure' } as Document, { $set: { enabled: false } });
  await c.flags.updateOne({ _id: 'retry_failure' } as Document, { $set: { enabled: false } });

  ensureScheduler();
  const plan = await deletionPlan();
  return Response.json({
    ok: true,
    deleted,
    mode: plan.mode,
    protectedLiveRecords: plan.protectedLiveRecords,
    note: live
      ? 'Live-mode records (runs created by the real Stripe gateway) were preserved.'
      : 'Simulated mode: all demo collections wiped; plans and flags re-seeded.',
  });
}
