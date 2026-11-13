/** The decision for one job, in words first, then the picture that proves it. */
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import type { ModelEvidence, Recommendation } from "../../shared/api/types";
import { ChartFrame } from "../../ui/charts/ChartFrame";
import { CostQualityMap } from "../../ui/charts/charts";
import { colorMap } from "../../ui/charts/series";
import { MODEL_STATUS, pct, usd, type ModelStatus } from "../../ui/format";
import { IconAlert, IconArrowRight, IconFlask, IconSpark } from "../../ui/icons";
import { ButtonLink, ModelName, Panel, PanelHeader, Pill, Reveal } from "../../ui/primitives";

function headline(rec: Recommendation): { title: React.ReactNode; body: string } {
  const cur = rec.current?.model;
  const to = rec.recommended?.model;
  const curStats = rec.models.find((m) => m.model === cur);
  const toStats = rec.models.find((m) => m.model === to);
  const points = Math.round(rec.rules.margin * 100);
  const cheaper =
    curStats?.cost_per_success_usd && toStats?.cost_per_success_usd
      ? curStats.cost_per_success_usd / toStats.cost_per_success_usd
      : null;
  switch (rec.verdict) {
    case "DOWNGRADE":
      return {
        title: <>Move to <span className="text-gradient">{to}</span></>,
        body: `${to} passes ${pct(toStats?.weighted_pass_rate)} of the time, within ${points} points of the best model${
          cheaper && cheaper > 1.05 ? `, at ${cheaper >= 10 ? Math.round(cheaper) : cheaper.toFixed(1)}× less per successful answer` : ""
        }. The system is ${Math.round(rec.rules.switch_confidence * 100)}% sure before it advises a move like this.`,
      };
    case "SWITCH":
      return {
        title: <>Move to <span className="text-gradient">{to}</span></>,
        body: `${cur} fails more often than ${to}: ${pct(curStats?.weighted_pass_rate)} against ${pct(toStats?.weighted_pass_rate)}. The better model is worth what it costs here.`,
      };
    case "HOLD":
      return {
        title: <>Keep using <span className="text-gradient">{cur}</span></>,
        body: `No cheaper model is proven to do this job within ${points} points of the best. ${cur} stays the right choice until the evidence says otherwise.`,
      };
    default:
      return {
        title: <>Still learning</>,
        body: `There are not enough checked runs to judge this job yet. A verdict appears once the evidence reaches ${rec.rules.evidence_floor} fresh runs on a model.`,
      };
  }
}

