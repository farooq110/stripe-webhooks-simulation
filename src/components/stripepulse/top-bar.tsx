'use client';

import { Moon, Sun, Zap } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AppStatePayload } from '@/lib/stripepulse/types';
import { cn } from '@/lib/utils';

export function TopBar({ appState }: { appState: AppStatePayload | null }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Defer until after paint to avoid sync setState in effect (lint rule).
    const id = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(id);
  }, []);

  const gateway = appState?.gateway;
  const mongo = appState?.mongo;

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background/80 px-4 backdrop-blur-md">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#635bff] shadow-[0_0_16px_-2px_rgba(99,91,255,0.6)]">
          <Zap className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-tight">StripePulse</div>
          <div className="hidden text-[10px] text-muted-foreground sm:block">Interactive Stripe simulation · webhook pipeline · subscription lifecycle</div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {gateway && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                data-testid="gateway-badge"
                className={cn(
                  'gap-1.5 font-mono text-[9px] uppercase',
                  gateway.mode === 'live'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                    : 'border-[#635bff]/40 bg-[#635bff]/10 text-[#8b85ff]',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', gateway.mode === 'live' ? 'bg-emerald-500' : 'bg-[#635bff]')} />
                {gateway.mode === 'live' ? 'Stripe live (test mode)' : 'Simulated gateway'}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-72 text-[11px]">
              {gateway.reason}
            </TooltipContent>
          </Tooltip>
        )}
        {mongo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                data-testid="mongo-badge"
                className={cn(
                  'hidden gap-1.5 font-mono text-[9px] sm:inline-flex',
                  mongo.ok ? 'border-emerald-500/40 text-emerald-500' : 'border-rose-500/40 text-rose-500',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', mongo.ok ? 'animate-pulse bg-emerald-500' : 'bg-rose-500')} />
                MongoDB {mongo.version ?? 'connecting…'} · rs0
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              {mongo.ok ? `Replica set rs0 · transactions enabled · v${mongo.version}` : `MongoDB unavailable: ${mongo.error}`}
            </TooltipContent>
          </Tooltip>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Toggle theme"
          data-testid="theme-toggle"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {mounted && theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </header>
  );
}
