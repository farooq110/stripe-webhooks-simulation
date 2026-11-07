'use client';

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
