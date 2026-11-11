import { useEffect } from "react";
import { useRunDetail } from "../hooks/useRunDetail";
import { Badge } from "../../../shared/components/Badge";
import { Skeleton } from "../../../shared/components/Skeleton";
import { RunLabelForm } from "./RunLabelForm";

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    });
  } catch {
    return iso;
  }
}

function formatOutput(output: string | null): string {
  if (!output) return "";
  try {
    const parsed = JSON.parse(output);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return output;
  }
}

export function RunDetailPanel({
  runId,
  onClose,
}: {
  runId: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!runId) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runId, onClose]);

  const { data: run, isPending, isError, error } = useRunDetail(runId);

  if (!runId) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-overlay/50 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-detail-title"
        className="relative z-50 flex h-full w-full max-w-2xl flex-col border-l border-rule bg-surface shadow-2xl overflow-y-auto"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-rule bg-surface px-6 py-4">
          <div>
            <h2 id="run-detail-title" className="text-lg font-bold text-ink">
              Run Details
            </h2>
            <p className="font-mono text-xs text-dim">{runId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            className="rounded-md p-1.5 text-dim hover:bg-bg hover:text-ink focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {isPending && (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}

          {isError && (
            <div className="rounded-md border border-bad bg-bad-soft p-4 text-sm text-bad">
              <p className="font-semibold">Failed to load run details.</p>
              <p className="mt-1">
                {error instanceof Error ? error.message : "An error occurred."}
              </p>
            </div>
          )}

          {run && (
            <>
              {/* Outcome Banner */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-rule bg-bg p-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-dim">Outcome:</span>
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
                <div className="text-xs text-dim">
                  Recorded on {formatDateTime(run.created_at)}
                </div>
              </div>

              {/* FAIL Reason Alert */}
              {run.outcome === "FAIL" && run.outcome_reason && (
                <div
                  role="alert"
                  className="rounded-md border border-bad bg-bad-soft p-4 text-sm text-bad"
                >
                  <p className="font-semibold">Failure Reason:</p>
                  <p className="mt-1 font-mono text-xs whitespace-pre-wrap">{run.outcome_reason}</p>
                </div>
              )}

              {run.outcome === "UNKNOWN" && <RunLabelForm key={run.run_id} runId={run.run_id} />}

              {/* Metadata Grid */}
              <div className="grid grid-cols-2 gap-4 rounded-card border border-rule p-4 text-sm sm:grid-cols-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Job</div>
                  <div className="mt-1 font-medium text-ink">{run.job}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Model</div>
                  <div className="mt-1 font-mono text-xs text-ink">{run.model}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Model Version</div>
                  <div className="mt-1 font-mono text-xs text-dim">{run.model_version}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Prompt Version</div>
                  <div className="mt-1 font-mono text-xs text-dim">{run.prompt_version ?? "-"}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Run Kind</div>
                  <div className="mt-1">
                    <Badge tone="accent">{run.run_kind}</Badge>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">State</div>
                  <div className="mt-1">
                    <Badge tone="neutral">{run.state}</Badge>
                  </div>
                </div>
              </div>

              {/* Metrics: Tokens, Cost, Latency */}
              <div className="grid grid-cols-2 gap-4 rounded-card border border-rule p-4 text-sm sm:grid-cols-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Cost</div>
                  <div className="mt-1 font-mono text-base font-semibold text-ink">
                    {run.cost_usd !== null ? `$${run.cost_usd.toFixed(4)}` : "no price"}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Latency</div>
                  <div className="mt-1 font-mono text-base text-ink">
                    {run.latency_ms !== null ? `${run.latency_ms} ms` : "-"}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Tokens In / Out</div>
                  <div className="mt-1 font-mono text-xs text-ink">
                    {run.tokens_in} in / {run.tokens_out} out
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim">Cache Tokens</div>
                  <div className="mt-1 font-mono text-xs text-dim">
                    R: {run.cache_read_tokens} / W: {run.cache_write_tokens}
                  </div>
                </div>
              </div>

              {/* Full Prompt */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-dim">
                  Full Prompt
                </h3>
                <div className="rounded-md border border-rule bg-bg p-3">
                  <pre className="font-mono text-xs text-ink whitespace-pre-wrap break-words">
                    {run.prompt}
                  </pre>
                </div>
              </div>

              {/* Full Output */}
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-dim">
                  Full Output
                </h3>
                <div className="rounded-md border border-rule bg-bg p-3">
                  {run.output ? (
                    <pre className="font-mono text-xs text-ink whitespace-pre-wrap break-words">
                      {formatOutput(run.output)}
                    </pre>
                  ) : (
                    <p className="italic text-dim text-xs">No output recorded</p>
                  )}
                </div>
              </div>

              {/* Tool Calls */}
              {run.tool_calls && run.tool_calls.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-dim">
                    Tool Calls ({run.tool_calls.length})
                  </h3>
                  <div className="space-y-2">
                    {run.tool_calls.map((call, idx) => (
                      <div
                        key={idx}
                        className="rounded-md border border-rule bg-bg p-3 text-xs font-mono"
                      >
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(call, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
