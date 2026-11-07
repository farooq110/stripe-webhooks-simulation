'use client';

import { ChevronLeft, ChevronRight, Gauge, Pause, Play, RotateCcw, SkipBack, StepForward } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAnim, type AnimMode, contiguousSettled } from '@/lib/stripepulse/store';
import type { RunStepDoc } from '@/lib/stripepulse/types';
import { cn } from '@/lib/utils';

const MODES: { id: AnimMode; label: string }[] = [
  { id: 'auto', label: 'Automatic' },
  { id: 'manual', label: 'Manual' },
  { id: 'timeline', label: 'Timeline' },
];

export function AnimationController({
  steps,
  runStatus,
}: {
  steps: RunStepDoc[];
  runStatus: 'running' | 'completed' | 'failed' | undefined;
}) {
  const { mode, playing, speed, playhead, setMode, setPlaying, setSpeed, next, prev, replay, reset, jumpTo } = useAnim();
  const settled = contiguousSettled(steps);
  const total = steps.length;
  const atLiveEdge = playhead >= settled;
  const noRun = total === 0;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="animation-controller">
      {/* Mode segmented control */}
      <div className="flex rounded-lg border border-border bg-background/60 p-0.5" role="tablist" aria-label="Animation mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            data-testid={`mode-${m.id}`}
            onClick={() => { setMode(m.id); if (m.id !== 'auto') setPlaying(false); }}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              mode === m.id ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Auto controls */}
      {mode === 'auto' && (
        <div className="flex items-center gap-1.5" data-testid="controls-auto">
          <Button size="icon-sm" variant="outline" aria-label={playing ? 'Pause' : 'Play'} data-testid="btn-play-pause" onClick={() => setPlaying(!playing)} disabled={noRun}>
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Select value={String(speed)} onValueChange={(v) => setSpeed(Number(v))}>
            <SelectTrigger size="sm" className="w-[74px] font-mono text-xs" aria-label="Playback speed">
              <Gauge className="h-3 w-3 opacity-60" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.5, 1, 2, 4].map((s) => (
                <SelectItem key={s} value={String(s)} className="font-mono text-xs">{s}×</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {atLiveEdge && runStatus === 'running' && (
            <Badge variant="live" className="gap-1.5 font-mono" data-testid="live-badge">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              LIVE
            </Badge>
          )}
        </div>
      )}

      {/* Manual / timeline scrub controls */}
      {mode !== 'auto' && (
        <div className="flex items-center gap-1" data-testid="controls-manual">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label="Reset replay" data-testid="btn-reset" onClick={() => reset()} disabled={noRun}>
                <SkipBack className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reset & replay from step 1</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label="Previous step" data-testid="btn-prev" onClick={() => prev()} disabled={noRun || playhead <= 0}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous step</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label="Replay current step" data-testid="btn-replay" onClick={() => replay()} disabled={noRun || playhead === 0}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Replay current step</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label="Next step" data-testid="btn-next" onClick={() => next(settled)} disabled={noRun || playhead >= settled} className={cn(playhead >= settled && runStatus === 'running' && 'opacity-50')}>
                <StepForward className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {playhead >= settled && runStatus === 'running' ? 'Backend has not produced this step yet' : 'Next step'}
            </TooltipContent>
          </Tooltip>
          <Select
            value=""
            onValueChange={(v) => jumpTo(Number(v), settled)}
            disabled={noRun || settled === 0}
          >
            <SelectTrigger size="sm" className="w-[130px] font-mono text-[11px]" aria-label="Jump to completed step" data-testid="jump-select">
              <SelectValue placeholder="Jump to step…" />
            </SelectTrigger>
            <SelectContent>
              {steps
                .filter((s) => s.status !== 'pending' && s.status !== 'running' && s.idx <= settled)
                .map((s) => (
                  <SelectItem key={s.key} value={String(s.idx)} className="text-xs">
                    {s.idx}. {s.title}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2 font-mono text-[11px] text-muted-foreground" data-testid="step-counter">
        <span>
          step <span className="text-foreground">{Math.min(Math.floor(playhead + 0.999), total) || 0}</span>/{total}
        </span>
        {atLiveEdge && runStatus === 'running' && mode !== 'auto' && (
          <span className="text-amber-500">· awaiting backend</span>
        )}
      </div>
    </div>
  );
}
