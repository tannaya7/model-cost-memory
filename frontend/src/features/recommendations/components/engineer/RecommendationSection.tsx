import { Link } from "react-router-dom";
import type { Recommendation, Verdict } from "../../../../shared/api/types";
import { CountUp } from "../../../../shared/motion/CountUp";
import { findModel, range } from "../../evidence";
import { DataTable, Hint, Section, day, usd } from "./Section";

const WORDS: Record<Verdict, string> = {
  SWITCH: "Your current model no longer does the job well enough.",
  DOWNGRADE: "A cheaper model does this job just as well.",
  HOLD: "Keep the current model; nothing cheaper passes as well.",
  INSUFFICIENT_EVIDENCE: "Not enough evidence yet to judge any model.",
};

const PILL: Record<Verdict, string> = {
  SWITCH: "bg-warn-soft text-warn border-warn/40",
  DOWNGRADE: "bg-ok-soft text-ok border-ok/40",
  HOLD: "bg-accent-soft text-accent border-accent/40",
  INSUFFICIENT_EVIDENCE: "bg-skeleton text-dim border-rule",
};

function Stat({ label, value, tone, sub }: { label: string; value: React.ReactNode; tone?: "good" | "warn" | "bad"; sub?: string }) {
  const color = tone === "good" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-ink";
  return (
    <div className="rounded-card border border-rule bg-bg p-3">
      <div className="text-xs text-dim">{label}</div>
      <div className={`mt-1 font-mono text-xl font-bold ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-dim">{sub}</div>}
    </div>
  );
}

/** "Which model should this job use?" and "The evidence behind it", laid out as in the prototype. */
export function RecommendationSection({ recommendation: r }: { recommendation: Recommendation }) {
  const endpoint = `GET /v1/jobs/${r.job}/recommendation`;
  const rc = findModel(r, r.recommended?.model);
  const cu = findModel(r, r.current?.model);
  const f = r.forecast;

  if (r.verdict === "INSUFFICIENT_EVIDENCE" || !r.recommended || !rc) {
    const best = r.models.reduce((m, x) => Math.max(m, x.evidence_weight), 0);
    return (
      <Section id="recommendation" title="Which model should this job use?" endpoint={endpoint} raw={r}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-md border px-3 py-1 font-mono text-sm font-bold ${PILL.INSUFFICIENT_EVIDENCE}`}>
            INSUFFICIENT_EVIDENCE
          </span>
          <span className="text-sm text-ink">
            {Math.round(r.progress * 100)}% · {best.toFixed(1)} of {r.rules.evidence_floor} weighted runs
            {r.next_step ? ` · ${r.next_step}` : ""}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-skeleton">
          <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.round(r.progress * 100)}%` }} />
        </div>
      </Section>
    );
  }

  const failingRows = r.evidence.failing_runs.map((x) => [
    <Link key="id" to={`/runs?job=${encodeURIComponent(r.job)}&outcome=FAIL`} title={x.run_id} className="font-mono text-xs text-accent hover:underline">
      {x.run_id.replace(/-/g, "").slice(0, 12)}
    </Link>,
    <span key="v" className="font-mono text-xs">{x.model_version}</span>,
    <span key="w" className="text-xs">{x.outcome_reason ?? "—"}</span>,
    <span key="d" className="whitespace-nowrap text-xs">{day(x.created_at)}</span>,
  ]);

  return (
    <Section id="recommendation" title="Which model should this job use?" endpoint={endpoint} raw={r}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-md border px-3 py-1 font-mono text-sm font-bold ${PILL[r.verdict]}`}>{r.verdict}</span>
        <div className="text-2xl font-bold tracking-tight text-ink">
          Use <span className="text-ok">{r.recommended.model}</span>{" "}
          <span className="font-mono text-sm font-normal text-dim">{r.recommended.model_version}</span>
          {r.current && r.verdict !== "HOLD" ? ` instead of ${r.current.model}` : ""}
        </div>
      </div>
      <Hint>{WORDS[r.verdict]}</Hint>

      {r.summary && <p className="rounded-card border border-accent/20 bg-accent-soft p-3 text-sm text-ink">{r.summary}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Pass rate · recommended"
          tone="good"
          value={rc.weighted_pass_rate !== null ? <CountUp value={rc.weighted_pass_rate * 100} decimals={1} suffix="%" /> : "—"}
          sub={range(rc) ? `likely ${range(rc)}` : undefined}
        />
        <Stat
          label={`Pass rate · current (${r.current?.model ?? "—"})`}
          value={cu?.weighted_pass_rate != null ? <CountUp value={cu.weighted_pass_rate * 100} decimals={1} suffix="%" /> : "—"}
          sub={cu && range(cu) ? `likely ${range(cu)}` : undefined}
        />
        <Stat label="Cost per success · recommended" value={usd(rc.cost_per_success_usd)} />
        <Stat label="Cost per success · current" value={usd(cu?.cost_per_success_usd)} />
        {f && (
          <>
            <Stat
              label="Money per month"
              tone={f.monthly_saving_usd >= 0 ? "good" : "warn"}
              value={`${f.monthly_saving_usd >= 0 ? "saves" : "costs"} ${usd(Math.abs(f.monthly_saving_usd), 2)}`}
              sub={`from ${f.runs_per_month.toLocaleString()} runs in 30 days`}
            />
            <Stat
              label="Failures per month"
              tone={f.extra_failures_per_month <= 0 ? "good" : "bad"}
              value={`${Math.abs(f.extra_failures_per_month).toFixed(1)} ${f.extra_failures_per_month <= 0 ? "fewer" : "more"}`}
              sub={`likely ${f.extra_failures_low.toFixed(1)} to ${f.extra_failures_high.toFixed(1)}`}
            />
          </>
        )}
      </div>

      {r.warnings.map((w, i) => (
        <div key={i} className="rounded-md border border-warn/50 bg-warn-soft px-3 py-2 text-sm text-ink">
          ⚠ {w}
        </div>
      ))}

      <div className="space-y-2">
        <h4 className="text-sm font-bold text-ink">The evidence behind it</h4>
        <Hint>
          {rc.n_runs.toLocaleString()} runs · freshness-weighted evidence {rc.evidence_weight.toFixed(2)} · {rc.failures}{" "}
          failures. Most recent failures, shown on purpose:
        </Hint>
        <DataTable head={["Run", "Version", "Why it failed", "When"]} rows={failingRows} empty="No failures." />
      </div>
    </Section>
  );
}
