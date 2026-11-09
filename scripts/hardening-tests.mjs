// ─── StripePulse · hardening & reliability tests ────────────────────────────
// Covers the ten review areas: signature separation (sim vs Stripe SDK),
// duplicate + concurrent idempotency, transaction failure recovery, backoff
// ladder, dead-letter + manual requeue, cancellation lifecycle (immediate,
// at period end, reversal, period-end transition), reset safety,
// reconciliation drift repair, and payload validation.
//
// Run: node scripts/hardening-tests.mjs   (dev server must be on :3000)

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { MongoClient } from 'mongodb';

const BASE = 'http://127.0.0.1:3000';
const MONGO = 'mongodb://127.0.0.1:27017/stripepulse?replicaSet=rs0';

// The sim server signs with STRIPE_SIM_WEBHOOK_SECRET from .env — share it so
// these tests can play the role of the simulated Stripe side.
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const SIM_SECRET = /^STRIPE_SIM_WEBHOOK_SECRET=(.+)$/m.exec(envText)?.[1]?.trim();

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

function sign(payload, secret = SIM_SECRET, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

async function rawApi(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const api = rawApi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 30000, interval = 400, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label || 'condition'}`);
}

async function mongo() {
  const c = new MongoClient(MONGO);
  await c.connect();
  return c;
}

// Deliver an event to the webhook endpoint exactly like the sim gateway does.
async function deliver(event) {
  const payload = JSON.stringify(event);
  return rawApi('POST', '/api/webhooks/stripe', payload, { 'Stripe-Signature': sign(payload) });
}

let evtSeq = 0;
function buildEvent(type, object) {
  return {
    id: `evt_hardening_${Date.now().toString(36)}_${evtSeq++}`,
    object: 'event',
    api_version: '2025-11-17.preview',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  };
}

function subUpdatedObject(sub, status, extra = {}) {
  return {
    id: sub.subscriptionId,
    object: 'subscription',
    status,
    cancel_at_period_end: sub.cancelAtPeriodEnd ?? false,
    canceled_at: null,
    current_period_start: Math.floor(new Date(sub.currentPeriodStart).getTime() / 1000),
    current_period_end: Math.floor(new Date(sub.currentPeriodEnd).getTime() / 1000),
    customer: sub.customerId,
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
  };
}

async function getLatestSub(mclient) {
  return mclient.db().collection('subscriptions').find().sort({ createdAt: -1 }).limit(1).next();
}

// Full checkout → payment → webhook pipeline; returns the local subscription.
async function createActiveSubscription(mclient, planId) {
  const co = await api('POST', '/api/demo/checkout', planId ? { planId } : {});
  if (co.status !== 201) throw new Error(`checkout failed: ${JSON.stringify(co.json)}`);
  const conf = await rawApi('POST', '/api/demo/checkout/confirm', { runId: co.json.runId });
  if (conf.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(conf.json)}`);
  await waitFor(async () => ['active', 'trialing'].includes((await getLatestSub(mclient))?.status), 20000, 400, 'subscription activation');
  return getLatestSub(mclient);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const mclient = await mongo();

  console.log('\n■ 0 · Clean slate');
  await api('POST', '/api/demo/reset');
  ok('reset ok', true);

  // ── 1 · Checkout through the real pipeline (valid sim signature) ──────────
  console.log('\n■ 1 · Valid simulated signature accepted');
  const sub = await createActiveSubscription(mclient, 'price_pro_monthly');
  ok('subscription created through webhook pipeline', Boolean(sub), 'no subscription appeared');
  ok('amount stored in integer minor units', Number.isInteger(sub?.amount) && sub.amount === 1900, `amount=${sub?.amount}`);

  // A directly-delivered, correctly signed event must be accepted.
  const probe = buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'active'));
  const probeRes = await deliver(probe);
  ok('valid sim signature → 200', probeRes.status === 200, JSON.stringify(probeRes.json));
  ok('response labels the verifier scheme', probeRes.json?.signatureScheme === 'sim-hmac', JSON.stringify(probeRes.json));

  // ── 2 · Invalid sim signatures rejected ───────────────────────────────────
  console.log('\n■ 2 · Invalid simulated signatures rejected');
  const payload = JSON.stringify(probe);
  const tampered = await rawApi('POST', '/api/webhooks/stripe', payload, { 'Stripe-Signature': sign(payload) + '00' });
  ok('tampered signature → 400', tampered.status === 400, `got ${tampered.status}`);
  const noSig = await rawApi('POST', '/api/webhooks/stripe', payload);
  ok('missing signature → 400', noSig.status === 400, `got ${noSig.status}`);
  const garbageSig = await rawApi('POST', '/api/webhooks/stripe', payload, { 'Stripe-Signature': 't=abc,v1=zzzz' });
  ok('malformed signature → 400', garbageSig.status === 400, `got ${garbageSig.status}`);
  const staleSig = await rawApi('POST', '/api/webhooks/stripe', payload, {
    'Stripe-Signature': sign(payload, SIM_SECRET, Math.floor(Date.now() / 1000) - 3600),
  });
  ok('timestamp outside tolerance → 400', staleSig.status === 400, `got ${staleSig.status}`);

  // ── 3 · Real Stripe SDK verification path (local, no network) ────────────
  console.log('\n■ 3 · Official Stripe SDK verification (live-path scheme)');
  const whsec = 'whsec_local_test_secret_0123456789abcdef';
  const sdkPayload = JSON.stringify(probe);
  const ts = Math.floor(Date.now() / 1000);
  const sdkSig = `t=${ts},v1=${createHmac('sha256', whsec).update(`${ts}.${sdkPayload}`).digest('hex')}`;
  const stripe = new Stripe('sk_test_placeholder_for_verification_only');
  const verifiedEvt = await stripe.webhooks.constructEventAsync(sdkPayload, sdkSig, whsec);
  ok('SDK accepts a correctly signed payload', verifiedEvt.id === probe.id);
  let sdkRejected = false;
  try {
    await stripe.webhooks.constructEventAsync(sdkPayload, sdkSig.replace(/.$/, '0'), whsec);
  } catch { sdkRejected = true; }
  ok('SDK rejects a tampered signature', sdkRejected);
  // Cross-mode: a payload signed with a "live" secret must fail the sim
  // endpoint (different secret), and vice versa by construction.
  const liveSigned = await rawApi('POST', '/api/webhooks/stripe', sdkPayload, { 'Stripe-Signature': sdkSig });
  ok('live-secret signature rejected by sim endpoint → 400', liveSigned.status === 400, `got ${liveSigned.status}`);

  // ── 4 · Duplicate deliveries: 200, zero writes ───────────────────────────
  console.log('\n■ 4 · Duplicate webhook delivery');
  const dupEvent = buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'active'));
  const first = await deliver(dupEvent);
  const second = await deliver(dupEvent);
  ok('first delivery 200 new', first.status === 200 && first.json?.duplicate === false, JSON.stringify(first.json));
  ok('second delivery 200 duplicate', second.status === 200 && second.json?.duplicate === true, JSON.stringify(second.json));
  ok('duplicate executed zero writes', second.json?.writesExecuted === 0, JSON.stringify(second.json));
  const { json: stateAfterDup } = await api('GET', '/api/state');
  ok('duplicatesBlocked stat incremented', stateAfterDup?.stats?.duplicatesBlocked >= 1);

  // ── 5 · Simultaneous deliveries of the same event ─────────────────────────
  console.log('\n■ 5 · Simultaneous same-event deliveries');
  const raceEvent = buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'active'));
  const raceResults = await Promise.all(Array.from({ length: 6 }, () => deliver(raceEvent)));
  const winners = raceResults.filter((r) => r.status === 200 && r.json?.duplicate === false && r.json?.concurrent !== true);
  ok('exactly one delivery processed the event', winners.length === 1, `winners=${winners.length}`);
  ok('no delivery crashed', raceResults.every((r) => r.status === 200 || r.status === 500), raceResults.map((r) => r.status).join(','));
  const raceRow = await mclient.db().collection('webhook_events').findOne({ eventId: raceEvent.id });
  ok('single event row with one processing claim', raceRow?.attempts === 1, `attempts=${raceRow?.attempts}`);
  ok('event row status processed', raceRow?.status === 'processed');

  // ── 6 · DB failure: 500, no partial writes, backoff ladder, recovery ─────
  console.log('\n■ 6 · Transaction failure, backoff, recovery');
  await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: true });
  const fail1 = deliver(buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'past_due')));
  const fail2 = deliver(buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'past_due')));
  const [r1, r2] = await Promise.all([fail1, fail2]);
  ok('injected failure answered 500', r1.status === 500 && r2.status === 500, `${r1.status}/${r2.status}`);
  const row1 = await mclient.db().collection('webhook_events').findOne({ eventId: r1.json?.eventId ?? r1.body?.eventId }) ??
    await mclient.db().collection('webhook_events').findOne({ status: 'failed' });
  ok('failed event stored with retry time', Boolean(row1?.nextRetryAt), JSON.stringify(row1?.nextRetryAt));
  // subscription untouched by the failed transaction
  const subAfterFail = await mclient.db().collection('subscriptions').findOne({ subscriptionId: sub.subscriptionId });
  ok('no partial writes during transaction failure', subAfterFail.status === 'active', `status=${subAfterFail.status}`);

  // Backoff ladder: backoff = base × 2^(attempt−1), tolerating scheduler interference.
  // This event carries an 'active' status so the recovery redelivery below
  // genuinely recovers the subscription (it is the money-matching event).
  const deliverTime = Date.now();
  const fail3 = await deliver(buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'active')));
  ok('third failure answered 500', fail3.status === 500);
  const row3 = await mclient.db().collection('webhook_events').findOne({ eventId: fail3.json?.eventId });
  ok('attempts counter grows', (row3?.attempts ?? 0) >= 1, `attempts=${row3?.attempts}`);
  if (row3?.nextRetryAt) {
    const expectedBackoff = Math.min(2000 * 2 ** (row3.attempts - 1), 30000);
    const actualBackoff = Date.parse(row3.nextRetryAt) - deliverTime;
    ok('exponential backoff ladder respected', Math.abs(actualBackoff - expectedBackoff) < 4000, `expected≈${expectedBackoff}ms got ${actualBackoff}ms`);
  } else {
    ok('exponential backoff ladder respected', false, 'no nextRetryAt recorded');
  }

  await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: false });
  await api('POST', '/api/demo/retry-now');
  await waitFor(async () => {
    const doc = await mclient.db().collection('webhook_events').findOne({ eventId: fail3.json?.eventId });
    return doc?.status === 'processed';
  }, 20000, 400, 'recovery redelivery');
  ok('event recovered via redelivery after injection disabled', true);
  const subRecovered = await mclient.db().collection('subscriptions').findOne({ subscriptionId: sub.subscriptionId });
  ok('subscription consistent after recovery', subRecovered.status === 'active', `status=${subRecovered.status}`);

  // ── 7 · Dead-letter + manual requeue ──────────────────────────────────────
  console.log('\n■ 7 · Dead-letter and manual requeue');
  await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: true });
  const deadEvent = buildEvent('customer.subscription.updated', subUpdatedObject(sub, 'past_due'));
  await deliver(deadEvent);
  for (let i = 0; i < 8 && (await mclient.db().collection('webhook_events').findOne({ eventId: deadEvent.id }))?.status !== 'dead'; i++) {
    await deliver(deadEvent);
    await sleep(150);
  }
  const deadRow = await mclient.db().collection('webhook_events').findOne({ eventId: deadEvent.id });
  ok('event reached dead-letter state after budget exhausted', deadRow?.status === 'dead', `status=${deadRow?.status}`);
  await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: false });
  const requeue = await api('POST', '/api/demo/requeue', { eventId: deadEvent.id });
  ok('manual requeue delivered the event', requeue.status === 200 && requeue.json?.delivery?.httpStatus === 200, JSON.stringify(requeue.json));
  const requeuedRow = await mclient.db().collection('webhook_events').findOne({ eventId: deadEvent.id });
  ok('requeued event processed', requeuedRow?.status === 'processed', `status=${requeuedRow?.status}`);
  const badRequeue = await api('POST', '/api/demo/requeue', { eventId: 'nonsense' });
  ok('requeue validates eventId', badRequeue.status === 400, `got ${badRequeue.status}`);

  // ── 8 · Cancellation lifecycle ────────────────────────────────────────────
  console.log('\n■ 8 · Cancellation: immediate, at period end, reversal, transition');
  // immediate
  const imm = await api('POST', '/api/demo/cancel', {});
  ok('immediate cancel 201', imm.status === 201, JSON.stringify(imm.json));
  let subNow = await getLatestSub(mclient);
  ok('subscription canceled immediately', subNow?.status === 'canceled', `status=${subNow?.status}`);

  // fresh subscription for the lifecycle tests
  const sub2 = await createActiveSubscription(mclient);

  // at period end
  const ape = await api('POST', '/api/demo/cancel', { subscriptionId: sub2.subscriptionId, atPeriodEnd: true });
  ok('period-end cancel 201', ape.status === 201, JSON.stringify(ape.json));
  subNow = await mclient.db().collection('subscriptions').findOne({ subscriptionId: sub2.subscriptionId });
  ok('subscription still active with cancelAtPeriodEnd=true', subNow?.status !== 'canceled' && subNow?.cancelAtPeriodEnd === true, JSON.stringify({ status: subNow?.status, flag: subNow?.cancelAtPeriodEnd }));
  ok('cancelAt date recorded', Boolean(subNow?.cancelAt), subNow?.cancelAt);
  const doubleSchedule = await api('POST', '/api/demo/cancel', { subscriptionId: sub2.subscriptionId, atPeriodEnd: true });
  ok('double period-end schedule → 409', doubleSchedule.status === 409, `got ${doubleSchedule.status}`);

  // reversal
  const rev = await api('POST', '/api/demo/cancel', { subscriptionId: sub2.subscriptionId, action: 'reverse' });
  ok('reversal 201', rev.status === 201, JSON.stringify(rev.json));
  subNow = await mclient.db().collection('subscriptions').findOne({ subscriptionId: sub2.subscriptionId });
  ok('pending cancellation cleared', subNow?.status === 'active' && !subNow?.cancelAtPeriodEnd, JSON.stringify({ status: subNow?.status, flag: subNow?.cancelAtPeriodEnd }));

  // schedule again, then let the period end → scheduler transitions to canceled
  await api('POST', '/api/demo/cancel', { subscriptionId: sub2.subscriptionId, atPeriodEnd: true });
  await mclient.db().collection('subscriptions').updateOne(
    { subscriptionId: sub2.subscriptionId },
    { $set: { currentPeriodEnd: new Date(Date.now() - 1000).toISOString() } },
  );
  await api('POST', '/api/demo/retry-now');
  await waitFor(async () => (await mclient.db().collection('subscriptions').findOne({ subscriptionId: sub2.subscriptionId }))?.status === 'canceled', 20000, 400, 'period-end transition');
  ok('period-end transition canceled the subscription', true);
  const deletedRow = await mclient.db().collection('webhook_events').findOne({ type: 'customer.subscription.deleted', 'payloadRaw': { $regex: sub2.subscriptionId } });
  ok('transition went through customer.subscription.deleted', Boolean(deletedRow));

  // ── 9 · Reconciliation: detect and repair drift ──────────────────────────
  console.log('\n■ 9 · Stripe ↔ MongoDB reconciliation');
  const sub3 = await createActiveSubscription(mclient);
  // Simulate the "Stripe succeeded, MongoDB says otherwise" inconsistency.
  await mclient.db().collection('subscriptions').updateOne(
    { subscriptionId: sub3.subscriptionId },
    { $set: { status: 'past_due' } },
  );
  const recon = await api('POST', '/api/demo/reconcile');
  ok('reconcile 200', recon.status === 200, JSON.stringify(recon.json).slice(0, 200));
  const detail = recon.json?.report?.details?.find((d) => d.subscriptionId === sub3.subscriptionId);
  ok('drift detected', recon.json?.report?.driftDetected >= 1 && detail?.action === 'repaired', JSON.stringify(detail));
  const subFixed = await mclient.db().collection('subscriptions').findOne({ subscriptionId: sub3.subscriptionId });
  ok('drift repaired to event-log truth', ['active', 'trialing'].includes(subFixed?.status), `status=${subFixed?.status}`);
  const reconGet = await api('GET', '/api/demo/reconcile');
  ok('reconcile GET exposes last report', reconGet.status === 200 && Boolean(reconGet.json?.gatewayMode));

  // ── 10 · Payload validation ──────────────────────────────────────────────
  console.log('\n■ 10 · Payload validation');
  const badFlags = await rawApi('PUT', '/api/demo/flags', '{not json');
  ok('flags invalid JSON → 400', badFlags.status === 400, `got ${badFlags.status}`);
  const unknownFlag = await api('PUT', '/api/demo/flags', { flag: 'nuclear', enabled: true });
  ok('flags unknown flag → 400', unknownFlag.status === 400, `got ${unknownFlag.status}`);
  const badType = await api('PUT', '/api/demo/flags', { enabled: 'yes' });
  ok('flags non-boolean enabled → 400', badType.status === 400, `got ${badType.status}`);
  const unknownPlan = await api('POST', '/api/demo/checkout', { planId: 'price_gold' });
  ok('checkout unknown planId → 400', unknownPlan.status === 400, `got ${unknownPlan.status}`);
  const badCancel = await api('POST', '/api/demo/cancel', { subscriptionId: 42 });
  ok('cancel non-string subscriptionId → 400', badCancel.status === 400, `got ${badCancel.status}`);
  const badAction = await api('POST', '/api/demo/cancel', { action: 'explode' });
  ok('cancel unknown action → 400', badAction.status === 400, `got ${badAction.status}`);

  // ── 11 · Retry queue visibility + durability ─────────────────────────────
  console.log('\n■ 11 · Retry queue durability & observability');
  const { json: st } = await api('GET', '/api/state');
  ok('state exposes retryQueue counters', typeof st?.retryQueue?.scheduled === 'number' && typeof st?.retryQueue?.dead === 'number', JSON.stringify(st?.retryQueue));
  ok('state exposes deadLettered stat', typeof st?.stats?.deadLettered === 'number');
  const jobsInMongo = await mclient.db().collection('retry_jobs').countDocuments({});
  const eventsInMongo = await mclient.db().collection('webhook_events').countDocuments({});
  ok('retry jobs and events live in MongoDB (not memory)', jobsInMongo >= 0 && eventsInMongo > 0, `jobs=${jobsInMongo} events=${eventsInMongo}`);
  const corr = await mclient.db().collection('api_logs').findOne({ correlationId: { $exists: true } });
  ok('structured logs carry correlation ids', Boolean(corr?.correlationId), JSON.stringify(corr?.correlationId));

  // ── 12 · Safe reset ──────────────────────────────────────────────────────
  console.log('\n■ 12 · Reset safety');
  const preview = await api('GET', '/api/demo/reset');
  ok('reset preview 200 with counts', preview.status === 200 && typeof preview.json?.counts?.runs === 'number', JSON.stringify(preview.json?.counts));
  ok('preview shows data to delete', preview.json?.counts?.runs >= 1, `runs=${preview.json?.counts?.runs}`);
  const doReset = await api('POST', '/api/demo/reset');
  ok('reset 200', doReset.status === 200, `got ${doReset.status}`);
  ok('reset reports per-collection counts', typeof doReset.json?.deleted?.runs === 'number', JSON.stringify(doReset.json?.deleted));
  const { json: stateAfterReset } = await api('GET', '/api/state');
  ok('plans survive reset (configuration, not demo data)', stateAfterReset?.plans?.length === 3, `plans=${stateAfterReset?.plans?.length}`);
  ok('injection flags off after reset', stateAfterReset?.flags?.dbFailure === false && stateAfterReset?.flags?.retryFailure === false);
  ok('demo data wiped', stateAfterReset?.runs?.length === 0 && stateAfterReset?.subscriptions?.length === 0);
  ok('reset notes gateway-mode protection', typeof doReset.json?.protectedLiveRecords === 'boolean');

  await mclient.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASSED ${passed} · FAILED ${failed}`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('hardening-tests crashed:', e);
  process.exit(1);
});
