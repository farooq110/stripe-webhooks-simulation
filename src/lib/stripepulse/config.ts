// ─── StripePulse · operational settings ─────────────────────────────────────
// Every operational knob in one place, all overridable through environment
// variables so deployments can tune retry limits and backoff without code
// changes. Invalid values fall back to the default instead of crashing.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const config = {
  /** How long a webhook-processing claim stays valid before a crashed worker's row can be reclaimed. */
  claimTtlMs: num('WEBHOOK_CLAIM_TTL_MS', 30_000),

  /** How long a concurrent webhook delivery waits for the worker that holds the claim. */
  siblingWaitMs: num('WEBHOOK_SIBLING_WAIT_MS', 12_000),

  /** Signature timestamp tolerance (Stripe uses 5 minutes). */
  signatureToleranceSeconds: num('WEBHOOK_TOLERANCE_SECONDS', 300),

  /** Redeliveries before a webhook event moves to the dead-letter state. */
  maxWebhookRedeliveries: num('WEBHOOK_MAX_REDELIVERIES', 6),

  /** Base delay for the webhook redelivery backoff ladder: base × 2^(attempt−1). */
  webhookBackoffBaseMs: num('WEBHOOK_BACKOFF_BASE_MS', 2_000),

  /** Ceiling for the webhook redelivery backoff ladder. */
  webhookBackoffMaxMs: num('WEBHOOK_BACKOFF_MAX_MS', 30_000),

  /** Smart-retry attempts before a subscription is marked unpaid (dunning). */
  maxPaymentRetries: num('MAX_PAYMENT_RETRIES', 3),

  /** Base delay between dunning attempts (same exponential ladder). */
  paymentRetryBackoffMs: num('PAYMENT_RETRY_BACKOFF_MS', 6_000),

  /** How often the Stripe↔MongoDB reconciliation runs (ms). 0 disables it. */
  reconcileIntervalMs: num('RECONCILE_INTERVAL_MS', 60_000),

  /** Timeout for live Stripe API calls. */
  stripeTimeoutMs: num('STRIPE_API_TIMEOUT_MS', 15_000),

  /** Retries inside the Stripe SDK for transient network errors. */
  stripeMaxRetries: num('STRIPE_API_MAX_RETRIES', 2),
} as const;

export function webhookBackoffMs(attempt: number): number {
  return Math.min(config.webhookBackoffBaseMs * 2 ** Math.max(attempt - 1, 0), config.webhookBackoffMaxMs);
}
