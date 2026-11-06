'use client';

// ─── StripePulse · pipeline canvas (React Flow) ─────────────────────────────
// Node/edge states are derived ONLY from backend-produced steps up to the
// animation playhead. Historical replay re-derives the exact same visuals
// without re-executing anything.

import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  CreditCard,
  Database,
  FileText,
  Fingerprint,
  LayoutDashboard,
  RefreshCcw,
  ShieldCheck,
  ShoppingCart,
  TimerReset,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { RunStepDoc } from '@/lib/stripepulse/types';
import type { PipelineNodeId } from '@/lib/stripepulse/types';

type NodeVisual = 'idle' | 'done' | 'active' | 'failed' | 'blocked';

interface PipeNodeData {
  label: string;
  sublabel: string;
  icon: string;
  visual: NodeVisual;
  stepTitle?: string;
  [key: string]: unknown;
}

type PipeNode = Node<PipeNodeData, 'pipeline'>;

const ICONS: Record<string, LucideIcon> = {
  ShoppingCart, Zap, CreditCard, Webhook, ShieldCheck, Fingerprint, Database,
  RefreshCcw, LayoutDashboard, FileText, TimerReset,
};

const NODE_DEFS: { id: PipelineNodeId; label: string; sublabel: string; icon: string; x: number; y: number }[] = [
  { id: 'checkout', label: 'Checkout Session', sublabel: 'POST /v1/checkout/sessions', icon: 'ShoppingCart', x: 0, y: 0 },
  { id: 'stripe-api', label: 'Stripe API', sublabel: 'api.stripe.com', icon: 'Zap', x: 196, y: 0 },
  { id: 'payment', label: 'Payment Engine', sublabel: 'card charges · retries', icon: 'CreditCard', x: 392, y: 0 },
  { id: 'webhook', label: 'Webhook Delivery', sublabel: 'POST /api/webhooks/stripe', icon: 'Webhook', x: 588, y: 0 },
  { id: 'signature', label: 'Signature Verify', sublabel: 'HMAC-SHA256 · t,v1', icon: 'ShieldCheck', x: 784, y: 0 },
  { id: 'dedup', label: 'Idempotency Guard', sublabel: 'unique eventId', icon: 'Fingerprint', x: 980, y: 0 },
  { id: 'db', label: 'MongoDB Transaction', sublabel: 'ACID · replica set rs0', icon: 'Database', x: 1176, y: 0 },
  { id: 'invoice', label: 'Invoicing', sublabel: 'invoices · attempts', icon: 'FileText', x: 392, y: 170 },
  { id: 'retry-queue', label: 'Retry Queue', sublabel: 'exponential backoff', icon: 'TimerReset', x: 588, y: 170 },
  { id: 'dashboard', label: 'Dashboard', sublabel: 'polling · read-only replay', icon: 'LayoutDashboard', x: 980, y: 170 },
  { id: 'subscription', label: 'Subscription State', sublabel: 'lifecycle transitions', icon: 'RefreshCcw', x: 1176, y: 170 },
];

const EDGES: { id: string; source: string; target: string; sHandle?: string; tHandle?: string }[] = [
  { id: 'e1', source: 'checkout', target: 'stripe-api' },
  { id: 'e2', source: 'stripe-api', target: 'payment' },
  { id: 'e3', source: 'payment', target: 'webhook' },
  { id: 'e4', source: 'webhook', target: 'signature' },
  { id: 'e5', source: 'signature', target: 'dedup' },
  { id: 'e6', source: 'dedup', target: 'db' },
  { id: 'e7', source: 'db', target: 'subscription', sHandle: 'b', tHandle: 't' },
  { id: 'e8', source: 'subscription', target: 'dashboard', sHandle: 'l', tHandle: 'r' },
  { id: 'e9', source: 'payment', target: 'invoice', sHandle: 'b', tHandle: 't' },
  { id: 'e11', source: 'retry-queue', target: 'payment', sHandle: 'l', tHandle: 'b' },
  { id: 'e12', source: 'retry-queue', target: 'webhook', sHandle: 't', tHandle: 'b' },
];

/** Which edge leads into each node (for the in-transit glow). */
const INCOMING_EDGE: Record<string, string> = {
  'stripe-api': 'e1',
  payment: 'e2',
  webhook: 'e3',
  signature: 'e4',
  dedup: 'e5',
  db: 'e6',
  subscription: 'e7',
  dashboard: 'e8',
  invoice: 'e9',
};

const STEP_NODE_EDGE: Record<string, string> = {
  'stripe-api': 'e1', payment: 'e2', webhook: 'e3', signature: 'e4', dedup: 'e5',
  db: 'e6', subscription: 'e7', dashboard: 'e8', invoice: 'e9',
};

