'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAnim, useUi } from '@/lib/stripepulse/store';
import type { RunStepDoc, StepStatus } from '@/lib/stripepulse/types';

const STATUS_BADGE: Record<StepStatus, { label: string; cls: string }> = {
  completed: { label: 'completed', cls: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  failed: { label: 'failed', cls: 'bg-rose-500/15 text-rose-500 border-rose-500/30' },
  blocked: { label: 'blocked', cls: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  running: { label: 'running', cls: 'bg-[#635bff]/15 text-[#8b85ff] border-[#635bff]/40' },
  pending: { label: 'pending', cls: 'bg-muted text-muted-foreground border-border' },
  skipped: { label: 'skipped', cls: 'bg-muted text-muted-foreground border-border' },
};

export function StepInspector({ steps }: { steps: RunStepDoc[] }) {
  const selectedStepIdx = useUi((s) => s.selectedStepIdx);
  const playhead = useAnim((s) => s.playhead);

  const step =
    steps.find((s) => s.idx === selectedStepIdx) ??
    steps[Math.max(0, Math.ceil(playhead) - 1)] ??
    null;

  return (
    <Card className="border-border/60 bg-card/50" data-testid="step-inspector">
      <CardHeader className="px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Step Inspector
          <span className="font-mono text-[10px]">
            {step ? `#${step.idx}` : '—'}
          </span>
          {step && (
            <Badge variant="outline" className={`ml-auto font-mono text-[9px] ${STATUS_BADGE[step.status].cls}`}>
              {STATUS_BADGE[step.status].label}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        {step ? (
          <div className="space-y-1.5">
            <div className="text-sm font-medium leading-snug">{step.title}</div>
            {step.startedAt || step.finishedAt ? (
              <div className="font-mono text-[10px] text-muted-foreground">
                {step.startedAt ? `started ${new Date(step.startedAt).toLocaleTimeString()}` : ''}
                {step.finishedAt ? ` · finished ${new Date(step.finishedAt).toLocaleTimeString()}` : ''}
              </div>
            ) : (
              <div className="font-mono text-[10px] text-muted-foreground">awaiting backend…</div>
            )}
            {step.detail ? (
              <ScrollArea className="max-h-44 overflow-y-auto rounded-md border border-border/60 bg-background/70">
                <pre
                  data-testid="step-detail-json"
                  className="whitespace-pre-wrap break-all p-2.5 font-mono text-[10px] leading-relaxed text-foreground/80"
                >
                  {JSON.stringify(step.detail, null, 2)}
                </pre>
              </ScrollArea>
            ) : (
              <div className="rounded-md border border-dashed border-border/60 p-2.5 text-center text-[10px] text-muted-foreground">
                {step.status === 'pending'
                  ? 'No result yet — this step has not been produced by the backend.'
                  : 'No additional detail recorded.'}
              </div>
            )}
          </div>
        ) : (
          <div className="py-3 text-center text-[11px] text-muted-foreground">
            Start a scenario — step details appear here as the backend produces them.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
