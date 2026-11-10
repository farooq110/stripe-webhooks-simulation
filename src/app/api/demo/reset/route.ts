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
 * What a reset is allowed to delete, computed BEFORE anything is touched so
 * the response can report honestly. In simulated mode the whole database IS
 * demo data, so everything goes. In live mode the local mirrors of real
 * (test-mode) Stripe records are NOT demo artifacts — they are the app's only
 * record of what Stripe holds — so reset keeps every row that belongs to a
 * live-gateway run and only wipes simulated ones.
 *
 * Filter shape per collection (QA Round-3 MEDIUM-NEW-1): run documents key on
 * `_id` and have no `runId` field, and MongoDB's `$nin` matches documents
 * missing the field — so filtering `runs` on `runId` would wipe every run,
 * including the live ones the filter was meant to spare. Run rows are now
 * scoped by `_id`; every other collection carries `runId` and keeps the
 * original filter. Collections without a `runId` (counters) are demo state
 * either way and are wiped in both modes.
 */
interface ResetPlan {
  mode: 'simulated' | 'live';
  /** Run ids owned by the live gateway — protected from the wipe. */
  liveRunIds: string[];
  /** True when live protection is active (live mode AND at least one live run). */
  protecting: boolean;
  /** Exact delete filter per collection key. */
  filters: Record<string, Document>;
}

async function buildResetPlan(): Promise<ResetPlan> {
  const db = await getDb();
  const c = collections(db);
  const mode = getGateway().mode;
  const liveRunIds =
    mode === 'live'
      ? (await c.runs.find({ mode: 'live' } as Document).project({ _id: 1 }).toArray()).map((r) => String(r._id))
      : [];
  const protecting = mode === 'live' && liveRunIds.length > 0;

  const filters: Record<string, Document> = {};
  for (const key of DEMO_COLLECTIONS) {
    if (!protecting) filters[key] = {};
    else if (key === 'runs') filters[key] = { _id: { $nin: liveRunIds } };
    else filters[key] = { runId: { $nin: liveRunIds } };
  }
  return { mode, liveRunIds, protecting, filters };
}

function honestNote(plan: ResetPlan): string {
  if (plan.protecting) {
    return `Live mode: ${plan.liveRunIds.length} live-gateway run(s) and all of their rows were preserved; only simulated demo data was wiped.`;
  }
  if (plan.mode === 'live') {
    return 'Live mode: no live-gateway runs existed, so there was nothing to preserve — demo collections wiped.';
  }
  return 'Simulated mode: all demo collections wiped; plans and flags re-seeded.';
}

/** Preview: exactly what a reset would delete, per collection. */
export async function GET(req: Request) {
  const denied = guardDemoRequest(req, { name: 'reset', limit: 20, windowMs: 60_000 });
  if (denied) return denied;
  const db = await getDb();
  const c = collections(db);
  const plan = await buildResetPlan();
  const counts: Record<string, number> = {};
  for (const key of DEMO_COLLECTIONS) {
    counts[key] = await c[key].countDocuments(plan.filters[key]);
  }
  return Response.json({
    ok: true,
    mode: plan.mode,
    protectedLiveRecords: plan.protecting,
    liveRunsPreserved: plan.liveRunIds.length,
    counts,
    note: honestNote(plan),
  });
}

export async function POST(req: Request) {
  // Reset is the most destructive endpoint of the demo — tightest rate limit
  // plus the shared token gate when DEMO_API_TOKEN is configured.
  const denied = guardDemoRequest(req, { name: 'reset', limit: 5, windowMs: 60_000 });
  if (denied) return denied;

  const db = await getDb();
  const c = collections(db);
  // The plan (and therefore the protection scope) is fixed before the first
  // delete — never derived from post-deletion state.
  const plan = await buildResetPlan();

  const deleted: Record<string, number> = {};
  for (const key of DEMO_COLLECTIONS) {
    const res = await c[key].deleteMany(plan.filters[key]);
    deleted[key] = res.deletedCount;
  }

  // Failure injections are operator state, not data — switch them off so a
  // fresh demo never starts with injections enabled.
  await c.flags.updateOne({ _id: 'db_failure' } as Document, { $set: { enabled: false } });
  await c.flags.updateOne({ _id: 'retry_failure' } as Document, { $set: { enabled: false } });

  ensureScheduler();
  return Response.json({
    ok: true,
    deleted,
    mode: plan.mode,
    protectedLiveRecords: plan.protecting,
    liveRunsPreserved: plan.liveRunIds.length,
    note: honestNote(plan),
  });
}
