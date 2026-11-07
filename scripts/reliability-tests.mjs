// ─── StripePulse · reliability regression suite ─────────────────────────────
// Re-implements the repro steps from the QA report so every fixed bug stays
// fixed. Run: node scripts/reliability-tests.mjs   (dev server must be running)
//
// Needs STRIPE_SIM_WEBHOOK_SECRET in .env to sign webhook payloads — the same
// value the server uses. If it is not set, the server generates a random one
// per process and this script cannot sign valid payloads on purpose.

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const BASE = 'http://127.0.0.1:3000';
const MONGO = 'mongodb://127.0.0.1:27017/stripepulse?replicaSet=rs0';

// Load .env without overriding variables already set in the environment.
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env — fine if the variable is exported */ }

const SECRET = process.env.STRIPE_SIM_WEBHOOK_SECRET;
if (!SECRET) {
  console.error('STRIPE_SIM_WEBHOOK_SECRET is not set. Add it to .env so this script');
  console.error('can sign payloads with the same secret the server verifies with.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

async function waitFor(predicate, timeoutMs = 30_000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label || 'condition'}`);
}

function sign(payload, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

async function postWebhook(event, secret = SECRET) {
  const raw = JSON.stringify(event);
  return fetch(`${BASE}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sign(raw, secret) },
    body: raw,
  });
}

const epoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function subscriptionEvent(type, sub, extra = {}) {
  return {
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'event',
    api_version: '2025-11-17.preview',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: {
      object: {
        id: sub.subscriptionId,
        object: 'subscription',
        status: type === 'customer.subscription.deleted' ? 'canceled' : 'active',
        current_period_start: epoch(sub.currentPeriodStart),
        current_period_end: epoch(sub.currentPeriodEnd),
        customer: sub.customerId,
        livemode: false,
        metadata: {
          run_id: sub.runId ?? '',
          customer_id: sub.customerId,
          customer_email: sub.customerEmail,
          price_id: sub.priceId,
          plan_name: sub.planName,
          amount: String(sub.amount),
          currency: sub.currency,
        },
        ...extra,
      },
    },
  };
}

function invoiceEvent(type, sub, { invoiceId, attempt, stale }) {
  const declined = type === 'invoice.payment_failed';
  return {
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'event',
    api_version: '2025-11-17.preview',
    created: stale ? Math.floor(Date.now() / 1000) - 3600 : Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        amount_due: sub.amount,
        amount_paid: declined ? 0 : sub.amount,
        attempt_count: attempt,
        currency: sub.currency,
        customer: sub.customerId,
        subscription: sub.subscriptionId,
        status: declined ? 'open' : 'paid',
        payment_intent: `pi_${randomUUID().slice(0, 12)}`,
        period_end: epoch(sub.currentPeriodEnd),
        ...(declined
          ? { last_payment_error: { code: 'card_declined', message: 'Your card was declined.' } }
          : {}),
        metadata: {
          run_id: sub.runId ?? '',
          subscription_id: sub.subscriptionId,
          customer_id: sub.customerId,
          customer_email: sub.customerEmail,
          price_id: sub.priceId,
          plan_name: sub.planName,
          amount: String(sub.amount),
          currency: sub.currency,
          attempt: String(attempt),
        },
      },
    },
  };
}

async function freshCheckout(client) {
  const { json } = await api('POST', '/api/demo/checkout', {});
  const runId = json.runId;
  await api('POST', '/api/demo/checkout/confirm', { runId });
  const c = client.db().collection('runs');
  await waitFor(async () => (await c.findOne({ _id: runId }))?.status === 'completed', 30_000, 'checkout run');
  const sub = await client.db().collection('subscriptions').findOne({ runId });
  return { runId, sub };
}

