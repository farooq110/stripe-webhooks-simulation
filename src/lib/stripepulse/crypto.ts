// ─── StripePulse · Stripe-style webhook signature utilities ─────────────────
// Implements the exact scheme Stripe uses:
//   Stripe-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256(secret, `${t}.${payload}`)>

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// No hardcoded default: a secret baked into a public repo is not a secret.
// If STRIPE_SIM_WEBHOOK_SECRET is set we use it; otherwise we generate one
// that is unique to this server process and lives only in memory. The sim
// dispatcher signs with the same value, so delivery and verification always
// agree inside one process — but nobody outside can forge payloads with a
// value copied from the repository.
const globalStore = globalThis as unknown as { __sp_sim_secret?: string };

function resolveSecret(): string {
  const fromEnv = process.env.STRIPE_SIM_WEBHOOK_SECRET;
  if (fromEnv) return fromEnv;
  if (!globalStore.__sp_sim_secret) {
    globalStore.__sp_sim_secret = `whsec_sim_${randomBytes(32).toString('hex')}`;
  }
  return globalStore.__sp_sim_secret;
}

const WEBHOOK_SECRET = resolveSecret();

export function webhookSecret(): string {
  return WEBHOOK_SECRET;
}

export function signPayload(payload: string, secret = WEBHOOK_SECRET, tsSeconds?: number): string {
  const t = tsSeconds ?? Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

export function verifySignature(
  payload: string,
  header: string | null,
  secret = WEBHOOK_SECRET,
  toleranceSeconds = 300,
): { ok: boolean; reason?: string } {
  if (!header) return { ok: false, reason: 'Missing Stripe-Signature header' };
  const parts = header.split(',').map((p) => p.trim());
  let t = '';
  const v1 = new Set<string>();
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 't') t = v;
    if (k === 'v1') v1.add(v);
  }
  if (!t || v1.size === 0) return { ok: false, reason: 'Malformed Stripe-Signature header' };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'Invalid timestamp' };
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > toleranceSeconds) return { ok: false, reason: `Signature timestamp outside tolerance (${age}s)` };

  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  for (const candidate of v1) {
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  }
  return { ok: false, reason: 'Signature mismatch (HMAC-SHA256)' };
}
