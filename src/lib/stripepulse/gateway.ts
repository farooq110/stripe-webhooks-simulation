// ─── StripePulse · payment gateway layer ─────────────────────────────────────
// SOLID: the app depends only on the `PaymentGateway` interface.
//  • SimulatedGateway — deterministic local implementation of the Stripe
//    semantics we exercise (checkout sessions, customers, payment intents,
//    invoices, subscriptions) emitting real Stripe-shaped events, signed with
//    the exact Stripe HMAC scheme and delivered over real HTTP.
//  • LiveGateway — genuine Stripe SDK calls (Test Mode) used the moment a
//    STRIPE_SECRET_KEY is configured. Untestable in this sandbox without a
//    key, so it is never claimed as verified here.

import Stripe from 'stripe';
import type { GatewayMode } from './types';
import { getSetting, nextSeq, setSetting } from './mongo';
import { webhookSecret } from './crypto';
import { config } from './config';

/** Key under app_settings where the dashboard's last mode choice is kept. */
const MODE_SETTING_KEY = 'gatewayMode';

/** Shape persisted for the dashboard mode switcher. */
export interface GatewayModeSetting {
  mode: GatewayMode;
  updatedAt: string;
}

export interface StripeEvent {
  id: string;
  object: 'event';
  api_version: string;
  created: number;
  livemode: boolean;
  test_mode_clock?: undefined;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string | null; // null in simulated mode (hosted dialog rendered in-app)
  customer: { customerId: string; email: string; name: string };
  session: Record<string, unknown>;
}

export interface PlanInfo {
  id: string;
  planName: string;
  amount: number;
  currency: string;
}

export interface Gateway {
  readonly mode: GatewayMode;
  readonly reason: string;
  createCustomer(email: string, name: string, runId: string): Promise<string>;
  createCheckoutSession(input: {
    runId: string;
    customer: { customerId: string; email: string; name: string };
    plan: PlanInfo;
  }): Promise<CheckoutSessionResult>;
  /** Verifies a webhook signature and returns the parsed event, or throws. */
  constructWebhookEvent(payloadRaw: string, signature: string): Promise<StripeEvent>;
  /** Live mode only: current subscription state straight from Stripe's API (null if unknown). Used by reconciliation. */
  fetchSubscription?(subscriptionId: string): Promise<Record<string, unknown> | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulated gateway
// ─────────────────────────────────────────────────────────────────────────────

const API_VERSION = '2025-11-17.preview';

async function simId(prefix: string): Promise<string> {
  const seq = await nextSeq(prefix);
  return `${prefix}_test_${String(seq).padStart(3, '0')}${Math.random().toString(36).slice(2, 6)}`;
}

class SimulatedGateway implements Gateway {
  readonly mode: GatewayMode = 'simulated';
  /** Set by buildGateway so the reason stays honest in both situations. */
  reason =
    'No STRIPE_SECRET_KEY configured — deterministic in-process gateway. Add a Test Mode key to .env to activate live Stripe.';

  async createCustomer(email: string, name: string): Promise<string> {
    return simId('cus');
  }

  async createCheckoutSession(input: {
    runId: string;
    customer: { customerId: string; email: string; name: string };
    plan: PlanInfo;
  }): Promise<CheckoutSessionResult> {
    const sessionId = await simId('cs');
    const session = {
      id: sessionId,
      object: 'checkout.session',
      amount_subtotal: input.plan.amount,
      amount_total: input.plan.amount,
      currency: input.plan.currency,
      customer: input.customer.customerId,
      customer_email: input.customer.email,
      livemode: false,
      mode: 'subscription',
      payment_intent: null,
      payment_status: 'unpaid',
      status: 'open',
      submit_type: 'pay',
      url: null,
      line_items: [
        {
          price: {
            id: input.plan.id,
            object: 'price',
            active: true,
            currency: input.plan.currency,
            product: { name: `StripePulse ${input.plan.planName}` },
            recurring: { interval: 'month' },
            unit_amount: input.plan.amount,
            type: 'recurring',
          },
          quantity: 1,
        },
      ],
      metadata: { run_id: input.runId, gateway: 'simulated' },
    };
    return { sessionId, url: null, customer: input.customer, session };
  }

