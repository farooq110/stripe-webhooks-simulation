import { guardDemoRequest } from '@/lib/stripepulse/guard';
import { runReconciliation, lastReconciliation } from '@/lib/stripepulse/reconciler';
import { getGateway } from '@/lib/stripepulse/gateway';

export const dynamic = 'force-dynamic';

/**
 * Stripe ↔ MongoDB reconciliation.
 *
 * GET — the report of the last reconciliation the scheduler ran (if any).
 * POST — run one now, get the full report: subscriptions checked, drift
 * detected, repairs applied. Repairs only ever correct subscription status /
 * cancellation flags from the source of truth (Stripe API in live mode, the
 * processed event log in simulated mode) and are logged for audit.
 */
export async function GET(req: Request) {
  const denied = guardDemoRequest(req, { name: 'reconcile', limit: 30, windowMs: 60_000 });
  if (denied) return denied;
  const last = lastReconciliation();
  return Response.json({
    gatewayMode: getGateway().mode,
    lastRun: last ?? null,
    hint: 'POST to run a reconciliation now',
  });
}

export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'reconcile', limit: 10, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const report = await runReconciliation();
    return Response.json({ ok: true, report });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : 'reconciliation failed' },
      { status: 500 },
    );
  }
}
