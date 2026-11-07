'use client';

import { useState } from 'react';
import {
  DatabaseBackup,
  Play,
  RefreshCcw,
  RotateCw,
  ShieldQuestion,
  ShoppingCart,
  Timer,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useUi } from '@/lib/stripepulse/store';
import type { AppStatePayload } from '@/lib/stripepulse/types';
import { cn } from '@/lib/utils';

const SCENARIOS = [
  {
    id: 'checkout',
    title: 'Checkout & first invoice',
    desc: 'Hosted checkout → payment → subscription activated',
    icon: ShoppingCart,
    accent: 'text-[#8b85ff] bg-[#635bff]/10',
  },
  {
    id: 'payment_retry',
    title: 'Payment retry (dunning)',
    desc: 'card_declined → past_due → smart retry recovers',
    icon: Timer,
    accent: 'text-amber-500 bg-amber-500/10',
  },
  {
    id: 'duplicate',
    title: 'Duplicate webhook',
    desc: 'same eventId redelivered → idempotency blocks it',
    icon: ShieldQuestion,
    accent: 'text-sky-500 bg-sky-500/10',
  },
  {
    id: 'db_failure',
    title: 'DB failure → recovery',
    desc: 'write fails → 500 → backoff → disable → recovered',
    icon: DatabaseBackup,
    accent: 'text-rose-500 bg-rose-500/10',
  },
] as const;

type ScenarioId = (typeof SCENARIOS)[number]['id'];

