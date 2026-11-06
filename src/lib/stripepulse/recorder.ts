// ─── StripePulse · observability recorder ────────────────────────────────────
// Every entry persisted here is produced by real backend activity — never
// fabricated on the client. The UI renders these records verbatim.

import type { DbLogDoc, PipelineNodeId, StepDetail, StepStatus } from './types';
import { collections, getDb } from './mongo';

function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ── Steps ────────────────────────────────────────────────────────────────────

export async function insertSteps(
  runId: string,
  steps: { key: string; title: string; nodeId: PipelineNodeId }[],
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await collections(db).steps.insertMany(
    steps.map((s, i) => ({
      _id: `${runId}_s${i + 1}`,
      runId,
      idx: i + 1,
      key: s.key,
      title: s.title,
      nodeId: s.nodeId,
      status: 'pending' as StepStatus,
      createdAt: now,
    })),
  );
}

export async function markStep(
  runId: string,
  key: string,
  status: StepStatus,
  detail?: StepDetail,
  mergeDetail = false,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const set: Record<string, unknown> = { status };
  if (status === 'running') set.startedAt = now;
  else set.finishedAt = now;

  if (detail) {
    if (mergeDetail) {
      const current = await collections(db).steps.findOne(
        { runId, key } as { runId: string; key: string },
      );
      set.detail = { ...(current?.detail ?? {}), ...detail };
    } else {
      set.detail = detail;
    }
  }
  await collections(db).steps.updateOne(
    { runId, key } as { runId: string; key: string },
    { $set: set },
  );
}

export async function startStep(runId: string, key: string, detail?: StepDetail): Promise<void> {
  await markStep(runId, key, 'running', detail);
}

export async function completeStep(runId: string, key: string, detail?: StepDetail): Promise<void> {
  await markStep(runId, key, 'completed', detail, true);
}

export async function failStep(runId: string, key: string, detail?: StepDetail): Promise<void> {
  await markStep(runId, key, 'failed', detail, true);
}

export async function blockStep(runId: string, key: string, detail?: StepDetail): Promise<void> {
  await markStep(runId, key, 'blocked', detail, true);
}

// ── API call logs (real HTTP traffic in/out of the app) ─────────────────────

export async function logApi(entry: {
  runId?: string;
  direction: 'outbound' | 'inbound';
  component: string;
  method: string;
  path: string;
  statusCode?: number;
  durationMs?: number;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  await collections(db).apiLogs.insertOne({ _id: id('log'), ...entry, createdAt: new Date().toISOString() });
}

// ── Database operation logs (real writes attempted against MongoDB) ─────────

export async function logDb(entry: {
  runId?: string;
  operation: string;
  collection: string;
  detail: string;
  result: 'ok' | 'failed' | 'read-only';
  transaction: boolean;
}): Promise<void> {
  const db = await getDb();
  await collections(db).dbLogs.insertOne({ _id: id('dblog'), ...entry, createdAt: new Date().toISOString() });
}

// ── Run lifecycle ────────────────────────────────────────────────────────────

export async function finishRun(runId: string, status: 'completed' | 'failed'): Promise<void> {
  const db = await getDb();
  await collections(db).runs.updateOne(
    { _id: runId } as { _id: string },
    { $set: { status, completedAt: new Date().toISOString() } },
  );
}

/** Marks the final ui_refresh step once the dashboard has actually polled. */
export async function observeUiPoll(runId: string, path: string): Promise<void> {
  const db = await getDb();
  const step = await collections(db).steps.findOne(
    { runId, key: 'ui_refresh' } as { runId: string; key: string },
  );
  if (!step || step.status === 'completed') return;
  await markStep(runId, 'ui_refresh', 'completed', {
    path,
    statusCode: 200,
    polledAt: new Date().toISOString(),
    note: 'Dashboard polling observed (real inbound GET request)',
  }, true);
}
