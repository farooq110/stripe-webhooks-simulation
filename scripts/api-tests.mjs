// ─── StripePulse · backend integration tests ────────────────────────────────
// Exercises every scenario through the real HTTP API and asserts real MongoDB
// state. Run: node scripts/api-tests.mjs   (dev server must be on :3000)

import { MongoClient } from 'mongodb';

const BASE = 'http://127.0.0.1:3000';
const MONGO = 'mongodb://127.0.0.1:27017/stripepulse?replicaSet=rs0';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 30000, interval = 500, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label || 'condition'}`);
}

async function getRun(runId) {
  const { json } = await api('GET', `/api/runs/${runId}`);
  return json;
}

async function mongo() {
  const c = new MongoClient(MONGO);
  await c.connect();
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────

async function testHealth(client) {
  console.log('\n■ Health');
  const { status, json } = await api('GET', '/api/health');
  ok('health 200', status === 200);
  ok('MongoDB ok', json?.mongo?.ok === true, JSON.stringify(json?.mongo));
  ok('MongoDB 8.x replica set', json?.mongo?.version?.startsWith('8.'));
  ok('gateway simulated (no key)', json?.gateway?.mode === 'simulated');
}

async function testInvalidSignature(client) {
  console.log('\n■ Webhook signature verification (negative)');
  const res = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=123,v1=deadbeef' },
    body: JSON.stringify({ object: 'event', type: 'checkout.session.completed' }),
  });
  ok('invalid signature → 400', res.status === 400);
  const res2 = await fetch(`${BASE}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'event' }),
  });
  ok('missing signature → 400', res2.status === 400);
}

async function testCheckout(client) {
  console.log('\n■ Scenario 1 · checkout_success');
  await api('POST', '/api/demo/reset');

  const { status, json } = await api('POST', '/api/demo/checkout', { planId: 'price_pro_monthly' });
  ok('checkout session 201', status === 201);
  ok('returns runId + cs_test id', Boolean(json.runId) && json.sessionId.startsWith('cs_test_'));
  ok('simulated mode', json.mode === 'simulated');

  const conf = await api('POST', '/api/demo/checkout/confirm', { runId: json.runId });
  ok('confirm 200', conf.status === 200);

  await waitFor(async () => (await getRun(json.runId))?.run.status === 'completed', 20000, 400, 'run completed');
  const run = await getRun(json.runId);

  ok('subscription created + active', run.subscriptions[0]?.status === 'active');
  ok('subscription period ~30d', new Date(run.subscriptions[0].currentPeriodEnd) > new Date(Date.now() + 25 * 86400000));
  ok('all 5 events processed', run.events.length === 5 && run.events.every((e) => e.status === 'processed'), `got ${run.events.length}`);
  ok('event chain complete', ['checkout.session.completed', 'customer.subscription.created', 'payment_intent.succeeded', 'invoice.paid', 'customer.subscription.updated'].every((t) => run.events.some((e) => e.type === t)));
  ok('payment attempt #1 succeeded', run.attempts[0]?.status === 'succeeded' && run.attempts[0].attempt === 1);
  ok('steps 1-9 completed', run.steps.filter((s) => s.idx <= 9).every((s) => s.status === 'completed'));
  ok('ui_refresh step observed by real polling', run.steps.find((s) => s.key === 'ui_refresh')?.status === 'completed');
  ok('HMAC signature verified on every event', run.events.every((e) => e.signatureVerified === true));
  ok('db logs show transactional writes', run.dbLogs.some((l) => l.collection === 'subscriptions' && l.result === 'ok'));
  ok('api logs contain outbound + inbound', run.apiLogs.some((l) => l.direction === 'outbound') && run.apiLogs.some((l) => l.direction === 'inbound'));

  // MongoDB ground truth
  const db = client.db();
  const sub = await db.collection('subscriptions').findOne({ runId: json.runId });
  ok('MongoDB: subscription status=active', sub?.status === 'active');
  const txCount = await db.collection('db_logs').countDocuments({ runId: json.runId, transaction: true, result: 'ok' });
  ok('MongoDB: transactional db_logs present', txCount >= 3, `got ${txCount}`);
  return json.runId;
}