export function ScenarioPanel({
  appState,
  onStarted,
}: {
  appState: AppStatePayload | null;
  onStarted: (runId: string, meta?: { sessionId: string; planName: string; amount: number }) => void;
}) {
  const { toast } = useToast();
  const setRunId = useUi((s) => s.setRunId);
  const openCheckout = useUi((s) => s.openCheckout);
  const [busy, setBusy] = useState<ScenarioId | null>(null);
  const [planId, setPlanId] = useState('price_pro_monthly');
  const [confirmReset, setConfirmReset] = useState(false);

  const dbFailure = appState?.flags.dbFailure ?? false;
  const retryFailure = appState?.flags.retryFailure ?? false;

  const post = async (url: string, body?: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    return json as Record<string, string>;
  };

  const start = async (id: ScenarioId) => {
    setBusy(id);
    try {
      if (id === 'checkout') {
        const r = await post('/api/demo/checkout', { planId });
        const plan = appState?.plans.find((p) => p._id === planId);
        if (r.mode === 'simulated') {
          openCheckout({
            runId: r.runId,
            sessionId: r.sessionId,
            planName: plan?.planName ?? 'Pro',
            amount: plan?.amount ?? 1900,
          });
        }
        onStarted(r.runId, { sessionId: r.sessionId, planName: plan?.planName ?? 'Pro', amount: plan?.amount ?? 1900 });
        toast({ title: 'Checkout session created', description: r.sessionId });
      } else if (id === 'payment_retry') {
        const r = await post('/api/demo/scenarios/payment-retry', { planId });
        onStarted(r.runId);
        toast({ title: 'Payment retry scenario running', description: 'Attempt #1 will be declined, then a smart retry is scheduled.' });
      } else if (id === 'duplicate') {
        const r = await post('/api/demo/scenarios/duplicate', { runId: useUi.getState().runId ?? undefined });
        onStarted(r.runId);
        toast({ title: 'Duplicate webhook injected', description: `Redelivered ${r.eventId} — watch the idempotency guard.` });
      } else {
        const r = await post('/api/demo/scenarios/db-failure');
        onStarted(r.runId);
        toast({
          title: 'DB failure injection armed',
          description: 'The webhook write will fail until you disable the injection. Recovery via redelivery.',
          duration: 6000,
        });
      }
    } catch (e) {
      toast({ title: 'Scenario failed to start', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  const toggleFailure = async (flag: 'db_failure' | 'retry_failure', enabled: boolean) => {
    try {
      const res = await fetch('/api/demo/flags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flag, enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const title = flag === 'db_failure'
        ? (enabled ? 'Failure injection ENABLED' : 'Failure injection disabled')
        : (enabled ? 'Retry decline injection ENABLED' : 'Retry decline injection disabled');
      const description = flag === 'db_failure'
        ? (enabled
          ? 'Next mutating webhook write will fail and enter retry backoff.'
          : 'Redeliveries will now be processed normally.')
        : (enabled
          ? 'Smart retries will be declined until the attempt limit marks the subscription unpaid.'
          : 'Smart retries will charge normally again.');
      toast({ title, description });
    } catch (e) {
      toast({ title: 'Flag change failed', description: String(e), variant: 'destructive' });
    }
  };

  const retryNow = async () => {
    try {
      const r = await post('/api/demo/retry-now');
      toast({ title: 'Retry tick processed', description: `redelivered: ${r.redelivered ?? 0} · payment retries: ${r.paymentRetries ?? 0}` });
    } catch (e) {
      toast({ title: 'Retry failed', description: String(e), variant: 'destructive' });
    }
  };

  const reset = async () => {
    if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 3500); return; }
    try {
      await post('/api/demo/reset');
      setRunId(null);
      setConfirmReset(false);
      toast({ title: 'Demo environment reset', description: 'All runs, events, subscriptions and logs cleared.' });
    } catch (e) {
      toast({ title: 'Reset failed', description: String(e), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-3" data-testid="scenario-panel">
      <Card className="border-border/60 bg-card/50">
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-[#8b85ff]" /> Scenarios
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-4 pt-0">
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger size="sm" className="w-full text-xs" aria-label="Plan">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(appState?.plans ?? []).map((p) => (
                <SelectItem key={p._id} value={p._id} className="text-xs">
                  {p.planName} — ${(p.amount / 100).toFixed(2)}/mo
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              data-testid={`scenario-${s.id}`}
              disabled={busy !== null}
              onClick={() => void start(s.id)}
              className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5 text-left transition-all hover:border-[#635bff]/50 hover:bg-[#635bff]/[0.04] disabled:opacity-50"
            >
              <span className={cn('rounded-md p-1.5', s.accent)}>
                <s.icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold leading-tight">{s.title}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{s.desc}</span>
              </span>
              {busy === s.id ? (
                <RotateCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Play className="h-3.5 w-3.5 text-muted-foreground/40 transition-colors group-hover:text-[#8b85ff]" />
              )}
            </button>
          ))}
        </CardContent>
      </Card>

      <Card className={cn('border-border/60 bg-card/50', (dbFailure || retryFailure) && 'border-rose-500/50 bg-rose-500/[0.04]')}>
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Failure injection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 px-4 pb-4 pt-0">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium" data-testid="db-failure-label">
                DB write failure
              </div>
              <div className="text-[10px] text-muted-foreground">
                {dbFailure ? 'Next webhook write will fail → 500 → retry backoff' : 'Webhook writes process normally'}
              </div>
            </div>
            <Switch
              checked={dbFailure}
              onCheckedChange={(v) => void toggleFailure('db_failure', v)}
              aria-label="Toggle database failure injection"
              data-testid="db-failure-switch"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium" data-testid="retry-failure-label">
                Retry declines
              </div>
              <div className="text-[10px] text-muted-foreground">
                {retryFailure
                  ? 'Smart retries decline until the attempt limit → subscription unpaid'
                  : 'Smart retries charge normally'}
              </div>
            </div>
            <Switch
              checked={retryFailure}
              onCheckedChange={(v) => void toggleFailure('retry_failure', v)}
              aria-label="Toggle retry decline injection"
              data-testid="retry-failure-switch"
            />
          </div>
          <Button size="sm" variant="outline" className="w-full text-[11px]" onClick={retryNow} data-testid="btn-retry-now">
            <RefreshCcw className="h-3 w-3" /> Process due retries now
          </Button>
          <Button
            size="sm"
            variant={confirmReset ? 'destructive' : 'ghost'}
            className="w-full text-[11px]"
            onClick={reset}
            data-testid="btn-reset-demo"
          >
            {confirmReset ? 'Click again to confirm reset' : 'Reset demo environment'}
          </Button>
        </CardContent>
      </Card>

      <RunHistory appState={appState} />
    </div>
  );
}

function RunHistory({ appState }: { appState: AppStatePayload | null }) {
  const runId = useUi((s) => s.runId);
  const setRunId = useUi((s) => s.setRunId);
  const runs = appState?.runs ?? [];

  return (
    <Card className="border-border/60 bg-card/50">
      <CardHeader className="px-4 py-3 pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">Run history</CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-2 pt-0">
        {runs.length === 0 ? (
          <div className="px-2 pb-1 text-[10px] text-muted-foreground">No runs yet.</div>
        ) : (
          <ScrollArea className="max-h-56 overflow-y-auto">
            <div className="space-y-0.5">
              {runs.map((r) => (
                <button
                  key={r._id}
                  data-testid={`run-item-${r._id}`}
                  onClick={() => setRunId(r._id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50',
                    runId === r._id && 'bg-[#635bff]/10 ring-1 ring-[#635bff]/40',
                  )}
                >
                  <Badge
                    variant="outline"
                    className={cn(
                      'font-mono text-[8px] shrink-0',
                      r.status === 'completed' ? 'text-emerald-500 border-emerald-500/40'
                        : r.status === 'failed' ? 'text-rose-500 border-rose-500/40'
                        : 'text-[#8b85ff] border-[#635bff]/40',
                    )}
                  >
                    {r.status}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] font-medium">{r.scenario.replace(/_/g, ' ')}</span>
                    <span className="block truncate font-mono text-[8.5px] text-muted-foreground">
                      {r._id} · {r.planName} · {new Date(r.createdAt).toLocaleTimeString('en-GB', { hour12: false })}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