  async constructWebhookEvent(payloadRaw: string): Promise<StripeEvent> {
    // Signature verification happens in the webhook route before parsing.
    const evt = JSON.parse(payloadRaw) as StripeEvent;
    if (evt.object !== 'event' || typeof evt.type !== 'string' || !evt.id) {
      throw new Error('Payload is not a valid Stripe event object');
    }
    return evt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Live gateway (real Stripe SDK · Test Mode)
// ─────────────────────────────────────────────────────────────────────────────

class LiveGateway implements Gateway {
  readonly mode: GatewayMode = 'live';
  readonly reason = 'Live Stripe Test Mode via STRIPE_SECRET_KEY.';
  private stripe: Stripe;
  private whsec: string | undefined;

  constructor(secretKey: string, webhookSecret: string | undefined) {
    // Explicit timeout and retry budget: a hung Stripe API must not hang our
    // webhook pipeline, and transient network errors are retried inside the
    // SDK (with exponential backoff + idempotency keys) before they ever
    // reach our error handling.
    this.stripe = new Stripe(secretKey, {
      timeout: config.stripeTimeoutMs,
      maxNetworkRetries: config.stripeMaxRetries,
    });
    this.whsec = webhookSecret;
  }

  async createCustomer(email: string, name: string): Promise<string> {
    const c = await this.stripe.customers.create({ email, name });
    return c.id;
  }

  async createCheckoutSession(input: {
    runId: string;
    customer: { customerId: string; email: string; name: string };
    plan: PlanInfo;
  }): Promise<CheckoutSessionResult> {
    const appUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customer.customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.plan.currency,
            unit_amount: input.plan.amount,
            recurring: { interval: 'month' },
            product_data: { name: `StripePulse ${input.plan.planName}` },
          },
        },
      ],
      metadata: { run_id: input.runId, gateway: 'live' },
      success_url: `${appUrl}/?checkout=success&run=${input.runId}`,
      cancel_url: `${appUrl}/?checkout=cancel&run=${input.runId}`,
    });
    return {
      sessionId: session.id,
      url: session.url,
      customer: input.customer,
      session: session as unknown as Record<string, unknown>,
    };
  }

  async constructWebhookEvent(payloadRaw: string, signature: string): Promise<StripeEvent> {
    if (!this.whsec) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured for live webhook verification');
    }
    const evt = await this.stripe.webhooks.constructEventAsync(payloadRaw, signature, this.whsec);
    return evt as unknown as StripeEvent;
  }

  async fetchSubscription(subscriptionId: string): Promise<Record<string, unknown> | null> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      return sub as unknown as Record<string, unknown>;
    } catch {
      // Unknown to Stripe (deleted, wrong mode, or API error) — reconciliation
      // treats null as "cannot verify right now", never as a drift signal.
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

const g = globalThis as unknown as {
  __sp_gateway?: Gateway;
  /** Once-per-process restore of the persisted dashboard mode choice. */
  __sp_modeRestore?: Promise<void>;
};

function buildGateway(mode: GatewayMode): Gateway {
  if (mode === 'live') {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('Live mode requires STRIPE_SECRET_KEY in the environment');
    return new LiveGateway(key, process.env.STRIPE_WEBHOOK_SECRET);
  }
  const sim = new SimulatedGateway();
  if (liveModeConfigured()) {
    sim.reason =
      'Simulation selected — a Stripe Test Mode key is loaded; switch to Live in the top bar to call the real API.';
  }
  return sim;
}

export function getGateway(): Gateway {
  if (g.__sp_gateway) return g.__sp_gateway;
  // Boot default, unchanged: STRIPE_GATEWAY_MODE forces a mode, otherwise a
  // classic sk_test_ secret key auto-enables live. A dashboard override (see
  // setGatewayMode / ensureGatewayModeRestored) replaces this afterwards.
  const forced = process.env.STRIPE_GATEWAY_MODE as GatewayMode | undefined;
  const key = process.env.STRIPE_SECRET_KEY;
  if (forced === 'live' || (!forced && key && key.startsWith('sk_test_'))) {
    g.__sp_gateway = buildGateway('live');
  } else {
    g.__sp_gateway = buildGateway('simulated');
  }
  return g.__sp_gateway;
}

/** True when the environment has what a live switch needs (a Stripe secret key). */
export function liveModeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Swap the active gateway at runtime (dashboard mode switcher). Throws for a
 * live switch without a secret key — the API route turns that into a 400.
 */
export function setGatewayMode(mode: GatewayMode): Gateway {
  const next = buildGateway(mode);
  g.__sp_gateway = next;
  return next;
}

/**
 * Re-apply the mode the user last picked on the dashboard, which survives
 * restarts in MongoDB. Runs at most once per process; until the first
 * successful read (or on any failure) the env-based default stays active.
 * A persisted "live" is ignored when the secret key has since been removed.
 */
export function ensureGatewayModeRestored(): Promise<void> {
  if (!g.__sp_modeRestore) {
    g.__sp_modeRestore = (async () => {
      try {
        const saved = await getSetting<GatewayModeSetting>(MODE_SETTING_KEY);
        if (saved && (saved.mode === 'live' || saved.mode === 'simulated')) {
          if (saved.mode === 'live' && !liveModeConfigured()) return;
          setGatewayMode(saved.mode);
        }
      } catch {
        // Mongo not reachable (yet) or settings missing — keep env default.
      }
    })();
  }
  return g.__sp_modeRestore;
}

/** Persist the dashboard's mode choice so it survives a restart. */
export async function persistGatewayMode(mode: GatewayMode): Promise<void> {
  await setSetting<GatewayModeSetting>(MODE_SETTING_KEY, {
    mode,
    updatedAt: new Date().toISOString(),
  });
}

/** The persisted dashboard choice, if any (null until someone switched). */
export function readGatewayModeSetting(): Promise<GatewayModeSetting | null> {
  return getSetting<GatewayModeSetting>(MODE_SETTING_KEY);
}

export { webhookSecret, API_VERSION, simId };
export const webhookHeaderName = 'Stripe-Signature';
