/** Grey placeholder block. Size it to match the real content, not a spinner. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-skeleton ${className}`} />;
}

/** Skeleton shaped like a table, so the layout doesn't jump when data arrives. */
export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="rounded-card border border-rule bg-surface p-3"
    >
      <div className="grid gap-3">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className="h-5" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
