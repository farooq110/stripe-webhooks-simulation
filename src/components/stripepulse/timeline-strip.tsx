'use client';

import { motion } from 'framer-motion';
import { useAnim, SETTLED } from '@/lib/stripepulse/store';
import type { RunStepDoc, StepStatus } from '@/lib/stripepulse/types';
import { cn } from '@/lib/utils';

const STATUS_COLOR: Record<StepStatus, string> = {
  completed: 'bg-emerald-500',
  failed: 'bg-rose-500',
  blocked: 'bg-amber-500',
  running: 'bg-[#635bff] animate-pulse',
  pending: 'bg-muted-foreground/30',
  skipped: 'bg-muted-foreground/50',
};

export function TimelineStrip({ steps, runStatus }: { steps: RunStepDoc[]; runStatus?: string }) {
  const { playhead, jumpTo, mode, setMode } = useAnim();
  const settledCount = steps.filter((s) => SETTLED.includes(s.status)).length;

  if (steps.length === 0) {
    return (
      <div className="flex h-10 items-center justify-center text-[11px] text-muted-foreground">
        Start a scenario to populate the processing timeline — steps appear as the backend produces them.
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid="timeline-strip">
      <div className="flex items-center gap-0.5">
        {steps.map((s) => {
          const isSettled = SETTLED.includes(s.status);
          const isPast = s.idx <= playhead;
          const isCurrent = Math.ceil(playhead) === s.idx && playhead !== steps.length;
          return (
            <button
              key={s.key}
              data-testid={`timeline-step-${s.idx}`}
              data-status={s.status}
              title={`${s.idx}. ${s.title} — ${s.status}${isSettled ? '' : ' (backend has not produced this yet)'}`}
              aria-label={`Step ${s.idx}: ${s.title} (${s.status})`}
              disabled={!isSettled && mode !== 'timeline'}
              onClick={() => {
                if (!isSettled) return;
                if (mode === 'auto') setMode('timeline');
                jumpTo(s.idx, settledCount);
              }}
              className="group relative flex-1 py-1.5"
            >
              <div
                className={cn(
                  'mx-[1px] h-1.5 rounded-full transition-all duration-300',
                  STATUS_COLOR[s.status],
                  isPast && 'h-2',
                  isCurrent && 'ring-2 ring-[#635bff]/40 ring-offset-1 ring-offset-background',
                )}
              />
              <span className="pointer-events-none absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-[9px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                {s.idx}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] text-muted-foreground">
        <Legend cls="bg-emerald-500" label="completed" />
        <Legend cls="bg-rose-500" label="failed" />
        <Legend cls="bg-amber-500" label="duplicate / blocked" />
        <Legend cls="bg-[#635bff]" label="running" />
        <Legend cls="bg-muted-foreground/30" label="pending (awaiting backend)" />
        {runStatus === 'running' && <span className="ml-auto font-mono">backend producing…</span>}
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <motion.span className={cn('h-1.5 w-1.5 rounded-full', cls)} />
      {label}
    </span>
  );
}
