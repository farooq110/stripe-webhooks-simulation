// ─── StripePulse · shared domain types (server + client) ────────────────────

export type Scenario =
  | 'checkout_success'
  | 'payment_retry'
  | 'duplicate_webhook'
  | 'db_failure_recovery'
  | 'cancel_subscription';

export type GatewayMode = 'simulated' | 'live';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped';

export interface StepDetail {
  [k: string]: unknown;
}

export interface RunStepDoc {
  _id: string;
  runId: string;
  idx: number;
  key: string;
  title: string;
  nodeId: PipelineNodeId;
  status: StepStatus;
  detail?: StepDetail;
  startedAt?: string;
  finishedAt?: string;
}

export type PipelineNodeId =
  | 'checkout'
  | 'stripe-api'
  | 'payment'
  | 'invoice'
  | 'webhook'
  | 'signature'
  | 'dedup'
  | 'db'
  | 'retry-queue'
  | 'subscription'
  | 'dashboard';

export interface RunDoc {
  _id: string;
  scenario: Scenario;
  mode: GatewayMode;
  status: 'running' | 'completed' | 'failed';
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  customerEmail: string;
  customerName: string;
  customerId?: string;
  subscriptionId?: string;
  checkoutSessionId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface WebhookEventDoc {
  _id: string;
  eventId: string;
  runId?: string;
  type: string;
  payloadRaw: string;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'duplicate';
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
  signatureVerified: boolean;
  deliveries: { at: string; httpStatus: number; duplicate: boolean }[];
  createdAt: string;
  processedAt?: string;
}

export interface ApiLogDoc {
  _id: string;
  runId?: string;
  direction: 'outbound' | 'inbound';
  component: string;
  method: string;
  path: string;
  statusCode?: number;
  durationMs?: number;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  createdAt: string;
}

export interface DbLogDoc {
  _id: string;
  runId?: string;
  operation: string;
  collection: string;
  detail: string;
  result: 'ok' | 'failed' | 'read-only';
  transaction: boolean;
  createdAt: string;
}

export interface PaymentAttemptDoc {
  _id: string;
  runId?: string;
  invoiceId: string;
  subscriptionId: string;
  paymentIntentId: string;
  amount: number;
  currency: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  failureCode?: string;
  failureMessage?: string;
  createdAt: string;
}

export interface SubscriptionDoc {
  _id: string;
  runId?: string;
  subscriptionId: string;
  customerId: string;
  customerEmail: string;
  priceId: string;
  planName: string;
  amount: number;
  currency: string;
  interval: string;
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  canceledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDoc {
  _id: string;
  runId?: string;
  customerId: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface RetryJobDoc {
  _id: string;
  kind: 'webhook' | 'payment';
  runId: string;
  eventId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  planId?: string;
  nextRetryAt: string;
  attempts: number;
  status: 'scheduled' | 'running' | 'done' | 'failed' | 'exhausted' | 'canceled';
  claimedAt?: string;
  finishedAt?: string;
  lastError?: string;
  note?: string;
  createdAt: string;
}

export interface PlanDoc {
  _id: string; // price id
  planName: string;
  amount: number;
  currency: string;
  interval: 'month';
}

export interface RunStatePayload {
  run: RunDoc;
  steps: RunStepDoc[];
  events: WebhookEventDoc[];
  apiLogs: ApiLogDoc[];
  dbLogs: DbLogDoc[];
  attempts: PaymentAttemptDoc[];
  subscriptions: SubscriptionDoc[];
}

export interface AppStatePayload {
  gateway: { mode: GatewayMode; reason: string };
  mongo: { ok: boolean; version?: string; error?: string };
  flags: { dbFailure: boolean; retryFailure: boolean };
  plans: PlanDoc[];
  subscriptions: SubscriptionDoc[];
  attempts: PaymentAttemptDoc[];
  recentEvents: WebhookEventDoc[];
  runs: RunDoc[];
  stats: {
    activeSubscriptions: number;
    mrr: number;
    eventsProcessed: number;
    eventsFailed: number;
    duplicatesBlocked: number;
  };
}
