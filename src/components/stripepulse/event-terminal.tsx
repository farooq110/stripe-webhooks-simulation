'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, Database as DbIcon, Globe, Webhook } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ApiLogDoc, AppStatePayload, DbLogDoc, RunStatePayload, WebhookEventDoc } from '@/lib/stripepulse/types';
import { cn } from '@/lib/utils';

function StatusChip({ code }: { code?: number }) {
  if (code === undefined) return <Badge variant="outline" className="font-mono text-[9px]">—</Badge>;
  const cls =
    code >= 500 ? 'bg-rose-500/15 text-rose-500 border-rose-500/40'
    : code >= 400 ? 'bg-amber-500/15 text-amber-500 border-amber-500/40'
    : code >= 200 ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/40'
    : 'bg-muted text-muted-foreground border-border';
  return <Badge variant="outline" className={cn('font-mono text-[9px]', cls)}>{code || 'ERR'}</Badge>;
}

function EventStatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    processed: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/40',
    failed: 'bg-rose-500/15 text-rose-500 border-rose-500/40',
    duplicate: 'bg-amber-500/15 text-amber-500 border-amber-500/40',
    processing: 'bg-[#635bff]/15 text-[#8b85ff] border-[#635bff]/40',
    received: 'bg-muted text-muted-foreground border-border',
  };
  return <Badge variant="outline" className={cn('font-mono text-[9px]', map[status] ?? map.received)}>{status}</Badge>;
}

