'use client';

import { ArrowRight, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AppStatePayload, RunStatePayload, SubscriptionDoc } from '@/lib/stripepulse/types';
import { cn } from '@/lib/utils';

const LIFECYCLE: { status: SubscriptionDoc['status']; label: string }[] = [
  { status: 'trialing', label: 'trialing' },
  { status: 'active', label: 'active' },
  { status: 'past_due', label: 'past_due' },
  { status: 'canceled', label: 'canceled' },
];

const STATUS_CLS: Record<string, string> = {
  trialing: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/40',
  active: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/40',
  past_due: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
  canceled: 'bg-rose-500/15 text-rose-500 border-rose-500/40',
  incomplete: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
  incomplete_expired: 'bg-rose-500/15 text-rose-500 border-rose-500/40',
  unpaid: 'bg-rose-500/15 text-rose-500 border-rose-500/40',
};

export function SubscriptionsPanel({
  run,
  appState,
}: {
  run: RunStatePayload | null;
  appState: AppStatePayload | null;
}) {
  const subs: SubscriptionDoc[] = run?.subscriptions?.length
    ? run.subscriptions
    : appState?.subscriptions ?? [];
  const currentStatus = subs[0]?.status;

  return (
    <div className="space-y-3" data-testid="subscriptions-panel">
      {/* Lifecycle state machine */}
      <Card className="border-border/60 bg-card/50">
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground">Subscription lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-3 pt-0">
          <div className="flex items-center gap-1" data-testid="lifecycle-track">
            {LIFECYCLE.map((l, i) => {
              const isCurrent = currentStatus === l.status;
              return (
                <div key={l.status} className="flex items-center gap-1">
                  {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground/50" />}
                  <span
                    data-testid={`lifecycle-${l.status}`}
                    className={cn(
                      'rounded-full border px-2 py-0.5 font-mono text-[9.5px] transition-all',
                      isCurrent
                        ? `${STATUS_CLS[l.status]} animate-pulse font-semibold`
                        : 'border-border/60 text-muted-foreground/70',
                    )}
                  >
                    {l.label}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Subscription cards */}
      {subs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground">
          No subscriptions yet — run the checkout scenario.
        </div>
      ) : (
        <div className="space-y-2">
          {subs.slice(0, 6).map((s) => (
            <Card key={s._id} className="border-border/60 bg-card/50 py-3" data-testid="subscription-card">
              <CardContent className="flex items-center gap-3 px-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                  <CheckCircle2 className={cn('h-4 w-4', s.status === 'active' ? 'text-emerald-500' : s.status === 'trialing' ? 'text-sky-500' : 'text-amber-500')} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">StripePulse {s.planName}</span>
                    <Badge variant="outline" className={cn('font-mono text-[9px]', STATUS_CLS[s.status])} data-testid="subscription-status">
                      {s.status}
                    </Badge>
                  </div>
                  <div className="truncate font-mono text-[9.5px] text-muted-foreground">
                    {s.subscriptionId} · {s.customerEmail}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold font-mono">${(s.amount / 100).toFixed(2)}<span className="text-[10px] font-normal text-muted-foreground">/mo</span></div>
                  <div className="flex items-center gap-1 font-mono text-[9px] text-muted-foreground">
                    <Clock className="h-2.5 w-2.5" />
                    renews {new Date(s.currentPeriodEnd).toLocaleDateString()}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {subs.length === 0 && (
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <XCircle className="h-3 w-3" /> subscriptions appear here after checkout
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AttemptsTable({
  run,
  appState,
}: {
  run: RunStatePayload | null;
  appState: AppStatePayload | null;
}) {
  const attempts = run?.attempts?.length ? run.attempts : appState?.attempts ?? [];

  if (attempts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground" data-testid="attempts-empty">
        No payment attempts yet — the payment-retry scenario produces failed + successful attempts.
      </div>
    );
  }

  return (
    <ScrollArea className="max-h-72 overflow-y-auto rounded-lg border border-border/60" data-testid="attempts-table">
      <table className="w-full text-left text-[10.5px]">
        <thead className="sticky top-0 bg-card/95 backdrop-blur">
          <tr className="border-b border-border/60 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
            <th className="px-2.5 py-1.5 font-medium">#</th>
            <th className="px-2.5 py-1.5 font-medium">invoice</th>
            <th className="px-2.5 py-1.5 font-medium">amount</th>
            <th className="px-2.5 py-1.5 font-medium">result</th>
            <th className="px-2.5 py-1.5 font-medium">code</th>
            <th className="px-2.5 py-1.5 font-medium">time</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {attempts.map((a) => (
            <tr key={a._id} className="border-b border-border/30 last:border-0" data-testid="attempt-row">
              <td className="px-2.5 py-1.5">{a.attempt}</td>
              <td className="max-w-[110px] truncate px-2.5 py-1.5 text-muted-foreground" title={a.invoiceId}>{a.invoiceId}</td>
              <td className="px-2.5 py-1.5">${(a.amount / 100).toFixed(2)}</td>
              <td className="px-2.5 py-1.5">
                <Badge variant="outline" className={cn('font-mono text-[9px]', a.status === 'succeeded' ? STATUS_CLS.active : STATUS_CLS.past_due)}>
                  {a.status}
                </Badge>
              </td>
              <td className="max-w-[110px] truncate px-2.5 py-1.5 text-muted-foreground" title={a.failureMessage}>
                {a.failureCode ?? '—'}
              </td>
              <td className="px-2.5 py-1.5 text-muted-foreground">{new Date(a.createdAt).toLocaleTimeString('en-GB', { hour12: false })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}
