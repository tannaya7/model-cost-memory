import { Link } from "react-router-dom";
import type { Recommendation } from "../../../shared/api/types";
import { Card } from "../../../shared/components/Card";
import { Badge } from "../../../shared/components/Badge";
import { STATUS_LABELS } from "../evidence";

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    );
  } catch {
    return iso;
  }
}

export function JobEvidenceSection({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const { evidence, models, recommended, job } = recommendation;
  const failures = models.reduce((sum, m) => sum + m.failures, 0);
  const notRecommendable = models.filter((m) => !m.eligible);

  return (
    <div className="space-y-6">
      {/* Evidence Section */}
      {evidence && (
        <Card className="space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-lg font-bold tracking-tight text-ink">Evidence</h3>
            {recommended && (
              <span className="font-mono text-xs text-dim">
                Recommended model:{" "}
                <span className="font-semibold text-ink">{recommended.model}</span>
                {recommended.model_version && ` (${recommended.model_version})`}
              </span>
            )}
          </div>

          {/* n_runs, failures, evidence_weight */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-card border border-rule bg-bg p-3">
              <div className="text-xs text-dim">Checked runs</div>
              <div className="font-mono text-xl font-bold text-ink">
                {evidence.n_runs.toLocaleString()}
              </div>
            </div>
            <div className="rounded-card border border-rule bg-bg p-3">
              <div className="text-xs text-dim">Failures</div>
              <div className="font-mono text-xl font-bold text-ink">
                {failures.toLocaleString()}
              </div>
            </div>
            <div className="rounded-card border border-rule bg-bg p-3">
              <div className="text-xs text-dim">Evidence weight</div>
              <div className="font-mono text-xl font-bold text-ink">
                {typeof evidence.evidence_weight === "number"
                  ? evidence.evidence_weight.toFixed(1)
                  : evidence.evidence_weight}
              </div>
            </div>
          </div>

          {/* Recent failing runs */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-dim">
                Recent failing runs
              </h4>
              <Link
                to={`/runs?job=${encodeURIComponent(job)}&outcome=FAIL`}
                className="text-xs font-medium text-accent hover:underline"
              >
                All failed runs →
              </Link>
            </div>

            {evidence.failing_runs.length > 0 ? (
              <div className="space-y-2">
                {evidence.failing_runs.map((run) => (
                  <Link
                    key={run.run_id}
                    to={`/runs?job=${encodeURIComponent(job)}&outcome=FAIL`}
                    className="block rounded-card border border-bad/30 bg-bad-soft p-3 text-xs transition-colors hover:border-bad/60 focus:outline-none"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-mono font-medium text-bad break-words">
                        {run.outcome_reason || "Failure without reason details."}
                      </p>
                      <span className="shrink-0 font-medium text-accent hover:underline">
                        View runs →
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[11px] text-dim">
                      <span>{run.model_version}</span>
                      <span>•</span>
                      <span>{formatDateTime(run.created_at)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-xs text-dim italic">
                No failures in the recent evidence.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Models that cannot be recommended (yet), and why */}
      {notRecommendable.length > 0 && (
        <Card className="space-y-3">
          <h3 className="text-base font-bold tracking-tight text-ink">
            Not recommended
          </h3>
          <div className="divide-y divide-rule">
            {notRecommendable.map((item) => (
              <div
                key={item.model}
                className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">
                    {item.model}
                  </span>
                  <Badge tone={STATUS_LABELS[item.status].tone}>{STATUS_LABELS[item.status].label}</Badge>
                </div>
                <span className="text-xs text-dim">{item.why}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
