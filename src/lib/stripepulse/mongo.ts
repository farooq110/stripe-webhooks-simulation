// ─── StripePulse · MongoDB layer ─────────────────────────────────────────────
// Genuine MongoDB 8.x replica set (required for real multi-document ACID
// transactions). If mongod is not running, it is spawned on first use so the
// app self-heals after a sandbox restart. Data persists in db/mongodb-data.

import { MongoClient, type Db } from 'mongodb';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const MONGO_PORT = 27017;
export const DB_NAME = 'stripepulse';
export const REPLSET = 'rs0';

const RUNTIME_BIN = path.join(process.cwd(), '.mongodb-runtime', 'bin', 'mongod');
const DB_PATH = path.join(process.cwd(), 'db', 'mongodb-data');
const LOG_PATH = path.join(process.cwd(), '.mongodb-runtime', 'mongod.log');

const globalStore = globalThis as unknown as {
  __sp_client?: MongoClient;
  __sp_db?: Promise<Db>;
};

function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

async function ensureMongodRunning(): Promise<void> {
  if (await portOpen(MONGO_PORT)) return;
  // Spawn the bundled mongod as a detached forked daemon.
  const res = spawnSync(
    RUNTIME_BIN,
    [
      '--dbpath', DB_PATH,
      '--port', String(MONGO_PORT),
      '--bind_ip', '127.0.0.1',
      '--replSet', REPLSET,
      '--fork',
      '--logpath', LOG_PATH,
      '--oplogSize', '128',
    ],
    { stdio: 'ignore', timeout: 20_000 },
  );
  if (res.error || !(await portOpen(MONGO_PORT))) {
    throw new Error(
      `mongod could not be started (binary: ${RUNTIME_BIN}). ` +
      `Start it manually: mongod --dbpath ${DB_PATH} --port ${MONGO_PORT} --replSet ${REPLSET}`,
    );
  }
  // Wait for readiness
  for (let i = 0; i < 40; i++) {
    if (await portOpen(MONGO_PORT)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('mongod did not open port in time');
}

async function ensureReplicaSet(): Promise<void> {
  const direct = new MongoClient(
    `mongodb://127.0.0.1:${MONGO_PORT}/?directConnection=true&serverSelectionTimeoutMS=3000`,
  );
  try {
    await direct.db('admin').command({ replSetGetStatus: 1 });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 94 /* NotYetInitialized */ || code === undefined) {
      try {
        await direct.db('admin').command({
          replSetInitiate: { _id: REPLSET, members: [{ _id: 0, host: `127.0.0.1:${MONGO_PORT}` }] },
        });
      } catch { /* already initiating */ }
    }
  } finally {
    await direct.close().catch(() => {});
  }
  // Wait for PRIMARY
  const uri = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}?replicaSet=${REPLSET}&serverSelectionTimeoutMS=2000`;
  for (let i = 0; i < 60; i++) {
    try {
      const c = new MongoClient(uri);
      await c.connect();
      const hello = await c.db('admin').command({ hello: 1 });
      await c.close();
      if (hello.isWritablePrimary) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Replica set did not elect a PRIMARY');
}

async function ensureSchema(db: Db): Promise<void> {
  const colls = [
    'runs', 'run_steps', 'webhook_events', 'api_logs', 'db_logs',
    'payment_attempts', 'subscriptions', 'customers', 'retry_jobs',
    'plans', 'flags', 'counters', 'app_settings',
  ];
  const existing = new Set(await db.listCollections().toArray().then((a) => a.map((c) => c.name)));
  for (const c of colls) {
    if (!existing.has(c)) await db.createCollection(c);
  }
  await db.collection('run_steps').createIndex({ runId: 1, idx: 1 });
  await db.collection('webhook_events').createIndex({ eventId: 1 }, { unique: true });
  await db.collection('webhook_events').createIndex({ status: 1, nextRetryAt: 1 });
  await db.collection('webhook_events').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('subscriptions').createIndex({ subscriptionId: 1 }, { unique: true });
  await db.collection('subscriptions').createIndex({ runId: 1 });
  await db.collection('customers').createIndex({ customerId: 1 }, { unique: true });
  await db.collection('api_logs').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('db_logs').createIndex({ runId: 1, createdAt: 1 });
  await db.collection('payment_attempts').createIndex({ runId: 1, createdAt: 1 });
  // Latest-attempt lookups for the delayed-recovery check and reconciliation.
  await db.collection('payment_attempts').createIndex({ subscriptionId: 1, attempt: -1 });
  await db.collection('retry_jobs').createIndex({ status: 1, nextRetryAt: 1 });
  // Stale-claim reclaim sweeps (jobs whose worker died mid-flight).
  await db.collection('retry_jobs').createIndex({ claimedAt: 1 });

  // Seed plans (idempotent)
  const plans = collections(db).plans;
  const count = await plans.countDocuments();
  if (count === 0) {
    await plans.insertMany([
      { _id: 'price_pro_monthly', planName: 'Pro', amount: 1900, currency: 'usd', interval: 'month' },
      { _id: 'price_team_monthly', planName: 'Team', amount: 4900, currency: 'usd', interval: 'month' },
      { _id: 'price_enterprise_monthly', planName: 'Enterprise', amount: 9900, currency: 'usd', interval: 'month' },
    ]);
  }
  // Default flags (string ids, same as plans)
  const flags = collections(db).flags;
  await flags.updateOne(
    { _id: 'db_failure' },
    { $setOnInsert: { enabled: false, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

export async function getDb(): Promise<Db> {
  if (globalStore.__sp_db) return globalStore.__sp_db;
  globalStore.__sp_db = (async () => {
    await ensureMongodRunning();
    await ensureReplicaSet();
    const uri = `mongodb://127.0.0.1:${MONGO_PORT}/${DB_NAME}?replicaSet=${REPLSET}`;
    const client = globalStore.__sp_client ?? new MongoClient(uri, { maxPoolSize: 20 });
    globalStore.__sp_client = client;
    await client.connect();
    const db = client.db(DB_NAME);
    await ensureSchema(db);
    return db;
  })();
  // Do not cache a rejected bootstrap — allow retry on next request.
  globalStore.__sp_db.catch(() => { globalStore.__sp_db = undefined; });
  return globalStore.__sp_db;
}