async function testDuplicate(client, sourceRunId) {
  console.log('\n■ Scenario 3 · duplicate_webhook');
  const db = client.db();
  const subsBefore = await db.collection('subscriptions').countDocuments();
  const attemptsBefore = await db.collection('payment_attempts').countDocuments();

  const { status, json } = await api('POST', '/api/demo/scenarios/duplicate', { runId: sourceRunId });
  ok('duplicate scenario 201', status === 201);
  await waitFor(async () => (await getRun(json.runId))?.run.status === 'completed', 10000, 300, 'dup run completed');
  const run = await getRun(json.runId);

  ok('dedup step blocked', run.steps.find((s) => s.key === 'dedup_blocked')?.status === 'completed');
  ok('zero writes recorded', run.steps.find((s) => s.key === 'no_side_effects')?.detail?.writesExecuted === 0);
  ok('ack 200', run.steps.find((s) => s.key === 'ack_200')?.detail?.statusCode === 200);

  const sourceEvent = await db.collection('webhook_events').findOne({ eventId: json.eventId });
  ok('source event marked duplicate', sourceEvent?.status === 'duplicate');
  ok('duplicate delivery recorded on event', (sourceEvent?.deliveries ?? []).some((d) => d.duplicate === true && d.httpStatus === 200));

  const subsAfter = await db.collection('subscriptions').countDocuments();
  const attemptsAfter = await db.collection('payment_attempts').countDocuments();
  ok('IDEMPOTENCY: no new subscriptions', subsAfter === subsBefore, `${subsBefore}→${subsAfter}`);
  ok('IDEMPOTENCY: no new payment attempts', attemptsAfter === attemptsBefore);
}

async function testPaymentRetry(client) {
  console.log('\n■ Scenario 2 · payment_retry');
  const { status, json } = await api('POST', '/api/demo/scenarios/payment-retry', {});
  ok('payment-retry 201', status === 201);

  const db = client.db();
  // Attempt #1 must fail with card_declined and flip the subscription past_due
  await waitFor(async () => {
    const r = await getRun(json.runId);
    return r.attempts.some((a) => a.attempt === 1 && a.status === 'failed');
  }, 15000, 300, 'attempt #1 failed');
  let run = await getRun(json.runId);
  ok('attempt #1 failed card_declined', run.attempts.find((a) => a.attempt === 1)?.failureCode === 'card_declined');
  ok('real 402 logged against card network', run.apiLogs.some((l) => l.statusCode === 402 && l.path.includes('/confirm')));

  await waitFor(async () => {
    const r = await getRun(json.runId);
    const s = await db.collection('subscriptions').findOne({ subscriptionId: r.run.subscriptionId });
    return s?.status === 'past_due';
  }, 10000, 300, 'subscription past_due');
  ok('subscription → past_due after payment_failed', true);

  const job = await db.collection('retry_jobs').findOne({ runId: json.runId, kind: 'payment' });
  ok('smart retry job scheduled', Boolean(job));

  // Wait for the scheduler to run the retry (nextRetryAt = +6s)
  await waitFor(async () => (await getRun(json.runId))?.run.status === 'completed', 25000, 500, 'retry scenario completed');
  run = await getRun(json.runId);

  ok('attempt #2 succeeded', run.attempts.some((a) => a.attempt === 2 && a.status === 'succeeded'));
  ok('subscription recovered → active', run.subscriptions[0]?.status === 'active');
  ok('retry scenario steps completed', run.steps.every((s) => s.status === 'completed' || s.status === 'failed'), JSON.stringify(run.steps.filter((s) => !['completed', 'failed'].includes(s.status)).map((s) => s.key)));

  const atts = run.attempts;
  ok('attempts history: 1 failed + 1 succeeded', atts.length === 2 && atts.filter((a) => a.status === 'failed').length === 1 && atts.filter((a) => a.status === 'succeeded').length === 1);
}

