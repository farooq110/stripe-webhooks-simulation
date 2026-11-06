// ─── StripePulse · run step plans ────────────────────────────────────────────
// A run's steps are the plan of the pipeline. Statuses and details are filled
// in by the backend as work actually happens — the client never invents them.

import type { PipelineNodeId } from './types';

export interface StepPlan {
  key: string;
  title: string;
  nodeId: PipelineNodeId;
}

export const STEP_PLANS: Record<string, StepPlan[]> = {
  checkout_success: [
    { key: 'checkout_created', title: 'Checkout session created', nodeId: 'checkout' },
    { key: 'stripe_api_call', title: 'Stripe API · POST /v1/checkout/sessions', nodeId: 'stripe-api' },
    { key: 'checkout_paid', title: 'Customer completed payment', nodeId: 'payment' },
    { key: 'webhook_delivery', title: 'checkout.session.completed delivered', nodeId: 'webhook' },
    { key: 'signature_verified', title: 'Webhook signature verified', nodeId: 'signature' },
    { key: 'dedup_check', title: 'Idempotency guard passed', nodeId: 'dedup' },
    { key: 'db_transaction', title: 'Customer + subscription committed (ACID)', nodeId: 'db' },
    { key: 'invoice_paid', title: 'invoice.paid delivered · attempt #1 succeeded', nodeId: 'invoice' },
    { key: 'subscription_activated', title: 'Subscription trialing → active', nodeId: 'subscription' },
    { key: 'ui_refresh', title: 'Dashboard refreshed via polling', nodeId: 'dashboard' },
  ],
  payment_retry: [
    { key: 'subscription_ready', title: 'Active subscription selected', nodeId: 'subscription' },
    { key: 'invoice_created', title: 'Renewal invoice created', nodeId: 'invoice' },
    { key: 'payment_attempt_1', title: 'Payment attempt #1', nodeId: 'payment' },
    { key: 'webhook_delivery', title: 'invoice.payment_failed delivered', nodeId: 'webhook' },
    { key: 'signature_verified', title: 'Webhook signature verified', nodeId: 'signature' },
    { key: 'dedup_check', title: 'Idempotency guard passed', nodeId: 'dedup' },
    { key: 'db_transaction', title: 'Attempt recorded · subscription → past_due', nodeId: 'db' },
    { key: 'retry_scheduled', title: 'Smart retry scheduled (6s backoff)', nodeId: 'retry-queue' },
    { key: 'payment_attempt_2', title: 'Payment attempt #2', nodeId: 'payment' },
    { key: 'webhook_invoice_paid', title: 'invoice.paid delivered', nodeId: 'webhook' },
    { key: 'db_transaction_2', title: 'Attempt recorded · subscription → active', nodeId: 'db' },
    { key: 'subscription_recovered', title: 'Subscription past_due → active', nodeId: 'subscription' },
    { key: 'ui_refresh', title: 'Dashboard refreshed via polling', nodeId: 'dashboard' },
  ],
  duplicate_webhook: [
    { key: 'duplicate_delivery', title: 'Duplicate event redelivered', nodeId: 'webhook' },
    { key: 'signature_verified', title: 'Webhook signature verified', nodeId: 'signature' },
    { key: 'dedup_blocked', title: 'Duplicate blocked by idempotency guard', nodeId: 'dedup' },
    { key: 'no_side_effects', title: 'Zero writes executed (read-only checks)', nodeId: 'db' },
    { key: 'ack_200', title: 'Acknowledged 200 (prevents retry storm)', nodeId: 'webhook' },
    { key: 'ui_refresh', title: 'Dashboard refreshed via polling', nodeId: 'dashboard' },
  ],
  db_failure_recovery: [
    { key: 'webhook_delivery', title: 'customer.subscription.updated delivered', nodeId: 'webhook' },
    { key: 'signature_verified', title: 'Webhook signature verified', nodeId: 'signature' },
    { key: 'dedup_check', title: 'Idempotency guard passed', nodeId: 'dedup' },
    { key: 'db_transaction', title: 'MongoDB transaction', nodeId: 'db' },
    { key: 'webhook_500', title: 'Endpoint responded 500', nodeId: 'webhook' },
    { key: 'retry_scheduled', title: 'Redelivery scheduled (exponential backoff)', nodeId: 'retry-queue' },
    { key: 'injection_disabled', title: 'Failure injection disabled by operator', nodeId: 'retry-queue' },
    { key: 'retry_succeeded', title: 'Redelivery accepted (200)', nodeId: 'webhook' },
    { key: 'db_transaction_ok', title: 'Transaction committed', nodeId: 'db' },
    { key: 'subscription_updated', title: 'Subscription updated', nodeId: 'subscription' },
    { key: 'ui_refresh', title: 'Dashboard refreshed via polling', nodeId: 'dashboard' },
  ],
};