function ModelCard({ label, m, highlight }: { label: string; m: ModelEvidence | undefined; highlight?: boolean }) {
  if (!m) return null;
  return (
    <div className={`rounded-[14px] border p-4 ${highlight ? "border-accent/50 bg-accent-soft/40" : "border-rule bg-surface-2/50"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-[15px] font-semibold text-ink">{m.model}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-[11px] text-muted">Pass rate</dt>
          <dd className="tabular text-lg font-semibold text-ink">{pct(m.weighted_pass_rate)}</dd>
          {m.pass_rate_low !== null && (
            <dd className="tabular text-[11px] text-muted">likely {pct(m.pass_rate_low, 0)}–{pct(m.pass_rate_high, 0)}</dd>
          )}
        </div>
        <div>
          <dt className="text-[11px] text-muted">Per successful answer</dt>
          <dd className="tabular text-lg font-semibold text-ink">{usd(m.cost_per_success_usd)}</dd>
          <dd className="tabular text-[11px] text-muted">{m.n_runs.toLocaleString("en")} checked runs</dd>
        </div>
      </dl>
    </div>
  );
}

export function VerdictTab({ rec }: { rec: Recommendation }) {
  const { title, body } = headline(rec);
  const cur = rec.models.find((m) => m.model === rec.current?.model);
  const to = rec.models.find((m) => m.model === rec.recommended?.model);
  const moving = rec.recommended && rec.current && rec.recommended.model !== rec.current.model;
  const colors = colorMap(rec.models.map((m) => m.model));
  const reference = rec.models.find((m) => m.model === rec.reference);
  const floor = reference?.weighted_pass_rate != null ? reference.weighted_pass_rate - rec.rules.margin : null;
  const f = rec.forecast;

  return (
    <div className="flex flex-col gap-4">
      <Panel glow className="p-6 md:p-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">
              <IconSpark size={14} className="text-accent" /> The verdict
            </p>
            <h2 className="text-[30px] font-semibold leading-tight tracking-tight md:text-[40px]">{title}</h2>
            <p className="max-w-xl text-[15px] leading-relaxed text-dim">{body}</p>
            {rec.summary && (
              <blockquote className="max-w-xl border-l-2 border-accent/60 pl-3 text-sm italic text-dim">“{rec.summary}”</blockquote>
            )}
            {rec.verdict === "INSUFFICIENT_EVIDENCE" && (
              <div className="max-w-md">
                <div className="mb-1.5 flex justify-between text-xs text-muted">
                  <span>Evidence collected</span>
                  <span className="tabular">{Math.round(rec.progress * 100)}%</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-surface-3">
                  <motion.div
                    className="h-full rounded-full bg-gradient-to-r from-[#9d91ff] to-accent-2"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.round(rec.progress * 100)}%` }}
                    transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </div>
            )}
            {(rec.retest_candidates.length > 0 || rec.next_step) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {rec.retest_candidates.map((model) => (
                  <ButtonLink key={model} to={`/retest?job=${encodeURIComponent(rec.job)}&model=${encodeURIComponent(model)}`} variant="primary" size="sm">
                    <IconFlask size={14} /> Re-test {model}
                  </ButtonLink>
                ))}
                {rec.next_step && <p className="text-xs text-muted">{rec.next_step}</p>}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {moving ? (
              <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                <ModelCard label="In use now" m={cur} />
                <IconArrowRight size={20} className="mx-auto rotate-90 text-accent sm:rotate-0" />
                <ModelCard label="Recommended" m={to} highlight />
              </div>
            ) : (
              <ModelCard label={rec.verdict === "HOLD" ? "In use and recommended" : "In use now"} m={cur ?? to} highlight={rec.verdict === "HOLD"} />
            )}
            {f && (rec.verdict === "DOWNGRADE" || rec.verdict === "SWITCH") && (
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[14px] border border-rule bg-surface-2/50 p-4">
                  <p className="text-[11px] text-muted">{f.monthly_saving_usd >= 0 ? "Saved per month" : "Extra cost per month"}</p>
                  <p className={`tabular text-2xl font-semibold ${f.monthly_saving_usd >= 0 ? "text-ok" : "text-warn"}`}>{usd(Math.abs(f.monthly_saving_usd))}</p>
                  <p className="text-[11px] text-muted">at {f.runs_per_month.toLocaleString("en")} runs a month</p>
                </div>
                <div className="rounded-[14px] border border-rule bg-surface-2/50 p-4">
                  <p className="text-[11px] text-muted">{f.extra_failures_per_month > 0 ? "Extra failures per month" : "Fewer failures per month"}</p>
                  <p className="tabular text-2xl font-semibold text-ink">{Math.abs(f.extra_failures_per_month).toFixed(1)}</p>
                  <p className="tabular text-[11px] text-muted">likely {f.extra_failures_low.toFixed(1)} to {f.extra_failures_high.toFixed(1)}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </Panel>

      {rec.warnings.length > 0 && (
        <Reveal className="flex flex-col gap-2">
          {rec.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-[12px] border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn">
              <IconAlert size={16} className="mt-0.5 shrink-0" /> {w}
            </p>
          ))}
        </Reveal>
      )}

      <Reveal delay={0.08}>
        <Panel className="p-5 md:p-6">
          <ChartFrame
            title="Every model you have tried, on cost and quality"
            hint={
              <>
                Up is more reliable, left is cheaper. The green band is good enough: within {Math.round(rec.rules.margin * 100)} points of the best model.
                The cheapest model inside it wins. Bars show where each pass rate likely lies ({Math.round(rec.rules.confidence * 100)}% range).
              </>
            }
            table={{
              columns: ["Model", "Pass rate", "Likely range", "Cost / success", "Checked runs", "Judged"],
              rows: rec.models.map((m) => [
                m.model,
                pct(m.weighted_pass_rate),
                m.pass_rate_low !== null ? `${pct(m.pass_rate_low)} – ${pct(m.pass_rate_high)}` : "–",
                usd(m.cost_per_success_usd),
                m.n_runs.toLocaleString("en"),
                MODEL_STATUS[m.status as ModelStatus].label,
              ]),
            }}
          >
            <CostQualityMap models={rec.models} colors={colors} recommended={rec.recommended?.model} current={rec.current?.model} floor={floor} />
          </ChartFrame>
        </Panel>
      </Reveal>

      <Reveal delay={0.12}>
        <Panel className="p-5 md:p-6">
          <PanelHeader title="How each model was judged" hint="The rule: cheapest model whose pass rate is proven within the tolerance of the best" />
          <ul className="mt-4 divide-y divide-rule">
            {[...rec.models]
              .sort((a, b) => (a.cost_per_success_usd ?? Infinity) - (b.cost_per_success_usd ?? Infinity))
              .map((m) => {
                const s = MODEL_STATUS[m.status as ModelStatus];
                return (
                  <li key={m.model} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: colors.get(m.model) }} aria-hidden />
                        <ModelName>{m.model}</ModelName>
                        {m.model === rec.recommended?.model && <Pill tone="accent" icon={false}>recommended</Pill>}
                        {m.model === rec.current?.model && <Pill tone="neutral" icon={false}>in use</Pill>}
                        {m.catalog_status !== "ACTIVE" && m.catalog_status !== "UNKNOWN" && <Pill tone="warn">{m.catalog_status.toLowerCase()}</Pill>}
                      </div>
                      <p className="mt-1 text-xs text-dim">{m.why}</p>
                    </div>
                    <div className="flex items-center gap-4 sm:justify-end">
                      <span className="tabular text-sm text-dim">{pct(m.weighted_pass_rate)} · {usd(m.cost_per_success_usd)}</span>
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </div>
                  </li>
                );
              })}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Based on {rec.evidence.n_runs.toLocaleString("en")} checked runs. Older runs count less, and runs on a superseded model version fade faster.{" "}
            <Link to={`?tab=runs`} className="text-accent hover:underline">See the runs</Link>
          </p>
        </Panel>
      </Reveal>
    </div>
  );
}
