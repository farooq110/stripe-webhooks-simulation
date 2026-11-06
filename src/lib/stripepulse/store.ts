// ─── StripePulse · client state ──────────────────────────────────────────────
// The animation engine. It only ever *replays* records the backend produced:
// the playhead can never move past the last settled step, so the UI can never
// show a result before the backend produced it, and replaying never triggers
// payments or webhooks (all mutating actions are explicit user requests).

import { create } from 'zustand';
import type { RunStepDoc, StepStatus } from './types';

export type AnimMode = 'auto' | 'manual' | 'timeline';

export const SETTLED: StepStatus[] = ['completed', 'failed', 'blocked', 'skipped'];

/** Number of steps whose result already exists (produced by the backend). */
export function settledCount(steps: RunStepDoc[]): number {
  let n = 0;
  // steps are ordered by idx; count leading settled steps, tolerating later
  // settled steps too (manual jump target = any settled step).
  for (const s of steps) if (SETTLED.includes(s.status)) n++;
  return n;
}

/** Highest idx (1-based) such that all steps up to it are settled. */
export function contiguousSettled(steps: RunStepDoc[]): number {
  let n = 0;
  for (const s of steps) {
    if (SETTLED.includes(s.status)) n = s.idx;
    else break;
  }
  return n;
}

interface UiState {
  runId: string | null;
  checkoutOpen: boolean;
  checkoutMeta: { runId: string; sessionId: string; planName: string; amount: number } | null;
  selectedStepIdx: number | null;
  setRunId: (id: string | null) => void;
  openCheckout: (meta: UiState['checkoutMeta']) => void;
  closeCheckout: () => void;
  selectStep: (idx: number | null) => void;
}

export const useUi = create<UiState>((set) => ({
  runId: null,
  checkoutOpen: false,
  checkoutMeta: null,
  selectedStepIdx: null,
  setRunId: (runId) => set({ runId, selectedStepIdx: null }),
  openCheckout: (checkoutMeta) => set({ checkoutOpen: true, checkoutMeta }),
  closeCheckout: () => set({ checkoutOpen: false, checkoutMeta: null }),
  selectStep: (selectedStepIdx) => set({ selectedStepIdx }),
}));

interface AnimState {
  mode: AnimMode;
  playing: boolean;
  speed: number;
  playhead: number; // steps consumed (0..N)
  replayTick: number;
  setMode: (m: AnimMode) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  advance: (dtSteps: number, max: number) => void;
  next: (max: number) => void;
  prev: () => void;
  jumpTo: (idx: number, max: number) => void;
  replay: () => void;
  reset: () => void;
}

export const useAnim = create<AnimState>((set) => ({
  mode: 'auto',
  playing: true,
  speed: 1,
  playhead: 0,
  replayTick: 0,
  setMode: (mode) => set({ mode }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  advance: (dtSteps, max) =>
    set((s) => ({ playhead: Math.min(s.playhead + dtSteps, max) })),
  next: (max) => set((s) => ({ playhead: Math.min(s.playhead + 1, max), replayTick: s.replayTick + 1 })),
  prev: () => set((s) => ({ playhead: Math.max(s.playhead - 1, 0), replayTick: s.replayTick + 1 })),
  jumpTo: (idx, max) =>
    set((s) => ({ playhead: Math.max(0, Math.min(idx, max)), replayTick: s.replayTick + 1 })),
  replay: () => set((s) => ({ replayTick: s.replayTick + 1 })),
  reset: () => set({ playhead: 0, playing: false, replayTick: 0 }),
}));