const VISUAL_CLASS: Record<NodeVisual, string> = {
  idle: 'border-border/70 opacity-60',
  done: 'border-emerald-500/60 shadow-[0_0_12px_-4px_rgba(16,185,129,0.5)]',
  active: 'border-[#635bff] shadow-[0_0_18px_-2px_rgba(99,91,255,0.65)] pipeline-node-active',
  failed: 'border-rose-500/70 bg-rose-500/[0.06] shadow-[0_0_14px_-4px_rgba(244,63,94,0.6)]',
  blocked: 'border-amber-500/70 bg-amber-500/[0.06] shadow-[0_0_14px_-4px_rgba(245,158,11,0.55)]',
};

const VISUAL_ICON: Record<NodeVisual, string> = {
  idle: 'text-muted-foreground/50',
  done: 'text-emerald-500',
  active: 'text-[#8b85ff]',
  failed: 'text-rose-500',
  blocked: 'text-amber-500',
};

function PipelineNode({ data }: NodeProps<PipeNode>) {
  const Icon = ICONS[data.icon] ?? Zap;
  return (
    <div
      data-testid={`node-${data.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      className={`w-[176px] rounded-xl border bg-card/90 backdrop-blur px-3 py-2.5 transition-all duration-300 ${VISUAL_CLASS[data.visual]}`}
    >
      <Handle type="target" position={Position.Left} id="l" className="!bg-border" />
      <Handle type="target" position={Position.Right} id="r" className="!bg-border" />
      <Handle type="target" position={Position.Top} id="t" className="!bg-border" />
      <Handle type="target" position={Position.Bottom} id="b" className="!bg-border" />
      <Handle type="source" position={Position.Left} id="sl" className="!bg-border" />
      <Handle type="source" position={Position.Right} id="r" className="!bg-border" />
      <Handle type="source" position={Position.Top} id="t" className="!bg-border" />
      <Handle type="source" position={Position.Bottom} id="b" className="!bg-border" />
      <div className="flex items-center gap-2">
        <div className={`rounded-md border border-border/60 bg-background/60 p-1.5 ${VISUAL_ICON[data.visual]}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold leading-tight">{data.label}</div>
          <div className="truncate font-mono text-[9px] leading-tight text-muted-foreground">{data.sublabel}</div>
        </div>
      </div>
      {data.stepTitle ? (
        <div className="mt-1.5 truncate border-t border-border/50 pt-1 text-[9px] text-muted-foreground">
          {data.stepTitle}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = { pipeline: PipelineNode };

export interface PipelineProps {
  steps: RunStepDoc[];
  playhead: number; // float; steps below floor are "consumed"
}

export default function Pipeline({ steps, playhead }: PipelineProps) {
  const consumed = Math.floor(playhead);
  const current = steps[consumed]; // step being consumed right now

  const { nodes, edges } = useMemo(() => {
    // Status per node from consumed steps only.
    const statusByNode = new Map<string, RunStepDoc>();
    for (const s of steps.slice(0, consumed)) {
      if (s.status !== 'pending') statusByNode.set(s.nodeId, s);
    }
    const activeNodeId = current && playhead - consumed > 0.12 ? current.nodeId : null;

    const nodes: PipeNode[] = NODE_DEFS.map((def) => {
      const last = statusByNode.get(def.id);
      let visual: NodeVisual = 'idle';
      if (last) {
        if (last.status === 'completed') visual = 'done';
        else if (last.status === 'failed') visual = 'failed';
        else if (last.status === 'blocked') visual = 'blocked';
        else if (last.status === 'running') visual = 'active';
      }
      if (def.id === activeNodeId) visual = 'active';
      return {
        id: def.id,
        type: 'pipeline' as const,
        position: { x: def.x, y: def.y },
        data: {
          label: def.label,
          sublabel: def.sublabel,
          icon: def.icon,
          visual,
          stepTitle: last ? `${last.idx}. ${last.title}` : undefined,
        },
      };
    });

    const activeEdgeId = activeNodeId ? STEP_NODE_EDGE[activeNodeId] : null;
    const failedNodeIds = new Set(
      [...statusByNode.entries()].filter(([, s]) => s.status === 'failed').map(([id]) => id),
    );

    const edges: Edge[] = EDGES.map((e) => {
      const isActive = e.id === activeEdgeId;
      const isFailed = failedNodeIds.has(e.target) || failedNodeIds.has(e.source);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sHandle ?? 'r',
        targetHandle: e.tHandle ?? 'l',
        type: 'smoothstep',
        animated: isActive,
        style: {
          stroke: isActive ? '#635bff' : isFailed ? 'rgba(244,63,94,0.45)' : 'rgba(128,128,140,0.3)',
          strokeWidth: isActive ? 2 : 1.4,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: isActive ? '#635bff' : 'rgba(128,128,140,0.4)' },
      };
    });

    return { nodes, edges };
  }, [steps, consumed, current, playhead]);

  return (
    <div className="h-full w-full" data-testid="pipeline-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.35}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        zoomOnDoubleClick={false}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
        <Controls position="bottom-right" showInteractive={false} className="!bg-card !border-border/60 [&>button]:!bg-card [&>button]:!border-border/60 [&>button]:!text-foreground [&>button:hover]:!bg-muted" />
      </ReactFlow>
    </div>
  );
}
