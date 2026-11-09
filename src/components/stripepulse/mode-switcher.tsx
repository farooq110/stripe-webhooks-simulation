'use client';

// ─── StripePulse · gateway mode switcher ─────────────────────────────────────
// Two-button segmented control in the TopBar: Simulation ↔ Live (Stripe Test
// Mode). The active mode comes from the polled app state; capabilities (is a
// Stripe secret key configured at all?) come from GET /api/gateway/mode.
// Switching to live asks for confirmation first, because from that point on
// runs create real customers and checkout sessions in the Stripe account.

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type Mode = 'simulated' | 'live';

interface ModeCaps {
  mode: Mode;
  source: 'dashboard' | 'env';
  updatedAt: string | null;
  live: {
    configured: boolean;
    secretKey: string | null;
    webhookSecretConfigured: boolean;
    publishableKey: string | null;
    webhookEndpoint: string;
  };
}

export function ModeSwitcher({ mode }: { mode: Mode | undefined }) {
  const { toast } = useToast();
  const [caps, setCaps] = useState<ModeCaps | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);

  // Capabilities are refetched whenever the active mode changes (i.e. after
  // every successful switch) so keys/endpoint info stay current.
  useEffect(() => {
    let alive = true;
    fetch('/api/gateway/mode', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ModeCaps | null) => {
        if (alive && j) setCaps(j);
      })
      .catch(() => {
        // The polled state already surfaces backend problems elsewhere.
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  async function switchTo(next: Mode) {
    if (!mode || next === mode || busy) return;
    setBusy(next);
    try {
      const res = await fetch('/api/gateway/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      const json = (await res.json().catch(() => null)) as (ModeCaps & { error?: string }) | null;
      if (!res.ok || !json) throw new Error(json?.error ?? `gateway mode returned ${res.status}`);
      setCaps(json);
      toast({
        title: next === 'live' ? 'Live Stripe gateway active' : 'Simulated gateway active',
        description:
          next === 'live'
            ? 'New runs now call the real Stripe API (Test Mode) and webhooks arrive at /api/webhooks/stripe.'
            : 'New runs use the deterministic in-process gateway again.',
      });
    } catch (e) {
      toast({
        title: 'Mode switch failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  }

  const liveReady = caps ? caps.live.configured : null;
  const liveDisabled = busy !== null || liveReady === false;

  return (
    <div
      className="flex items-center rounded-md border border-border/60 bg-card/50 p-0.5"
      role="group"
      aria-label="Gateway mode"
      data-testid="mode-switcher"
    >
      <button
        type="button"
        data-testid="mode-sim"
        onClick={() => void switchTo('simulated')}
        disabled={mode === undefined || busy !== null || mode === 'simulated'}
        className={cn(
          'rounded-sm px-2 py-1 font-mono text-[9px] uppercase tracking-wide transition-colors',
          mode === 'simulated' ? 'bg-[#635bff]/15 text-[#8b85ff]' : 'text-muted-foreground hover:text-foreground',
          (mode === undefined || busy !== null) && 'cursor-wait opacity-60',
        )}
      >
        {busy === 'simulated' ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-label="Switching" />
        ) : (
          'Simulation'
        )}
      </button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button
            type="button"
            data-testid="mode-live"
            disabled={liveDisabled || mode === undefined || mode === 'live'}
            className={cn(
              'rounded-sm px-2 py-1 font-mono text-[9px] uppercase tracking-wide transition-colors',
              mode === 'live'
                ? 'bg-emerald-500/15 text-emerald-500'
                : 'text-muted-foreground hover:text-foreground',
              (liveDisabled || mode === undefined) && 'cursor-not-allowed opacity-50',
            )}
          >
            {busy === 'live' ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-label="Switching" />
            ) : (
              'Live'
            )}
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch to live Stripe (Test Mode)?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-[12px] leading-relaxed text-muted-foreground">
                <span className="block">
                  New runs will call the real Stripe API with the configured Test Mode keys — real
                  customers and checkout sessions are created in your Stripe dashboard.
                </span>
                <span className="block">
                  Stripe must deliver webhooks to
                  <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                    {caps?.live.webhookEndpoint ?? '/api/webhooks/stripe'}
                  </code>
                  using the STRIPE_WEBHOOK_SECRET already set in this deployment.
                </span>
                {caps && !caps.live.configured ? (
                  <span className="block font-medium text-amber-500">
                    STRIPE_SECRET_KEY is not set in this environment — add it and restart the server
                    before switching.
                  </span>
                ) : (
                  caps?.live.secretKey && (
                    <span className="block">
                      Secret key loaded: <span className="font-mono">{caps.live.secretKey}</span>
                      {caps.live.publishableKey ? ` · publishable key loaded` : ''}
                    </span>
                  )
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="mode-live-cancel">Stay on simulation</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mode-live-confirm"
              disabled={liveReady === false}
              onClick={() => void switchTo('live')}
              className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            >
              {busy === 'live' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Switch to live'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