function JsonPeek({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <pre className="whitespace-pre-wrap break-all rounded border border-border/50 bg-background/60 p-1.5 font-mono text-[9.5px] leading-relaxed">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Row({ children, expanded, onClick }: { children: React.ReactNode; expanded: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full border-b border-border/40 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40"
      aria-expanded={expanded}
    >
      {children}
    </button>
  );
}

export function EventTerminal({ run, appState }: { run: RunStatePayload | null; appState: AppStatePayload | null }) {
  const [tab, setTab] = useState('http');
  const [openId, setOpenId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const apiLogs: ApiLogDoc[] = run?.apiLogs ?? [];
  const events: WebhookEventDoc[] = run?.events ?? appState?.recentEvents ?? [];
  const dbLogs: DbLogDoc[] = run?.dbLogs ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [apiLogs.length, events.length, dbLogs.length, tab]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border/60 bg-card/50" data-testid="event-terminal">
      <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col gap-0">
        <div className="border-b border-border/60 px-2.5 pt-2">
          <TabsList className="h-7 w-full justify-start bg-transparent p-0">
            <TabsTrigger value="http" className="gap-1.5 px-2.5 text-[11px] data-[state=active]:bg-muted" data-testid="tab-http">
              <Globe className="h-3 w-3" /> HTTP API <span className="font-mono text-[9px] opacity-60">{apiLogs.length}</span>
            </TabsTrigger>
            <TabsTrigger value="webhooks" className="gap-1.5 px-2.5 text-[11px] data-[state=active]:bg-muted" data-testid="tab-webhooks">
              <Webhook className="h-3 w-3" /> Webhooks <span className="font-mono text-[9px] opacity-60">{events.length}</span>
            </TabsTrigger>
            <TabsTrigger value="database" className="gap-1.5 px-2.5 text-[11px] data-[state=active]:bg-muted" data-testid="tab-database">
              <DbIcon className="h-3 w-3" /> Database <span className="font-mono text-[9px] opacity-60">{dbLogs.length}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto terminal-scroll">
          <TabsContent value="http" className="m-0">
            {apiLogs.length === 0 ? (
              <Empty text="No API traffic recorded for this run yet." />
            ) : (
              apiLogs.map((l) => (
                <div key={l._id}>
                  <Row expanded={openId === l._id} onClick={() => setOpenId(openId === l._id ? null : l._id)}>
                    <div className="flex items-center gap-1.5 font-mono text-[10px]">
                      {l.direction === 'outbound'
                        ? <ArrowUpRight className="h-3 w-3 text-[#8b85ff]" />
                        : <ArrowDownLeft className="h-3 w-3 text-emerald-500" />}
                      <span className="text-muted-foreground">{time(l.createdAt)}</span>
                      <span className="font-semibold">{l.method}</span>
                      <span className="truncate text-foreground/80">{l.path}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {l.durationMs !== undefined && <span className="text-[9px] text-muted-foreground">{l.durationMs}ms</span>}
                        <StatusChip code={l.statusCode} />
                        {openId === l._id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate pl-[26px] font-mono text-[9px] text-muted-foreground">{l.component}</div>
                  </Row>
                  {openId === l._id && (
                    <div className="space-y-1.5 border-b border-border/40 bg-background/50 px-3 py-2">
                      {l.request && <JsonPeek label="request" value={l.request} />}
                      {l.response && <JsonPeek label="response" value={l.response} />}
                    </div>
                  )}
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="webhooks" className="m-0">
            {events.length === 0 ? (
              <Empty text="No webhook events yet." />
            ) : (
              events.map((e) => (
                <div key={e._id}>
                  <Row expanded={openId === e._id} onClick={() => setOpenId(openId === e._id ? null : e._id)}>
                    <div className="flex items-center gap-1.5 font-mono text-[10px]">
                      <Webhook className={cn('h-3 w-3', e.status === 'failed' ? 'text-rose-500' : e.status === 'duplicate' ? 'text-amber-500' : 'text-emerald-500')} />
                      <span className="text-muted-foreground">{time(e.createdAt)}</span>
                      <span className="truncate font-semibold text-foreground/90">{e.type}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        <span className="text-[9px] text-muted-foreground">×{e.attempts}</span>
                        <EventStatusChip status={e.status} />
                        {openId === e._id ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate pl-[26px] font-mono text-[9px] text-muted-foreground">
                      {e.eventId}{e.lastError ? ` · ${e.lastError}` : ''}
                    </div>
                  </Row>
                  {openId === e._id && (
                    <div className="space-y-1.5 border-b border-border/40 bg-background/50 px-3 py-2">
                      <div className="flex gap-2 font-mono text-[9px] text-muted-foreground">
                        <span>sig: {e.signatureVerified ? 'verified ✓' : 'unverified ✗'}</span>
                        <span>deliveries: {e.deliveries?.length ?? 0}</span>
                        {e.nextRetryAt && <span className="text-amber-500">retry @ {new Date(e.nextRetryAt).toLocaleTimeString()}</span>}
                      </div>
                      <JsonPeek label="payload (raw, as delivered)" value={(() => { try { return JSON.stringify(JSON.parse(e.payloadRaw), null, 2); } catch { return e.payloadRaw; } })()} />
                    </div>
                  )}
                </div>
              ))
            )}
          </TabsContent>

          <TabsContent value="database" className="m-0">
            {dbLogs.length === 0 ? (
              <Empty text="No database operations recorded for this run yet." />
            ) : (
              dbLogs.map((d) => (
                <div key={d._id}>
                  <Row expanded={openId === d._id} onClick={() => setOpenId(openId === d._id ? null : d._id)}>
                    <div className="flex items-center gap-1.5 font-mono text-[10px]">
                      <DbIcon className={cn('h-3 w-3', d.result === 'failed' ? 'text-rose-500' : d.result === 'read-only' ? 'text-amber-500' : 'text-emerald-500')} />
                      <span className="text-muted-foreground">{time(d.createdAt)}</span>
                      <span className="font-semibold">{d.operation}</span>
                      <span className="truncate text-foreground/80">{d.collection}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {d.transaction && <Badge variant="outline" className="px-1 py-0 font-mono text-[8px] text-[#8b85ff] border-[#635bff]/40">TX</Badge>}
                        <ResultChip result={d.result} />
                      </span>
                    </div>
                    <div className="mt-0.5 truncate pl-[26px] font-mono text-[9px] text-muted-foreground">{d.detail}</div>
                  </Row>
                </div>
              ))
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function ResultChip({ result }: { result: string }) {
  const cls =
    result === 'ok' ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/40'
    : result === 'failed' ? 'bg-rose-500/15 text-rose-500 border-rose-500/40'
    : 'bg-amber-500/15 text-amber-500 border-amber-500/40';
  return <Badge variant="outline" className={cn('font-mono text-[9px]', cls)}>{result}</Badge>;
}

function Empty({ text }: { text: string }) {
  return <div className="p-6 text-center text-[11px] text-muted-foreground">{text}</div>;
}
