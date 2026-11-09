import type { Document } from 'mongodb';

import { startCheckoutRun } from '@/lib/stripepulse/runner';
import { guardDemoRequest } from '@/lib/stripepulse/guard';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';
import { collections, getDb } from '@/lib/stripepulse/mongo';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'scenario', limit: 30, windowMs: 60_000 });
  if (denied) return denied;
  try {
    ensureScheduler();
    const body = (await req.json().catch(() => ({}))) as {
      planId?: unknown;
      email?: unknown;
      name?: unknown;
    };
    // Payload validation: unknown plan ids are a client mistake — reject with
    // 400 instead of silently falling back to a different plan.
    if (body.planId !== undefined && typeof body.planId !== 'string') {
      return Response.json({ error: 'planId must be a string' }, { status: 400 });
    }
    if (body.planId) {
      const db = await getDb();
      const known = await collections(db).plans.findOne({ _id: body.planId } as Document);
      if (!known) {
        return Response.json({ error: `Unknown planId "${body.planId}"` }, { status: 400 });
      }
    }
    if (body.email !== undefined && typeof body.email !== 'string') {
      return Response.json({ error: 'email must be a string' }, { status: 400 });
    }
    const result = await startCheckoutRun({
      planId: body.planId as string | undefined,
      email: body.email as string | undefined,
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Failed to start checkout' },
      { status: 500 },
    );
  }
}