export async function mongoHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const db = await getDb();
    const build = await db.admin().buildInfo();
    return { ok: true, version: build.version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Atomic counter for deterministic Stripe-style object ids. */
export async function nextSeq(name: string): Promise<number> {
  const db = await getDb();
  const counters = collections(db).counters;
  const r = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return r?.seq ?? 1;
}

export async function getFlag(name: string): Promise<boolean> {
  const db = await getDb();
  const flags = db.collection<{ _id: string; enabled: boolean; updatedAt: string }>('flags');
  const doc = await flags.findOne({ _id: name });
  return Boolean(doc?.enabled);
}

export async function setFlag(name: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  const flags = db.collection<{ _id: string; enabled: boolean; updatedAt: string }>('flags');
  await flags.updateOne(
    { _id: name },
    { $set: { enabled, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

/**
 * Tiny key/value store for operational settings that must survive a restart
 * (today: the dashboard's gateway mode choice). String ids, JSON values.
 */
export async function getSetting<T>(key: string): Promise<T | null> {
  const db = await getDb();
  const doc = await db.collection<{ _id: string; value: T }>('app_settings').findOne({ _id: key });
  return doc?.value ?? null;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDb();
  await db
    .collection<{ _id: string; value: T }>('app_settings')
    .updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}

/** Shape of a webhook_events row — typed so update filters/operators check. */
export interface EventRecord {
  _id: string;
  eventId: string;
  runId?: string;
  type: string;
  payloadRaw: string;
  status: 'processing' | 'processed' | 'failed' | 'duplicate' | 'received' | 'dead';
  attempts: number;
  signatureVerified: boolean;
  signatureScheme?: 'stripe-sdk' | 'sim-hmac';
  deliveries: { at: string; httpStatus: number; duplicate: boolean; mirrored?: boolean; manual?: boolean }[];
  claimExpiresAt?: string;
  lastError?: string;
  nextRetryAt?: string;
  deadAt?: string;
  processedAt?: string;
  createdAt: string;
}

/** Every domain collection uses string ids (run_x, evt_x, in_x…), never ObjectId. */
type StrDoc = { _id: string } & Record<string, any>;

export function collections(db: Db) {
  return {
    runs: db.collection<StrDoc>('runs'),
    steps: db.collection<StrDoc>('run_steps'),
    events: db.collection<EventRecord>('webhook_events'),
    apiLogs: db.collection<StrDoc>('api_logs'),
    dbLogs: db.collection<StrDoc>('db_logs'),
    attempts: db.collection<StrDoc>('payment_attempts'),
    subscriptions: db.collection<StrDoc>('subscriptions'),
    customers: db.collection<StrDoc>('customers'),
    retryJobs: db.collection<StrDoc>('retry_jobs'),
    plans: db.collection<{ _id: string; planName: string; amount: number; currency: string; interval: string }>('plans'),
    flags: db.collection<{ _id: string; enabled: boolean; updatedAt: string }>('flags'),
    counters: db.collection<{ _id: string; seq: number }>('counters'),
  };
}
