import { startCancelRun, startCancelReversalRun } from '@/lib/stripepulse/runner';
import { guardDemoRequest } from '@/lib/stripepulse/guard';

export const dynamic = 'force-dynamic';

/**
 * Cancel a subscription through the real webhook pipeline.
 *
 * Body variants (all optional fields):
 *   {}                                  → immediate cancellation of the latest active subscription
 *   { subscriptionId }                  → cancel that subscription immediately
 *   { subscriptionId, atPeriodEnd: true }   → schedule cancellation for the end of the
 *                                             current billing period (Stripe keeps the
 *                                             subscription active until then)
 *   { subscriptionId, action: 'reverse' }   → reverse a pending period-end cancellation
 */
export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'scenario', limit: 30, windowMs: 60_000 });
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      subscriptionId?: unknown;
      atPeriodEnd?: unknown;
      action?: unknown;
    };

    if (body.subscriptionId !== undefined && typeof body.subscriptionId !== 'string') {
      return Response.json({ error: 'subscriptionId must be a string' }, { status: 400 });
    }
    if (body.atPeriodEnd !== undefined && typeof body.atPeriodEnd !== 'boolean') {
      return Response.json({ error: 'atPeriodEnd must be a boolean' }, { status: 400 });
    }
    if (body.action !== undefined && body.action !== 'reverse') {
      return Response.json({ error: "action must be 'reverse' if provided" }, { status: 400 });
    }

    if (body.action === 'reverse') {
      const result = await startCancelReversalRun({ subscriptionId: body.subscriptionId });
      return Response.json({ ...result, atPeriodEnd: false, reversed: true }, { status: 201 });
    }

    const result = await startCancelRun({
      subscriptionId: body.subscriptionId,
      atPeriodEnd: body.atPeriodEnd === true,
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to cancel subscription';
    // Cancelling something that is already cancelled is a client mistake,
    // not a server fault — answer 409 Conflict instead of a raw 500
    // (QA finding LOW-4).
    if (message.includes('already canceled') || message.includes('already scheduled to cancel')) {
      return Response.json({ error: message }, { status: 409 });
    }
    if (message.includes('No subscription with a pending')) {
      return Response.json({ error: message }, { status: 409 });
    }
    // Cancellation blocked by the DB-failure injection: the write truly did
    // not happen and the service is temporarily unable to finish — 503 with
    // the run id so the operator can inspect it (QA finding INFO-5).
    if (message.startsWith('Cancellation did not commit') || message.includes('did not commit')) {
      return Response.json({ error: message, runId: /run (\S+)/.exec(message)?.[1] }, { status: 503 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
