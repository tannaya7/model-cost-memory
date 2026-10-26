import type { Forecast, ModelEvidence, Recommendation, Verdict } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Card } from "../../../shared/components/Card";
import { CountUp } from "../../../shared/motion/CountUp";
import { findModel, range } from "../evidence";

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

function ModelNumbers({ label, model }: { label: string; model: ModelEvidence }) {
  return (
    <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-dim">{label}</span>
        <span className="font-mono text-xs font-bold text-ink">{model.model}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div>
          <div className="text-xs text-dim">Pass rate</div>
          <div className="font-mono text-lg font-bold text-ink">
            {model.weighted_pass_rate !== null ? (
              <CountUp value={model.weighted_pass_rate * 100} decimals={1} suffix="%" />
            ) : (
              "-"
            )}
          </div>
          {range(model) && <div className="font-mono text-[11px] text-dim">likely {range(model)}</div>}
        </div>
        <div>
          <div className="text-xs text-dim">Cost / success</div>
          <div className="font-mono text-lg font-bold text-ink">
            {model.cost_per_success_usd !== null ? (
              <CountUp value={model.cost_per_success_usd} decimals={4} prefix="$" />
            ) : (
              "-"
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function failuresText(n: number): string {
  const rounded = Math.round(Math.abs(n) * 10) / 10;
  return `${rounded} ${rounded === 1 ? "failure" : "failures"}`;
}

function ForecastPanel({ forecast }: { forecast: Forecast }) {
  const saving = forecast.monthly_saving_usd;
  const extra = forecast.extra_failures_per_month;
  return (
    <div className="space-y-3 rounded-card border border-rule bg-bg p-4">
      <div>
        <div className={`text-2xl font-bold tracking-tight ${saving >= 0 ? "text-ok" : "text-warn"}`}>
          {saving >= 0 ? "Save " : "Costs "}
          <CountUp value={Math.abs(saving)} decimals={2} prefix="$" />
          {saving >= 0 ? " a month" : " more a month"}
        </div>
        <p className="mt-0.5 text-xs text-dim">
          Based on {forecast.runs_per_month.toLocaleString()} runs in the last 30 days
        </p>
      </div>
      <div className="text-xs font-medium">
        {Math.abs(extra) < 0.05 ? (
          <span className="text-dim">No change in failures expected</span>
        ) : extra > 0 ? (
          <span className="text-warn">About {failuresText(extra)} more a month</span>
        ) : (
          <span className="text-ok">About {failuresText(extra)} fewer a month</span>
        )}
        <span className="text-dim">
          {" "}
          (likely between {forecast.extra_failures_low.toFixed(1)} and {forecast.extra_failures_high.toFixed(1)})
        </span>
      </div>
      <p className="text-xs text-dim">Estimate. Assumes next month looks like the last 30 days.</p>
    </div>
  );
}

export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const { verdict, warnings, progress, next_step, rules, models, current, recommended } = recommendation;
  const recommendedStats = findModel(recommendation, recommended?.model);
  const currentStats = findModel(recommendation, current?.model);

  let headline: string;
  if (verdict === "DOWNGRADE" || verdict === "SWITCH") {
    headline = `Use ${recommended?.model ?? "the recommended model"} instead of ${current?.model ?? "the current model"}`;
  } else if (verdict === "HOLD") {
    headline = `Keep using ${current?.model ?? "the current model"}`;
  } else {
    headline = `Gathering evidence for ${recommendation.job}`;
  }

  const highestWeight = models.reduce((max, m) => Math.max(max, m.evidence_weight), 0);
  const progressPct = Math.round(progress * 100);

  return (
    <Card className="space-y-5">
      {/* Header: Chip & Headline */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-bold tracking-tight text-ink">{headline}</h2>
        <div>{getVerdictChip(verdict)}</div>
      </div>

      {/* Optional plain-English summary, written from the figures below and never deciding anything */}
      {recommendation.summary && (
        <p className="rounded-card border border-accent/20 bg-accent-soft p-3 text-sm text-ink">
          {recommendation.summary}
        </p>
      )}

      {/* Warnings List with warn-colored left border */}
      {warnings.length > 0 && (
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

      {/* Side-by-side Numbers: Recommended vs Current (one panel when they are the same model) */}
      {verdict !== "INSUFFICIENT_EVIDENCE" && recommendedStats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ModelNumbers
            label={currentStats === recommendedStats ? "Current and recommended" : "Recommended"}
            model={recommendedStats}
          />
          {currentStats && currentStats !== recommendedStats && (
            <ModelNumbers label="Current" model={currentStats} />
          )}
        </div>
      )}

      {/* Savings Forecast Panel */}
      {recommendation.forecast && (
        <ForecastPanel forecast={recommendation.forecast} />
      )}

      {/* Progress Bar for INSUFFICIENT_EVIDENCE */}
      {verdict === "INSUFFICIENT_EVIDENCE" && (
        <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-ink">
              {highestWeight.toFixed(1)} of {rules.evidence_floor} weighted runs
            </span>
            <span className="font-mono text-dim">{progressPct}%</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-skeleton">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {next_step && <p className="text-xs text-dim italic">{next_step}</p>}
    </Card>
  );
}