const mc = new MongoClient(MONGO);
await mc.connect();
const db = mc.db();

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ Setup');
{
  const { status } = await api('POST', '/api/demo/reset');
  ok('reset ok', status === 200);
  const { status: h } = await api('GET', '/api/health');
  ok('app healthy', h === 200);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ BUG-1 · concurrent first delivery of the same event');
{
  const { runId, sub } = await freshCheckout(mc);
  ok('checkout bootstrap done', Boolean(sub), 'no subscription after checkout');

  // Six parallel deliveries of the SAME brand-new event: one must process,
  // the others must mirror the winner — no 500s, no corrupted outcome.
  const evt = invoiceEvent('invoice.paid', sub, { invoiceId: 'in_race_test', attempt: 1 });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => postWebhook(evt).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))),
  );
  const statuses = results.map((r) => r.status).sort().join(',');
  ok('all six deliveries answered 200', statuses === '200,200,200,200,200,200', statuses);
  const winners = results.filter((r) => r.body.duplicate === false);
  const losers = results.filter((r) => r.body.duplicate === true || r.body.concurrent === true);
  ok('exactly one delivery executed writes', winners.length === 1, JSON.stringify(results.map((r) => r.body)));
  ok('five deliveries were duplicates/concurrent mirrors', losers.length === 5);

  const evtDoc = await db.collection('webhook_events').findOne({ eventId: evt.id });
  // The app's idiom: once a duplicate redelivery is acknowledged the event
  // shows 'duplicate'. The BUG-1 corruption was it ending up 'failed'.
  ok('event ended processed/duplicate (not failed)', evtDoc?.status === 'processed' || evtDoc?.status === 'duplicate', evtDoc?.status);
  const attemptRows = await db.collection('payment_attempts').countDocuments({ invoiceId: 'in_race_test' });
  ok('exactly one payment attempt row written', attemptRows === 1, String(attemptRows));
  void runId;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ BUG-2 · stale event must not regress subscription status');
{
  const sub = await db.collection('subscriptions').findOne({ status: 'active' });
  ok('active subscription available', Boolean(sub));

  const evt = invoiceEvent('invoice.payment_failed', sub, {
    invoiceId: 'in_stale_test', attempt: 9, stale: true,
  });
  const res = await postWebhook(evt);
  const body = await res.json().catch(() => ({}));
  ok('stale delivery acknowledged 200', res.status === 200, JSON.stringify(body));

  const fresh = await db.collection('subscriptions').findOne({ subscriptionId: sub.subscriptionId });
  ok('subscription still active after stale event', fresh?.status === 'active', fresh?.status);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ BUG-3 · event stuck in processing gets reclaimed by the scheduler');
{
  await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: true });
  const sub = await db.collection('subscriptions').findOne({ status: 'active' });
  const evt = subscriptionEvent('customer.subscription.updated', sub);
  const r1 = await postWebhook(evt);
  ok('injected failure → endpoint 500', r1.status === 500, String(r1.status));

  // Simulate a worker crash mid-processing: the claim stays behind with an
  // expired TTL. The scheduler must reclaim it and redeliver.
  await db.collection('webhook_events').updateOne(
    { eventId: evt.id },
    { $set: { status: 'processing', claimExpiresAt: new Date(Date.now() - 1000).toISOString() } },
  );

  const tick1 = await api('POST', '/api/demo/retry-now');
  ok('tick reports reclaimed ≥ 1', (tick1.json?.reclaimed ?? 0) >= 1, JSON.stringify(tick1.json));

  await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: false });
  await api('POST', '/api/demo/retry-now');
  await waitFor(
    async () => (await db.collection('webhook_events').findOne({ eventId: evt.id }))?.status === 'processed',
    10_000,
    'event recovery after reclaim',
  );
  const finalDoc = await db.collection('webhook_events').findOne({ eventId: evt.id });
  ok('reclaimed event eventually processed', finalDoc?.status === 'processed', finalDoc?.status);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ BUG-4 · retry jobs: crash-safe, counted, limited, unpaid terminal state');
{
  await api('PUT', '/api/demo/flags', { flag: 'retry_failure', enabled: true });
  const { json: started } = await api('POST', '/api/demo/scenarios/payment-retry');
  const runId = started?.runId;

  await waitFor(async () => {
    const job = await db.collection('retry_jobs').findOne({ runId });
    return job && (job.status === 'exhausted' || job.status === 'done');
  }, 90_000, 'retry job exhaustion');

  const job = await db.collection('retry_jobs').findOne({ runId });
  ok('job ended exhausted (not silently done)', job?.status === 'exhausted', job?.status);
  ok('job attempts incremented to the limit', job?.attempts >= 3, String(job?.attempts));

  // The job is marked exhausted before the final unpaid event finishes its
  // HTTP dispatch — wait for the subscription transition itself.
  await waitFor(
    async () => (await db.collection('subscriptions').findOne({ subscriptionId: job.subscriptionId }))?.status === 'unpaid',
    15_000,
    'subscription → unpaid',
  );
  const sub = await db.collection('subscriptions').findOne({ subscriptionId: job.subscriptionId });
  ok('subscription ended unpaid (terminal state)', sub?.status === 'unpaid', sub?.status);

  const run = await db.collection('runs').findOne({ _id: runId });
  ok('run honestly recorded as failed', run?.status === 'failed', run?.status);
  await api('PUT', '/api/demo/flags', { flag: 'retry_failure', enabled: false });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ BUG-5 · old public secret can no longer forge webhooks');
{
  const OLD_PUBLIC_SECRET = 'whsec_sim_5f4dcc3b5aa765d61d8327deb882cf99';
  const evt = subscriptionEvent('customer.subscription.updated',
    await db.collection('subscriptions').findOne({}) ?? { subscriptionId: 'sub_none' });
  const forged = await postWebhook(evt, OLD_PUBLIC_SECRET);
  ok('payload signed with the old public secret → 400', forged.status === 400, String(forged.status));

  const legit = await postWebhook({ ...evt, id: `evt_${randomUUID().slice(0, 20)}` });
  ok('correctly signed payload still accepted', legit.status === 200, String(legit.status));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ Missing feature · cancel subscription through the real pipeline');
{
  const { status, json } = await api('POST', '/api/demo/cancel', {});
  ok('cancel endpoint started a run', status === 201, JSON.stringify(json));
  const runId = json?.runId;
  await waitFor(async () => (await db.collection('runs').findOne({ _id: runId }))?.status === 'completed', 30_000, 'cancel run');

  const run = await db.collection('runs').findOne({ _id: runId });
  ok('cancel run completed', run?.scenario === 'cancel_subscription' && run?.status === 'completed', run?.status);

  const sub = await db.collection('subscriptions').findOne({ subscriptionId: json.subscriptionId });
  ok('subscription status is canceled', sub?.status === 'canceled', sub?.status);
  ok('canceledAt recorded', Boolean(sub?.canceledAt));

  const evtDoc = await db.collection('webhook_events').findOne({ runId, type: 'customer.subscription.deleted' });
  ok('customer.subscription.deleted processed with valid signature', evtDoc?.status === 'processed' && evtDoc?.signatureVerified === true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n■ BUG-6 · reset endpoint is rate limited');
{
  // The limit for reset is 5/minute. Fire 7 and expect the tail to be 429s.
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await api('POST', '/api/demo/reset'));
  const tooMany = results.filter((r) => r.status === 429).length;
  ok('reset rate limit kicked in (≥2× 429)', tooMany >= 2, results.map((r) => r.status).join(','));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n━━━ RESULT: ${passed} passed, ${failed} failed ━━━`);
if (failures.length) {
  console.log('Failed checks:');
  for (const f of failures) console.log(`  - ${f}`);
}
await mc.close();
process.exit(failed ? 1 : 0);
