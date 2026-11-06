// ─── StripePulse · Stripe-style webhook signature utilities ─────────────────
// Implements the exact scheme Stripe uses:
//   Stripe-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256(secret, `${t}.${payload}`)>

import { createHmac, timingSafeEqual } from 'node:crypto';

const WEBHOOK_SECRET =
  process.env.STRIPE_SIM_WEBHOOK_SECRET || 'whsec_sim_5f4dcc3b5aa765d61d8327deb882cf99';

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
