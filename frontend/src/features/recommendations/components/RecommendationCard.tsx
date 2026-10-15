import type { Recommendation, Verdict } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Card } from "../../../shared/components/Card";

export function getVerdictChip(verdict: Verdict) {
  switch (verdict) {
    case "DOWNGRADE":
      return <Badge tone="ok">Cheaper model available</Badge>;
    case "SWITCH":
      return <Badge tone="warn">Switch model</Badge>;
    case "HOLD":
      return <Badge tone="neutral">Keep current model</Badge>;
    case "INSUFFICIENT_EVIDENCE":
      return <Badge tone="neutral">Not enough evidence yet</Badge>;
  }
}

export function RecommendationCard({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const { verdict, comparison, forecast, warnings, progress, next_step, rules, candidates } =
    recommendation;

  let headline = "";
  if (verdict === "DOWNGRADE" || verdict === "SWITCH") {
    headline = `Use ${recommendation.recommended?.model ?? "recommended model"} instead of ${
      recommendation.current_model ?? "current model"
    }`;
  } else if (verdict === "HOLD") {
    headline = `Keep using ${recommendation.current_model ?? "current model"}`;
  } else {
    headline = `Gathering evidence for ${recommendation.job}`;
  }

  // Compute progress percentage for INSUFFICIENT_EVIDENCE
  const highestWeight = candidates?.reduce(
    (max, c) => Math.max(max, c.evidence_weight),
    0,
  ) ?? 0;
  const floor = rules?.evidence_floor || 25;
  const progressPct = Math.min(100, Math.max(0, Math.round((highestWeight / floor) * 100)));

  return (
    <Card className="space-y-5">
      {/* Header: Chip & Headline */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-bold tracking-tight text-ink">{headline}</h2>
        <div>{getVerdictChip(verdict)}</div>
      </div>

      {/* Warnings List with warn-colored left border */}
      {warnings && warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((warn, i) => (
            <div
              key={i}
              className="rounded-r-md border-l-4 border-warn bg-warn-soft p-3 text-xs font-medium text-warn"
            >
              {warn}
            </div>
          ))}
        </div>
      )}

      {/* Side-by-side Numbers: Recommended vs Current */}
      {verdict !== "INSUFFICIENT_EVIDENCE" && comparison && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Recommended Model */}
          <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                Recommended
              </span>
              <span className="font-mono text-xs font-bold text-ink">
                {comparison.recommended.model}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <div className="text-xs text-dim">Pass rate</div>
                <div className="font-mono text-lg font-bold text-ink">
                  {(comparison.recommended.weighted_pass_rate * 100).toFixed(1)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-dim">Cost / success</div>
                <div className="font-mono text-lg font-bold text-ink">
                  {comparison.recommended.cost_per_success_usd !== null
                    ? `$${comparison.recommended.cost_per_success_usd.toFixed(4)}`
                    : "-"}
                </div>
              </div>
            </div>
          </div>

          {/* Current Model */}
          {comparison.current ? (
            <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                  Current
                </span>
                <span className="font-mono text-xs font-bold text-ink">
                  {comparison.current.model}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <div className="text-xs text-dim">Pass rate</div>
                  <div className="font-mono text-lg font-bold text-ink">
                    {(comparison.current.weighted_pass_rate * 100).toFixed(1)}%
                  </div>
                </div>
                <div>
                  <div className="text-xs text-dim">Cost / success</div>
                  <div className="font-mono text-lg font-bold text-ink">
                    {comparison.current.cost_per_success_usd !== null
                      ? `$${comparison.current.cost_per_success_usd.toFixed(4)}`
                      : "-"}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center rounded-card border border-rule bg-bg p-4 text-xs text-dim italic">
              No current model recorded
            </div>
          )}
        </div>
      )}

      {/* Forecast Note if applicable */}
      {forecast && (
        <div className="rounded-md border border-rule bg-bg p-3 text-xs text-dim">
          <span className="font-semibold text-ink">Estimated impact: </span>
          {forecast.monthly_saving_usd >= 0 ? (
            <span className="font-semibold text-ok">
              ${forecast.monthly_saving_usd.toFixed(2)}/mo savings
            </span>
          ) : (
            <span className="font-semibold text-warn">
              costs ${Math.abs(forecast.monthly_saving_usd).toFixed(2)}/mo more
            </span>
          )}
          {forecast.extra_failures_per_month !== 0 && (
            <span>
              {" "}
              with {forecast.extra_failures_per_month > 0 ? "+" : ""}
              {forecast.extra_failures_per_month} failures/mo.
            </span>
          )}
        </div>
      )}

      {/* Progress Bar for INSUFFICIENT_EVIDENCE */}
      {verdict === "INSUFFICIENT_EVIDENCE" && (
        <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-ink">
              {progress || `${highestWeight} of ${floor} weighted runs`}
            </span>
            <span className="font-mono text-dim">{progressPct}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-skeleton">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {next_step && <p className="text-xs text-dim italic">{next_step}</p>}
        </div>
      )}
    </Card>
  );
}
