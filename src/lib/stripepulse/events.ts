// ─── StripePulse · Stripe-shaped event builders (simulated gateway) ─────────
// Payloads mirror the real Stripe webhook objects field-for-field for the
// parts our pipeline consumes.

import { API_VERSION, simId, type StripeEvent } from './gateway';

export function buildEvent(type: string, object: Record<string, unknown>): Promise<StripeEvent> {
  return simId('evt').then((id) => ({
    id,
    object: 'event',
    api_version: API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  }));
}

export interface SubMeta {
  runId: string;
  subscriptionId: string;
  customerId: string;
  customerEmail: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
}

export function subFields(m: SubMeta, status: string, periodStartIso: string, periodEndIso: string) {
  return {
    id: m.subscriptionId,
    object: 'subscription',
    application: null,
    cancel_at_period_end: false,
    canceled_at: null,
    created: Math.floor(Date.now() / 1000),
    current_period_start: Math.floor(new Date(periodStartIso).getTime() / 1000),
    current_period_end: Math.floor(new Date(periodEndIso).getTime() / 1000),
    customer: m.customerId,
    days_until_due: null,
    livemode: false,
    latest_invoice: null,
    status,
    items: {
      object: 'list',
      data: [
        {
          price: {
            id: m.planId,
            object: 'price',
            currency: m.currency,
            product: { name: `StripePulse ${m.planName}` },
            recurring: { interval: 'month' },
            unit_amount: m.amount,
            type: 'recurring',
          },
          quantity: 1,
        },
      ],
    },
    metadata: {
      run_id: m.runId,
      customer_id: m.customerId,
      customer_email: m.customerEmail,
      price_id: m.planId,
      plan_name: m.planName,
      amount: String(m.amount),
      currency: m.currency,
    },
  };
}

export function subMetaFromSession(session: Record<string, unknown>): SubMeta {
  const md = (session.metadata ?? {}) as Record<string, string>;
  return {
    runId: md.run_id,
    subscriptionId: session.subscription as string,
    customerId: md.customer_id,
    customerEmail: md.customer_email,
    planId: md.price_id,
    planName: md.plan_name,
    amount: Number(md.amount),
    currency: md.currency,
  };
}

export function subscriptionCreated(m: SubMeta, trialDays: number) {
  const start = new Date();
  const end = new Date(Date.now() + trialDays * 86_400_000);
  return buildEvent('customer.subscription.created', subFields(m, 'trialing', start.toISOString(), end.toISOString()));
}

export function subscriptionUpdated(m: SubMeta, status: string, periodEndIso: string) {
  const start = new Date().toISOString();
  return buildEvent('customer.subscription.updated', subFields(m, status, start, periodEndIso));
}

export function subscriptionDeleted(m: SubMeta, periodStartIso: string, periodEndIso: string) {
  const base = subFields(m, 'canceled', periodStartIso, periodEndIso);
  return buildEvent('customer.subscription.deleted', {
    ...base,
    cancel_at_period_end: false,
    canceled_at: Math.floor(Date.now() / 1000),
    ended_at: Math.floor(Date.now() / 1000),
  });
}

// ── Cancellation lifecycle (Stripe semantics) ────────────────────────────────
// Stripe does not cancel immediately when a user asks for period-end
// cancellation. It keeps the subscription 'active', sets
// cancel_at_period_end=true (plus cancel_at) and emits
// customer.subscription.updated. At the end of the period it emits
// customer.subscription.deleted. If the customer changes their mind, another
// updated event flips cancel_at_period_end back to false and clears
// cancel_at/canceled_at.

/** The operator scheduled a cancellation for the end of the current period. */
export function subscriptionCancelScheduled(
  m: SubMeta,
  periodStartIso: string,
  periodEndIso: string,
) {
  const base = subFields(m, 'active', periodStartIso, periodEndIso);
  return buildEvent('customer.subscription.updated', {
    ...base,
    cancel_at_period_end: true,
    cancel_at: Math.floor(new Date(periodEndIso).getTime() / 1000),
    canceled_at: Math.floor(Date.now() / 1000),
  });
}

/** The operator reversed a pending period-end cancellation. */
export function subscriptionCancelReversed(
  m: SubMeta,
  periodStartIso: string,
  periodEndIso: string,
) {
  const base = subFields(m, 'active', periodStartIso, periodEndIso);
  return buildEvent('customer.subscription.updated', {
    ...base,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
  });
}

export function invoiceObject(m: SubMeta, opts: {
  invoiceId: string;
  paymentIntentId: string;
  attempt: number;
  paid: boolean;
  failure?: { code: string; message: string };
  amount: number;
  periodEndIso: string;
}) {
  return {
    id: opts.invoiceId,
    object: 'invoice',
    amount_due: opts.amount,
    amount_paid: opts.paid ? opts.amount : 0,
    attempt_count: opts.attempt,
    billing_reason: 'subscription_cycle',
    currency: m.currency,
    customer: m.customerId,
    customer_email: m.customerEmail,
    livemode: false,
    payment_intent: opts.paymentIntentId,
    status: opts.paid ? 'paid' : 'open',
    subscription: m.subscriptionId,
    total: opts.amount,
    created: Math.floor(Date.now() / 1000),
    period_end: Math.floor(new Date(opts.periodEndIso).getTime() / 1000),
    last_finalization_error: null,
    ...(opts.paid
      ? {}
      : {
          attempt: opts.attempt,
          last_payment_error: {
            code: opts.failure?.code ?? 'card_declined',
            message: opts.failure?.message ?? 'Your card was declined.',
            payment_intent: { id: opts.paymentIntentId, status: 'requires_payment_method' },
          },
        }),
    metadata: {
      run_id: m.runId,
      subscription_id: m.subscriptionId,
      customer_id: m.customerId,
      customer_email: m.customerEmail,
      price_id: m.planId,
      plan_name: m.planName,
      amount: String(opts.amount),
      currency: m.currency,
      attempt: String(opts.attempt),
      payment_intent_id: opts.paymentIntentId,
    },
  };
}

export function invoicePaymentFailed(m: SubMeta, opts: {
  invoiceId: string;
  paymentIntentId: string;
  attempt: number;
  amount: number;
  periodEndIso: string;
  failure: { code: string; message: string };
}) {
  return buildEvent('invoice.payment_failed', invoiceObject(m, { ...opts, paid: false }));
}

export function invoicePaid(m: SubMeta, opts: {
  invoiceId: string;
  paymentIntentId: string;
  attempt: number;
  amount: number;
  periodEndIso: string;
}) {
  return buildEvent('invoice.paid', invoiceObject(m, { ...opts, paid: true }));
}

export function paymentIntentSucceeded(m: SubMeta, paymentIntentId: string, amount: number) {
  return buildEvent('payment_intent.succeeded', {
    id: paymentIntentId,
    object: 'payment_intent',
    amount,
    currency: m.currency,
    customer: m.customerId,
    livemode: false,
    status: 'succeeded',
    metadata: { run_id: m.runId, subscription_id: m.subscriptionId },
  });
}
