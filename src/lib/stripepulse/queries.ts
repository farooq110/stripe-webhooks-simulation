import type { Document } from 'mongodb';

// ─── StripePulse · read models for the dashboard ─────────────────────────────

import type { AppStatePayload, RunStatePayload } from './types';
import { collections, getDb, getFlag, mongoHealth } from './mongo';
import { getGateway } from './gateway';

export async function getRunState(runId: string): Promise<RunStatePayload | null> {
  const db = await getDb();
  const c = collections(db);
  const run = await c.runs.findOne({ _id: runId } as { _id: string });
  if (!run) return null;
  const [steps, events, apiLogs, dbLogs, attempts, subscriptions] = await Promise.all([
    c.steps.find({ runId } as Document).sort({ idx: 1 }).toArray(),
    c.events.find({ runId } as Document).sort({ createdAt: 1 }).limit(40).toArray(),
    c.apiLogs.find({ runId } as Document).sort({ createdAt: 1 }).limit(80).toArray(),
    c.dbLogs.find({ runId } as Document).sort({ createdAt: 1 }).limit(80).toArray(),
    c.attempts.find({ runId } as Document).sort({ createdAt: 1 }).limit(30).toArray(),
    c.subscriptions.find({ runId } as Document).sort({ createdAt: 1 }).limit(10).toArray(),
  ]);
  return {
    run: run as unknown as RunStatePayload['run'],
    steps: steps as unknown as RunStatePayload['steps'],
    events: events as unknown as RunStatePayload['events'],
    apiLogs: apiLogs as unknown as RunStatePayload['apiLogs'],
    dbLogs: dbLogs as unknown as RunStatePayload['dbLogs'],
    attempts: attempts as unknown as RunStatePayload['attempts'],
    subscriptions: subscriptions as unknown as RunStatePayload['subscriptions'],
  };
}

export async function getAppState(): Promise<AppStatePayload> {
  const db = await getDb();
  const c = collections(db);
  const gateway = getGateway();

  const [mongo, dbFailure, retryFailure, plans, subscriptions, attempts, recentEvents, runs, processed, failed, dupes, dead, jobsScheduled, jobsRunning, jobsExhausted, jobsDone] =
    await Promise.all([
      mongoHealth(),
      getFlag('db_failure'),
      getFlag('retry_failure'),
      c.plans.find().toArray(),
      c.subscriptions.find().sort({ createdAt: -1 }).limit(12).toArray(),
      c.attempts.find().sort({ createdAt: -1 }).limit(15).toArray(),
      c.events.find().sort({ createdAt: -1 }).limit(15).toArray(),
      c.runs.find().sort({ createdAt: -1 }).limit(12).toArray(),
      c.events.countDocuments({ status: 'processed' } as Document),
      c.events.countDocuments({ status: 'failed' } as Document),
      c.dbLogs.countDocuments({ result: 'read-only', operation: 'findUnique' } as Document),
      c.events.countDocuments({ status: 'dead' } as Document),
      c.retryJobs.countDocuments({ status: 'scheduled' } as Document),
      c.retryJobs.countDocuments({ status: 'running' } as Document),
      c.retryJobs.countDocuments({ status: 'exhausted' } as Document),
      c.retryJobs.countDocuments({ status: 'done' } as Document),
    ]);

  const active = subscriptions.filter((s) => s.status === 'active' || s.status === 'trialing');
  const mrr = active.reduce((sum, s) => sum + s.amount, 0);

  return {
    gateway: { mode: gateway.mode, reason: gateway.reason },
    mongo,
    flags: { dbFailure, retryFailure },
    plans: plans as unknown as AppStatePayload['plans'],
    subscriptions: subscriptions as unknown as AppStatePayload['subscriptions'],
    attempts: attempts as unknown as AppStatePayload['attempts'],
    recentEvents: recentEvents as unknown as AppStatePayload['recentEvents'],
    runs: runs as unknown as AppStatePayload['runs'],
    retryQueue: {
      scheduled: jobsScheduled,
      running: jobsRunning,
      exhausted: jobsExhausted,
      done: jobsDone,
      dead,
      failedEvents: failed,
    },
    stats: {
      activeSubscriptions: active.length,
      mrr,
      eventsProcessed: processed,
      eventsFailed: failed,
      duplicatesBlocked: dupes,
      deadLettered: dead,
    },
  };
}
