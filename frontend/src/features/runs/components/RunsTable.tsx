import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Run } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function RunsTable({
  runs,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  onSelectRun,
}: {
  runs: Run[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  onSelectRun: (runId: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });

  return (
    <div className="space-y-3">
      <div
        ref={parentRef}
        tabIndex={0}
        aria-label="Runs list table"
        className="h-[600px] overflow-auto rounded-card border border-rule bg-surface focus:outline-none"
      >
        <div className="min-w-[950px]">
          {/* Table Header */}
          <div className="sticky top-0 z-10 grid grid-cols-[140px_130px_90px_90px_95px_minmax(140px,1fr)_95px_95px_90px] items-center gap-2 border-b border-rule bg-surface px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-dim shadow-xs">
            <div>Time</div>
            <div>Job</div>
            <div>Model</div>
            <div>Version</div>
            <div>Outcome</div>
            <div>Reason</div>
            <div className="text-right">Cost</div>
            <div className="text-right">Tokens</div>
            <div className="text-right">Latency</div>
          </div>

          {/* Virtual Rows */}
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const run = runs[virtualRow.index];
              return (
                <div
                  key={run.run_id}
                  onClick={() => onSelectRun(run.run_id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectRun(run.run_id);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`View details for run ${run.run_id}`}
                  className="absolute left-0 top-0 grid w-full grid-cols-[140px_130px_90px_90px_95px_minmax(140px,1fr)_95px_95px_90px] items-center gap-2 border-b border-rule px-3 text-sm transition-colors hover:bg-bg focus:bg-accent-soft/30 focus:outline-none cursor-pointer"
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="truncate text-xs text-dim">
                    {formatDateTime(run.created_at)}
                  </div>
                  <div className="truncate font-medium text-ink" title={run.job}>
                    {run.job}
                  </div>
                  <div className="truncate font-mono text-xs text-dim" title={run.model}>
                    {run.model}
                  </div>
                  <div className="truncate font-mono text-xs text-dim" title={run.model_version}>
                    {run.model_version}
                  </div>
                  <div>
                    <Badge
                      tone={
                        run.outcome === "PASS"
                          ? "ok"
                          : run.outcome === "FAIL"
                          ? "bad"
                          : "neutral"
                      }
                    >
                      {run.outcome}
                    </Badge>
                  </div>
                  <div
                    className="truncate text-xs text-dim"
                    title={run.outcome_reason ?? undefined}
                  >
                    {run.outcome_reason ?? "-"}
                  </div>
                  <div className="text-right font-mono text-xs text-ink">
                    {run.cost_usd !== null ? `$${run.cost_usd.toFixed(4)}` : "—"}
                  </div>
                  <div
                    className="text-right font-mono text-xs text-ink cursor-help"
                    title={`in: ${run.tokens_in} / out: ${run.tokens_out}${
                      run.cache_read_tokens ? ` / cache read: ${run.cache_read_tokens}` : ""
                    }`}
                  >
                    {run.tokens_in + run.tokens_out}
                  </div>
                  <div className="text-right font-mono text-xs text-dim">
                    {run.latency_ms !== null ? `${run.latency_ms} ms` : "-"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {hasNextPage && (
        <button
          type="button"
          onClick={fetchNextPage}
          disabled={isFetchingNextPage}
          className="w-full rounded-md border border-rule bg-surface py-2.5 text-sm font-semibold text-accent hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {isFetchingNextPage ? "Loading more runs..." : "Load more"}
        </button>
      )}
    </div>
  );
}
