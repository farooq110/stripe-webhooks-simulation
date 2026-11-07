'use client';

// ─── StripePulse · polling hooks ─────────────────────────────────────────────
// All dashboard data comes from these polls of real backend state.

import { useEffect, useRef, useState } from 'react';
import type { AppStatePayload, RunStatePayload } from '@/lib/stripepulse/types';

export function useAppState(intervalMs = 2500): { state: AppStatePayload | null; error: string | null } {
  const [state, setState] = useState<AppStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        if (!res.ok) throw new Error(`state ${res.status}`);
        const json = (await res.json()) as AppStatePayload;
        if (alive) { setState(json); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'poll failed');
      }
    };
    void poll();
    const t = setInterval(poll, intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [intervalMs]);

  return { state, error };
}

export function useRun(runId: string | null): { run: RunStatePayload | null; loading: boolean } {
  const [run, setRun] = useState<RunStatePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const aliveRef = useRef(true);
  const statusRef = useRef<'running' | 'completed' | 'failed'>('running');

  useEffect(() => {
    aliveRef.current = true;
    // Reset cached state when the run id changes — intentional setState in
    // an effect (strict react-hooks rule flags it; this is cleanup, not a
    // derived-state shortcut).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!runId) { setRun(null); setLoading(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);

    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          const json = (await res.json()) as RunStatePayload;
          statusRef.current = json.run.status;
          setRun(json);
        } else {
          setRun(null);
        }
      } catch {
        /* transient network error — retry next tick */
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (!cancelled) {
        // 1s while the backend is producing steps, 4s once settled.
        timer = setTimeout(tick, statusRef.current === 'running' ? 1000 : 4000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { run, loading };
}