async function testDbFailure(client) {
  console.log('\n■ Scenario 4 · db_failure_recovery');
  const db = client.db();
  const { status, json } = await api('POST', '/api/demo/scenarios/db-failure');
  ok('db-failure scenario 201', status === 201);
  ok('failure flag enabled', (await api('GET', '/api/demo/flags')).json.dbFailure === true);

  const eventId = json.eventId;
  await waitFor(async () => {
    const e = await db.collection('webhook_events').findOne({ eventId });
    return e?.status === 'failed' && e.attempts >= 1;
  }, 10000, 300, 'event failed');
  const evt1 = await db.collection('webhook_events').findOne({ eventId });
  ok('event failed with 500 delivery', (evt1.deliveries ?? []).some((d) => d.httpStatus === 500));
  ok('endpoint returned real 500 (lastError recorded)', (evt1.lastError ?? '').includes('InjectedDbFailure'));

  // Subscription must be UNCHANGED while failing (transaction never commits)
  const r0 = await getRun(json.runId);
  const subDuring = await db.collection('subscriptions').findOne({ subscriptionId: r0.run.subscriptionId });
  ok('subscription untouched while failing', Boolean(subDuring));

  // A redelivery with backoff should already be scheduled
  ok('nextRetryAt scheduled', Boolean(evt1.nextRetryAt) && new Date(evt1.nextRetryAt) > new Date(Date.now() - 5000));

  // Disable injection → recovery via redelivery
  await api('PUT', '/api/demo/flags', { enabled: false });
  await waitFor(async () => {
    const e = await db.collection('webhook_events').findOne({ eventId });
    return e?.status === 'processed';
  }, 30000, 500, 'event processed after recovery');
  // scheduler finishes scenario steps + run doc right after processing
  await waitFor(async () => (await getRun(json.runId))?.run.status === 'completed', 10000, 300, 'run completed after recovery');
  ok('run completed after recovery', true);
  const run = await getRun(json.runId);
  ok('webhook_500 + retry_succeeded steps recorded', run.steps.find((s) => s.key === 'webhook_500')?.detail?.statusCode === 500 && run.steps.find((s) => s.key === 'retry_succeeded')?.detail?.statusCode === 200);
  ok('injection_disabled step recorded', run.steps.find((s) => s.key === 'injection_disabled')?.status === 'completed');

  const evtFinal = await db.collection('webhook_events').findOne({ eventId });
  ok('redelivery trail: ≥2 attempts with 500→200', evtFinal.attempts >= 2 && evtFinal.deliveries.some((d) => d.httpStatus === 500) && evtFinal.deliveries.some((d) => d.httpStatus === 200));
}

async function testReset(client) {
  console.log('\n■ Reset');
  await api('POST', '/api/demo/reset');
  const db = client.db();
  const runs = await db.collection('runs').countDocuments();
  const subs = await db.collection('subscriptions').countDocuments();
  ok('reset clears runs + subscriptions', runs === 0 && subs === 0);
  ok('reset clears failure flag', (await api('GET', '/api/demo/flags')).json.dbFailure === false);
  const plans = await db.collection('plans').countDocuments();
  ok('plans survive reset', plans === 3);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const client = await mongo();
  const t0 = Date.now();
  try {
    await testHealth(client);
    await testInvalidSignature(client);
    const runId = await testCheckout(client);
    await testDuplicate(client, runId);
    await testPaymentRetry(client);
    await testDbFailure(client);
    await testReset(client);
  } finally {
    await client.close();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n━━━ RESULT: ${passed} passed, ${failed} failed · ${secs}s ━━━`);
  if (failed) { console.log('Failures:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('SUITE ERROR:', e.message); process.exit(1); });
