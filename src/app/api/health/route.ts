import { mongoHealth } from '@/lib/stripepulse/mongo';
import { getGateway } from '@/lib/stripepulse/gateway';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureScheduler();
  const mongo = await mongoHealth();
  const gateway = getGateway();
  return Response.json({
    ok: mongo.ok,
    mongo,
    gateway: { mode: gateway.mode, reason: gateway.reason },
    time: new Date().toISOString(),
  });
}
