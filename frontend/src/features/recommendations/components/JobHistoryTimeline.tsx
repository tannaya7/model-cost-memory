import { Link } from "react-router-dom";
import type { HistoryEntry } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Card } from "../../../shared/components/Card";
import { EmptyState } from "../../../shared/components/EmptyState";
import { QueryState } from "../../../shared/components/QueryState";
import { useJobHistory } from "../hooks/useJobHistory";
import { getVerdictChip } from "./RecommendationCard";

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function getReasonChip(reason: HistoryEntry["supersession_reason"]) {
  switch (reason) {
    case "MODEL_UPGRADE":
      return <Badge tone="accent">Model upgrade</Badge>;
    case "EVIDENCE_DECAYED":
      return <Badge tone="neutral">Evidence went stale</Badge>;
    case "REGRESSION":
      return <Badge tone="bad">Regression</Badge>;
    case "MODEL_RETIRED":
      return <Badge tone="warn">Model retired</Badge>;
    case "NEW_EVIDENCE":
      return <Badge tone="neutral">New evidence</Badge>;
    default:
      return null;
  }
}

export function JobHistoryTimeline({ jobName }: { jobName: string }) {
  const query = useJobHistory(jobName);

  return (
    <QueryState
      query={query}
      emptyTitle="No recommendation has been made for this job yet."
      emptyHint="Record runs to trigger model recommendations."
    >
      {({ entries: history, versions }) => {
        if (history.length === 0) {
          return (
            <EmptyState
              title="No recommendation has been made for this job yet."
              hint="Record runs to trigger model recommendations."
            />
          );
        }

        // Map for fast lookup of superseded_by model name
        const historyMap = new Map(
          history.map((h) => [h.recommendation_id, h]),
        );

        return (
          <div className="space-y-6">
          <div className="relative space-y-6 pl-6 before:absolute before:bottom-3 before:left-2 before:top-3 before:w-0.5 before:bg-rule">
            {history.map((entry) => {
              const isCurrent = entry.invalid_at === null;
              const supersededBy = entry.superseded_by_id
                ? historyMap.get(entry.superseded_by_id)
                : null;

              const dateLabel = isCurrent
                ? `since ${formatTimestamp(entry.valid_at)}`
                : `${formatTimestamp(entry.valid_at)} to ${formatTimestamp(
                    entry.invalid_at!,
                  )}`;

              return (
                <div key={entry.recommendation_id} className="relative">
                  {/* Timeline node dot */}
                  <div
                    className={`absolute -left-[22px] top-4.5 h-3.5 w-3.5 rounded-full border-2 border-surface ${
                      isCurrent ? "bg-ok" : "bg-rule"
                    }`}
                  />

                  <Card className="space-y-4">
                    {/* Header: Date Range, Badges */}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-dim">
                          {dateLabel}
                        </span>
                        {isCurrent && <Badge tone="ok">Current</Badge>}
                        {entry.supersession_reason &&
                          getReasonChip(entry.supersession_reason)}
                      </div>
                      <div className="flex items-center gap-2">
                        {getVerdictChip(entry.verdict)}
                      </div>
                    </div>

                    {/* Model Info & Replaced notice */}
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                      <div>
                        <span className="text-base font-bold text-ink">
                          {entry.model || "No model yet"}
                        </span>
                        <span className="ml-2 font-mono text-xs text-dim">
                          {entry.model_version}
                        </span>
                        {entry.current_model && entry.current_model !== entry.model && (
                          <span className="ml-2 text-xs text-dim">
                            instead of <span className="font-mono text-ink">{entry.current_model}</span>
                          </span>
                        )}
                      </div>

                      {supersededBy && (
                        <div className="text-xs text-dim">
                          Replaced by{" "}
                          <span className="font-mono font-semibold text-ink">
                            {supersededBy.model}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Numbers: Pass rate, Cost per success, built from N runs */}
                    <div className="grid grid-cols-1 gap-3 rounded-card border border-rule bg-bg p-3 sm:grid-cols-3">
                      <div>
                        <div className="text-xs text-dim">Pass rate</div>
                        <div className="font-mono text-base font-bold text-ink">
                          {entry.weighted_pass_rate !== null
                            ? `${(entry.weighted_pass_rate * 100).toFixed(1)}%`
                            : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-dim">Cost / success</div>
                        <div className="font-mono text-base font-bold text-ink">
                          {entry.cost_per_success_usd !== null
                            ? `$${entry.cost_per_success_usd.toFixed(4)}`
                            : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-dim">Evidence</div>
                        <div className="text-xs font-medium text-ink">
                          built from {entry.n_runs.toLocaleString()} runs
                        </div>
                        <div className="font-mono text-[11px] text-dim">
                          weight: {entry.evidence_weight.toFixed(1)}
                        </div>
                      </div>
                    </div>

                    {/* Footer link to runs */}
                    <div className="flex justify-end pt-1">
                      <Link
                        to={`/runs?recommendation=${entry.recommendation_id}`}
                        className="text-xs font-semibold text-accent hover:underline"
                      >
                        See these runs →
                      </Link>
                    </div>
                  </Card>
                </div>
              );
            })}
          </div>

          <Card className="space-y-3">
            <h3 className="text-base font-bold tracking-tight text-ink">Model versions this job ran on</h3>
            <div className="divide-y divide-rule">
              {versions.map((v) => (
                <div
                  key={`${v.model}|${v.model_version}`}
                  className="flex flex-col gap-1 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="font-mono text-ink">{v.model_version}</span>
                  <span className="text-dim">
                    {v.runs.toLocaleString()} runs · {formatTimestamp(v.first_seen)} to {formatTimestamp(v.last_seen)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
          </div>
        );
      }}
    </QueryState>
  );
}
