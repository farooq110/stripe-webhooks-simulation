import { mongoHealth } from '@/lib/stripepulse/mongo';
import { ensureGatewayModeRestored, getGateway } from '@/lib/stripepulse/gateway';
import { ensureScheduler } from '@/lib/stripepulse/scheduler';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureScheduler();
  // Report the mode the dashboard actually chose (persisted), not just the
  // env default — the first request after a restart re-applies it.
  await ensureGatewayModeRestored();
  const mongo = await mongoHealth();
  const gateway = getGateway();
  return Response.json({
    ok: mongo.ok,
    mongo,
    gateway: { mode: gateway.mode, reason: gateway.reason },
    time: new Date().toISOString(),
  });
}
