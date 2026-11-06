'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { Activity, DollarSign, Fingerprint, ShieldX } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AnimationController } from '@/components/stripepulse/animation-controller';
import { CheckoutDialog } from '@/components/stripepulse/checkout-dialog';
import { EventTerminal } from '@/components/stripepulse/event-terminal';
import { PipelineSkeleton } from '@/components/stripepulse/pipeline-skeleton';
import { ScenarioPanel } from '@/components/stripepulse/scenario-panel';
import { StepInspector } from '@/components/stripepulse/step-inspector';
import { SubscriptionsPanel, AttemptsTable } from '@/components/stripepulse/subscriptions-panel';
import { TimelineStrip } from '@/components/stripepulse/timeline-strip';
import { TopBar } from '@/components/stripepulse/top-bar';
import { useAppState, useRun } from '@/hooks/use-data';
import { contiguousSettled, useAnim, useUi } from '@/lib/stripepulse/store';

const Pipeline = dynamic(() => import('@/components/stripepulse/pipeline'), {
  ssr: false,
  loading: () => <PipelineSkeleton />,
});

export default function Dashboard() {
  const { state: appState } = useAppState(2500);
  const runId = useUi((s) => s.runId);
  const setRunId = useUi((s) => s.setRunId);
  const { run } = useRun(runId);

  const mode = useAnim((s) => s.mode);
  const playing = useAnim((s) => s.playing);
  const speed = useAnim((s) => s.speed);
  const advance = useAnim((s) => s.advance);
  const setPlaying = useAnim((s) => s.setPlaying);
  const reset = useAnim((s) => s.reset);
  const playhead = useAnim((s) => s.playhead);

  const steps = run?.steps ?? [];
  const settled = contiguousSettled(steps);
  const total = steps.length;
  const settledRef = useRef(settled);
  const totalRef = useRef(total);
  const runStatusRef = useRef(run?.run.status);
  useEffect(() => {
    settledRef.current = settled;
    totalRef.current = total;
    runStatusRef.current = run?.run.status;
  }, [settled, total, run?.run.status]);

  // Auto-select the latest run on first load.
  useEffect(() => {
    if (!runId && appState?.runs.length) setRunId(appState.runs[0]._id);
  }, [appState, runId, setRunId]);

  // Reset the replay engine when the selected run changes.
  useEffect(() => {
    reset();
    if (runId) setPlaying(true);
  }, [runId, reset, setPlaying]);

  // Animation loop (auto mode): advances the playhead toward the live edge —
  // which only grows when the backend records new settled steps.
  useEffect(() => {
    if (mode !== 'auto' || !playing) return;
    const STEPS_PER_SEC = 0.9;
    const iv = setInterval(() => {
      advance((STEPS_PER_SEC * speed) / 10, settledRef.current);
      // Stop only when the run has really finished AND we have data for it.
      if (
        totalRef.current > 0 &&
        (runStatusRef.current === 'completed' || runStatusRef.current === 'failed') &&
        useAnim.getState().playhead >= settledRef.current
      ) {
        setPlaying(false);
      }
    }, 100);
    return () => clearInterval(iv);
  }, [mode, playing, speed, advance, setPlaying]);

  const stats = appState?.stats;

  return (
    <TooltipProvider delayDuration={200}>
    <div className="stripepulse-bg flex min-h-screen flex-col bg-background text-foreground">
      <TopBar appState={appState} />

      <main className="grid flex-1 grid-cols-1 gap-3 p-3 lg:h-[calc(100vh-3.5rem-2rem)] lg:grid-cols-[290px_minmax(0,1fr)_360px] lg:overflow-hidden">
        {/* ── Left rail: stats + scenarios + history ── */}
        <aside className="order-2 space-y-3 lg:order-1 lg:overflow-y-auto lg:pr-1 left-rail-scroll" data-testid="left-rail">
          <div className="grid grid-cols-2 gap-2" data-testid="stat-cards">
            <Stat icon={Activity} label="Active subs" value={stats ? String(stats.activeSubscriptions) : '…'} tone="emerald" />
            <Stat icon={DollarSign} label="MRR" value={stats ? `$${(stats.mrr / 100).toFixed(0)}` : '…'} tone="violet" />
            <Stat icon={Fingerprint} label="Events ok" value={stats ? String(stats.eventsProcessed) : '…'} tone="sky" />
            <Stat icon={ShieldX} label="Dup blocked" value={stats ? String(stats.duplicatesBlocked) : '…'} tone="amber" />
          </div>
          <ScenarioPanel
            appState={appState}
            onStarted={(newRunId) => setRunId(newRunId)}
          />
        </aside>

        {/* ── Center: pipeline + controls + timeline + inspector ── */}
        <section className="order-1 flex min-w-0 flex-col gap-3 lg:order-2 lg:overflow-hidden" data-testid="center-panel">
          <Card className="flex min-h-[380px] flex-1 flex-col overflow-hidden border-border/60 bg-card/50 py-0 lg:min-h-0" data-testid="pipeline-card">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
              <span className="text-xs font-medium text-muted-foreground">
                Processing pipeline
                {run ? (
                  <span className="ml-2 font-mono text-[10px]">
                    {run.run.scenario.replace(/_/g, ' ')} · {run.run.mode}
                  </span>
                ) : null}
              </span>
              {run && (
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${
                    run.run.status === 'running'
                      ? 'border-[#635bff]/40 bg-[#635bff]/10 text-[#8b85ff]'
                      : run.run.status === 'completed'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                        : 'border-rose-500/40 bg-rose-500/10 text-rose-500'
                  }`}
                  data-testid="run-status-badge"
                >
                  {run.run.status}
                </span>
              )}
            </div>
            <div className="relative min-h-[300px] flex-1">
              {run ? <Pipeline steps={steps} playhead={playhead} /> : <PipelineSkeleton />}
            </div>
          </Card>

          <Card className="shrink-0 space-y-2.5 border-border/60 bg-card/50 px-3 py-2.5">
            <AnimationController steps={steps} runStatus={run?.run.status} />
            <TimelineStrip steps={steps} runStatus={run?.run.status} />
          </Card>

          <div className="shrink-0 lg:min-h-0">
            <StepInspector steps={steps} />
          </div>
        </section>

        {/* ── Right rail: terminal + subscriptions + attempts ── */}
        <aside className="order-3 flex min-w-0 flex-col gap-3 lg:overflow-hidden">
          <div className="h-80 lg:h-[46%] lg:min-h-[240px]">
            <EventTerminal run={run} appState={appState} />
          </div>
          <div className="min-h-0 flex-1 space-y-3 lg:overflow-y-auto lg:pr-1 right-rail-scroll">
            <SubscriptionsPanel run={run} appState={appState} />
            <div>
              <div className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">Payment attempts & retries</div>
              <AttemptsTable run={run} appState={appState} />
            </div>
          </div>
        </aside>
      </main>

      {/* Sticky footer — always at the bottom, no floating gap */}
      <footer className="mt-auto flex h-8 shrink-0 items-center justify-between border-t border-border/60 px-4 font-mono text-[9.5px] text-muted-foreground">
        <span className="truncate">
          StripePulse · simulated Stripe semantics · MongoDB {appState?.mongo.version ?? '?'} replica set · genuine HMAC signatures & ACID webhook processing
        </span>
        <span className="hidden shrink-0 sm:block" data-testid="replay-note">
          replay is read-only — it never re-executes payments or webhooks
        </span>
      </footer>

      <CheckoutDialog onPaid={(paidRunId) => setRunId(paidRunId)} />
      <Toaster />
    </div>
    </TooltipProvider>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: 'emerald' | 'violet' | 'sky' | 'amber';
}) {
  const tones = {
    emerald: 'text-emerald-500 bg-emerald-500/10',
    violet: 'text-[#8b85ff] bg-[#635bff]/10',
    sky: 'text-sky-500 bg-sky-500/10',
    amber: 'text-amber-500 bg-amber-500/10',
  };
  return (
    <Card className="border-border/60 bg-card/50 py-2.5" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <CardContent className="flex items-center gap-2.5 px-3">
        <span className={`rounded-md p-1.5 ${tones[tone]}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span>
          <span className="block text-sm font-bold leading-tight">{value}</span>
          <span className="block text-[9px] text-muted-foreground">{label}</span>
        </span>
      </CardContent>
    </Card>
  );
}
