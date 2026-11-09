// ─── Gateway mode switcher API ───────────────────────────────────────────────
// GET  — current active mode + what a live switch would need (key presence,
//        masked secret, publishable key, webhook endpoint path).
// POST — { mode: "simulated" | "live" }. Swaps the active gateway in place,
//        persists the choice in MongoDB (survives restarts), returns the same
//        shape as GET. Guarded like every demo endpoint: optional
//        x-demo-token gate plus per-IP rate limiting, tighter for POST.

import {
  ensureGatewayModeRestored,
  getGateway,
  liveModeConfigured,
  persistGatewayMode,
  readGatewayModeSetting,
  setGatewayMode,
} from '@/lib/stripepulse/gateway';
import type { GatewayModeSetting } from '@/lib/stripepulse/gateway';
import { guardDemoRequest } from '@/lib/stripepulse/guard';
import type { GatewayMode } from '@/lib/stripepulse/types';

export const dynamic = 'force-dynamic';

/** Never echo the secret key — first 10 chars and last 4 only. */
function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  return key.length > 14 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '…';
}

async function modeState(): Promise<{
  mode: GatewayMode;
  reason: string;
  source: 'dashboard' | 'env';
  updatedAt: string | null;
  live: {
    configured: boolean;
    secretKey: string | null;
    webhookSecretConfigured: boolean;
    publishableKey: string | null;
    webhookEndpoint: string;
  };
}> {
  await ensureGatewayModeRestored();
  const gateway = getGateway();
  let saved: GatewayModeSetting | null = null;
  try {
    saved = await readGatewayModeSetting();
  } catch {
    // Mongo hiccup — report the active mode without the persistence detail.
  }
  return {
    mode: gateway.mode,
    reason: gateway.reason,
    source: saved ? 'dashboard' : 'env',
    updatedAt: saved?.updatedAt ?? null,
    live: {
      configured: liveModeConfigured(),
      secretKey: maskKey(process.env.STRIPE_SECRET_KEY),
      webhookSecretConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      publishableKey: process.env.STRIPE_CLIENT_KEY ?? null,
      webhookEndpoint: '/api/webhooks/stripe',
    },
  };
}

export async function GET(req: Request) {
  const denied = guardDemoRequest(req, { name: 'mode-read', limit: 120 });
  if (denied) return denied;
  return Response.json(await modeState());
}

export async function POST(req: Request) {
  const denied = guardDemoRequest(req, { name: 'mode-write', limit: 12, windowMs: 60_000 });
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Body must be JSON: { "mode": "simulated" | "live" }' }, { status: 400 });
  }
  const mode = (body as { mode?: unknown } | null)?.mode;
  if (mode !== 'simulated' && mode !== 'live') {
    return Response.json({ error: 'mode must be exactly "simulated" or "live".' }, { status: 400 });
  }
  if (mode === 'live' && !liveModeConfigured()) {
    return Response.json(
      { error: 'Live mode needs STRIPE_SECRET_KEY in the environment first.' },
      { status: 400 },
    );
  }

  // Honor whatever was persisted before, so the switch below is a deliberate
  // override of the current state (and restore-on-boot has already run).
  await ensureGatewayModeRestored();

  const gateway = setGatewayMode(mode as GatewayMode);
  let persisted: GatewayModeSetting | null = null;
  try {
    await persistGatewayMode(mode as GatewayMode);
    persisted = await readGatewayModeSetting();
  } catch {
    // Mongo write failed — the switch still applies to this process, it just
    // will not survive a restart. The response says so via `source`.
  }

  return Response.json({
    mode: gateway.mode,
    reason: gateway.reason,
    source: persisted ? 'dashboard' : 'env',
    updatedAt: persisted?.updatedAt ?? null,
    live: {
      configured: liveModeConfigured(),
      secretKey: maskKey(process.env.STRIPE_SECRET_KEY),
      webhookSecretConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      publishableKey: process.env.STRIPE_CLIENT_KEY ?? null,
      webhookEndpoint: '/api/webhooks/stripe',
    },
  });
}
