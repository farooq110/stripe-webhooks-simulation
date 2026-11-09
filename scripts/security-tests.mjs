// ─── StripePulse · demo endpoint security tests ─────────────────────────────
// Spawns its own dev server with DEMO_API_TOKEN set and verifies that every
// mutating demo endpoint enforces the shared token, that wrong tokens fail,
// that rate limits still apply, and that the webhook endpoint itself stays
// signature-gated (not token-gated), exactly like a real Stripe endpoint.
//
// Run: node scripts/security-tests.mjs
// The dedicated server runs on :3100, so it can never collide with an
// already-running dev server on :3000 (a collision used to make waitHealthy()
// probe the wrong, tokenless server and report nonsense failures).

import { spawn } from 'node:child_process';

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'hardening-token-test-12345';

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
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const authed = { 'x-demo-token': TOKEN };

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log('\n■ Starting dedicated server with DEMO_API_TOKEN set');
  const child = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      DEMO_API_TOKEN: TOKEN,
      STRIPE_SIM_WEBHOOK_SECRET: 'hardening_security_test_secret_0123456789abcdef',
      APP_URL: BASE,
    },
    stdio: 'ignore',
    detached: true,
  });

  try {
    ok('server became healthy', await waitHealthy());

    const mutatingEndpoints = [
      ['POST', '/api/demo/reset', {}],
      ['PUT', '/api/demo/flags', { flag: 'db_failure', enabled: false }],
      ['POST', '/api/demo/checkout', {}],
      ['POST', '/api/demo/cancel', {}],
      ['POST', '/api/demo/retry-now', {}],
      ['POST', '/api/demo/requeue', { eventId: 'evt_x' }],
      ['POST', '/api/demo/reconcile', {}],
    ];

    console.log('\n■ Mutating endpoints reject missing / wrong tokens');
    for (const [method, path, body] of mutatingEndpoints) {
      const noToken = await api(method, path, body);
      ok(`${method} ${path} without token → 401`, noToken.status === 401, `got ${noToken.status}`);
      const wrongToken = await api(method, path, body, { 'x-demo-token': 'wrong-token-value' });
      ok(`${method} ${path} wrong token → 401`, wrongToken.status === 401, `got ${wrongToken.status}`);
    }

    console.log('\n■ Correct token passes through to normal handler behaviour');
    const flags = await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: false }, authed);
    ok('flags PUT with token → 200', flags.status === 200, `got ${flags.status}`);
    const resetGet = await api('GET', '/api/demo/reset', undefined, authed);
    ok('reset preview with token → 200', resetGet.status === 200, `got ${resetGet.status}`);
    const resetPost = await api('POST', '/api/demo/reset', {}, authed);
    ok('reset POST with token → 200', resetPost.status === 200, `got ${resetPost.status}`);
    const tick = await api('POST', '/api/demo/retry-now', {}, authed);
    ok('retry-now with token → 200', tick.status === 200, `got ${tick.status}`);
    const reconcile = await api('POST', '/api/demo/reconcile', {}, authed);
    ok('reconcile with token → 200', reconcile.status === 200, `got ${reconcile.status}`);
    const checkout = await api('POST', '/api/demo/checkout', {}, authed);
    ok('checkout with token → 201', checkout.status === 201, `got ${checkout.status}`);
    const cancel = await api('POST', '/api/demo/cancel', { atPeriodEnd: true }, authed);
    ok('cancel with token → not 401', cancel.status !== 401, `got ${cancel.status}`);

    console.log('\n■ Webhook endpoint is signature-gated, not token-gated');
    const unsigned = await api('POST', '/api/webhooks/stripe', { id: 'evt_x', object: 'event', type: 't' });
    ok('unsigned webhook → 400 (signature, not 401 auth)', unsigned.status === 400, `got ${unsigned.status}`);

    console.log('\n■ Public read endpoints stay open');
    const state = await api('GET', '/api/state');
    ok('GET /api/state → 200 without token', state.status === 200, `got ${state.status}`);
    const health = await api('GET', '/api/health');
    ok('GET /api/health → 200 without token', health.status === 200, `got ${health.status}`);

    console.log('\n■ Rate limits still enforced behind the token');
    let saw429 = false;
    for (let i = 0; i < 35; i++) {
      const res = await api('PUT', '/api/demo/flags', { flag: 'db_failure', enabled: false }, authed);
      if (res.status === 429) { saw429 = true; break; }
    }
    ok('flags rate limit triggers 429', saw429);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await sleep(800);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASSED ${passed} · FAILED ${failed}`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('security-tests crashed:', e);
  process.exit(1);
});
