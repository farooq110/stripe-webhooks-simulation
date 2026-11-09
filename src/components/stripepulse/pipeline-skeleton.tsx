'use client';

import { Play } from 'lucide-react';

// Shown only while the first /api/state poll is still in flight — the
// database may genuinely still be connecting, so a spinner is honest here.
export function PipelineSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center" data-testid="pipeline-skeleton">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#635bff] border-t-transparent" />
        <div className="font-mono text-[10px] text-muted-foreground">connecting to MongoDB & gateway…</div>
      </div>
    </div>
  );
}

// Shown once state is loaded but no run exists (e.g. after a database reset).
// An eternal spinner here would look like the app is stuck, so say what is
// actually going on and what to do next.
export function PipelineEmptyState() {
  return (
    <div className="flex h-full w-full items-center justify-center" data-testid="pipeline-empty">
      <div className="max-w-xs space-y-2.5 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#635bff]/30 bg-[#635bff]/10">
          <Play className="h-4 w-4 text-[#8b85ff]" />
        </div>
        <div className="text-sm font-medium text-foreground">No runs yet</div>
        <div className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          MongoDB and the gateway are connected. Pick a scenario on the left and press Start — the webhook pipeline will light up here.
        </div>
      </div>
    </div>
  );
}
