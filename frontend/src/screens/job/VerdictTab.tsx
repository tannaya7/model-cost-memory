/** The decision for one AI task, in words first, then the picture that proves it. */
import { useP } from "../../app/project";
import { Link } from "react-router-dom";
import type { ModelEvidence, Recommendation } from "../../shared/api/types";
import { ChartFrame } from "../../ui/charts/ChartFrame";
import { CostQualityMap } from "../../ui/charts/charts";
import { colorMap } from "../../ui/charts/series";
import { MODEL_STATUS, pct, usd, type ModelStatus } from "../../ui/format";
import { IconAlert, IconArrowRight, IconFlask, IconSpark } from "../../ui/icons";
import { UNTESTED_LABEL } from "../compare/wilson";
import { Help } from "../../ui/Help";
import { TwoStageBar } from "../../ui/NotEnoughData";
import { confidenceWords, promisingDetails, promisingLine, promisingOf, PROMISING_ACTION, PROMISING_LABEL, TRIAL_BUDGET_NOTE, twoStage } from "../promising";
import { evidenceSoFar } from "../shared";
import { buildWhy } from "./why";
import { NOT_A_BENCHMARK, volumeWords, wrongAnswerWords } from "../forecastText";
import { serverText } from "../../features/projects/moneyWording";
import { useBillingMode } from "../../features/projects/hooks/useBillingMode";
import { ButtonLink, ModelName, Panel, PanelHeader, Pill, Reveal } from "../../ui/primitives";

/** Shown under the AI-written summary. */
export const AI_SUMMARY_NOTE = "Written by AI from the figures below; it may be wrong.";

function headline(rec: Recommendation, billing: string): { title: React.ReactNode; body: string } {
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
        body: `${to} gets ${pct(toStats?.weighted_pass_rate)} of answers correct, within ${points} points of both the best model and your current one${
          billing !== "subscription" && cheaper && cheaper > 1.05 ? `, at ${cheaper >= 10 ? Math.round(cheaper) : cheaper.toFixed(1)}× less per successful answer` : ""
        }.`,
      };
    case "SWITCH":
      return {
        title: <>Move to <span className="text-gradient">{to}</span></>,
        body: `${cur} fails more often than ${to}: ${pct(curStats?.weighted_pass_rate)} against ${pct(toStats?.weighted_pass_rate)}. We only advise this when we are very sure the difference is real.`,
      };
    case "HOLD":
      return {
        title: <>Keep using <span className="text-gradient">{cur}</span></>,
        body: `No cheaper model is shown to do this task within ${points} points of both the best model and ${cur}. ${cur} stays the right choice until the evidence says otherwise.`,
      };
    default:
      return {
        title: <>Still learning</>,
        body: `Not enough checked answers yet. We need at least ${rec.rules.evidence_floor} to give you a recommendation. You have ${evidenceSoFar(rec)} so far on your best-covered model.`,
      };
  }
}

function ModelCard({ label, m, highlight, billing = "per_use" }: { label: string; m: ModelEvidence | undefined; highlight?: boolean; billing?: string }) {
  if (!m) return null;
  return (
    <div className={`rounded-[14px] border p-4 ${highlight ? "border-accent/50 bg-accent-soft/40" : "border-rule bg-surface-2/50"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-[15px] font-semibold text-ink">{m.model}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="flex min-h-[2.4em] items-end text-[11px] leading-tight text-muted">Correct answers</dt>
          <dd className="tabular text-lg font-semibold text-ink">{pct(m.weighted_pass_rate)}</dd>
          {m.pass_rate_low !== null && (
            <dd className="tabular text-[11px] text-muted">likely {pct(m.pass_rate_low, 0)}–{pct(m.pass_rate_high, 0)}</dd>
          )}
          <dd className="mt-1 text-[11px] leading-snug text-muted">Out of every 100 answers we checked, about {Math.round((m.weighted_pass_rate ?? 0) * 100)} were right.</dd>
        </div>
        <div>
          <dt className="flex min-h-[2.4em] items-end text-[11px] leading-tight text-muted">{billing === "per_use" ? "Cost per correct answer" : "Cost per correct answer, at list prices"}</dt>
          <dd className="tabular text-lg font-semibold text-ink">{usd(m.cost_per_success_usd)}</dd>
          <dd className="tabular text-[11px] text-muted">from {m.n_runs.toLocaleString("en")} checked answers</dd>
          <dd className="mt-1 text-[11px] leading-snug text-muted">{billing === "per_use" ? "What you pay, on average, for each right answer." : billing === "both" ? "List prices, not your bill: what a per-use call would cost, on average, for each right answer." : "At list prices, not your bill: what each right answer would cost if you paid per use."}</dd>
        </div>
      </dl>
    </div>
  );
}

export function VerdictTab({ rec }: { rec: Recommendation }) {
  const p = useP();
  const { mode: billing } = useBillingMode();
  const { title, body } = headline(rec, billing);
  const cur = rec.models.find((m) => m.model === rec.current?.model);
  const to = rec.models.find((m) => m.model === rec.recommended?.model);
  const moving = rec.recommended && rec.current && rec.recommended.model !== rec.current.model;
  const colors = colorMap(rec.models.map((m) => m.model));
  const reference = rec.models.find((m) => m.model === rec.reference);
  const floor = reference?.weighted_pass_rate != null ? reference.weighted_pass_rate - rec.rules.margin : null;
  const f = rec.forecast;
  const trial = promisingOf(rec);
  const summary = serverText(rec.summary, billing, null);
  const whySections = buildWhy(rec, billing);

  return (
    <div className="flex flex-col gap-4">
      <Panel glow className="p-6 md:p-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">
              <IconSpark size={14} className="text-accent" /> Our recommendation
              <Help label="How we reach this recommendation">
                We look for the cheapest model whose correct answers are within {Math.round(rec.rules.margin * 100)} points of both the best model and your current one. We only suggest a move with {confidenceWords(rec.rules.switch_confidence).plain} ({confidenceWords(rec.rules.switch_confidence).exact}). This is based on {rec.evidence.n_runs.toLocaleString("en")} checked answers, and we need at least {rec.rules.evidence_floor}. Nothing changes unless you decide.
              </Help>
            </p>
            <h2 className="text-[30px] font-semibold leading-tight tracking-tight md:text-[40px]">{title}</h2>
            <p className="max-w-xl text-[15px] leading-relaxed text-dim">{body}</p>
            {summary && (
              <div className="max-w-xl">
                <blockquote className="border-l-2 border-accent/60 pl-3 text-sm italic text-dim">“{summary}”</blockquote>
                <p className="mt-1 pl-3 text-[11px] text-muted">{AI_SUMMARY_NOTE}</p>
              </div>
            )}
            {rec.verdict === "INSUFFICIENT_EVIDENCE" && (
              <div className="flex max-w-md flex-col gap-2">
                <TwoStageBar {...twoStage(rec, evidenceSoFar(rec))} />
                <p className="text-xs text-muted">{rec.next_step ?? "Next step: choose how answers are checked on the task page."}</p>
              </div>
            )}
            {trial && (
              <div className="flex max-w-xl flex-col gap-2 rounded-[14px] border border-rule bg-surface-2/60 p-4" data-testid="promising">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Pill tone="neutral" icon={false}>{PROMISING_LABEL}</Pill> <ModelName>{trial.model}</ModelName>
                </p>
                <p className="text-sm text-dim">{promisingLine(trial)}</p>
                {promisingDetails(trial).map((t) => (
                  <p key={t} className="text-xs text-muted">{t}</p>
                ))}
                <p className="text-[11px] text-muted">{TRIAL_BUDGET_NOTE}</p>
                <div>
                  <ButtonLink to={p(`/retest?job=${encodeURIComponent(rec.job)}&model=${encodeURIComponent(trial.model)}`)} size="sm">
                    <IconFlask size={14} /> {PROMISING_ACTION}
                  </ButtonLink>
                </div>
              </div>
            )}
            {rec.verdict !== "INSUFFICIENT_EVIDENCE" && <p className="max-w-xl text-[11px] leading-snug text-muted">{NOT_A_BENCHMARK}</p>}
            {rec.next_step && rec.verdict !== "INSUFFICIENT_EVIDENCE" && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {rec.next_step && <p className="text-xs text-muted">{rec.next_step}</p>}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {moving ? (
              <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                <ModelCard label="In use now" m={cur} billing={billing} />
                <IconArrowRight size={20} className="mx-auto rotate-90 text-accent sm:rotate-0" />
                <ModelCard label="Recommended" m={to} highlight billing={billing} />
              </div>
            ) : (
              <ModelCard label={rec.verdict === "HOLD" ? "In use and recommended" : "In use now"} m={cur ?? to} highlight={rec.verdict === "HOLD"} billing={billing} />
            )}
            {!f && (rec.verdict === "DOWNGRADE" || rec.verdict === "SWITCH") && (
              <div className="rounded-[14px] border border-rule bg-surface-2/50 p-4" data-testid="forecast-learning">
                <p className="text-sm font-semibold text-ink">Still learning how often this task is used</p>
                <p className="text-[13px] text-dim">Monthly figures appear once the model in use has a week of calls. Nothing is guessed before then.</p>
              </div>
            )}
            {f && (rec.verdict === "DOWNGRADE" || rec.verdict === "SWITCH") && (
              <div className="grid grid-cols-2 gap-3">
                {billing !== "per_use" && (
                  <div className="col-span-2 rounded-[14px] border border-rule bg-surface-2/50 p-4">
                    <p className="text-sm font-semibold text-ink">{billing === "both" ? "If you pay a subscription" : "Your allowance"}</p>
                    <p className="text-[13px] text-dim">A smaller model may use less of your allowance. We cannot say how much: providers do not publish exact rates.</p>
                    {billing === "both" && <p className="mt-1 text-[11px] text-muted">We cannot tell which calls were paid which way, so we show both.</p>}
                  </div>
                )}
                {billing !== "subscription" && (
                <div className="rounded-[14px] border border-rule bg-surface-2/50 p-4">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted">{billing === "both" ? "If you pay per use: " : ""}{f.monthly_saving_usd >= 0 ? "Saved per month" : "Bill would rise per month"}
                    <Help label="How these two numbers are worked out">The saving is the cost today minus the cost of the recommended model, at your usual number of AI calls. The wrong answers are what we expect on top of today, with the likely range because we only checked some of your calls.</Help>
                  </p>
                  <p className={`tabular text-2xl font-semibold ${f.monthly_saving_usd >= 0 ? "text-ok" : "text-warn"}`}>{usd(Math.abs(f.monthly_saving_usd))}</p>
                  <p className="text-[11px] text-muted">{volumeWords(f, rec.current?.model)}</p>
                </div>
                )}
                <div className={`rounded-[14px] border border-rule bg-surface-2/50 p-4${billing === "subscription" ? " col-span-2" : ""}`}>
                  <p className="text-[11px] text-muted">Wrong answers a month</p>
                  <p className="tabular text-lg font-semibold text-ink">{wrongAnswerWords(f).headline}</p>
                  <p className="tabular text-[11px] text-muted">{wrongAnswerWords(f).range}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Reveal>
        <Panel className="p-5 md:p-6">
          <PanelHeader title="Why we recommend this" />
          <dl className="mt-3 grid gap-3">
            {whySections.slice(0, 2).map((w) => (
              <div key={w.title}>
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{w.title}</dt>
                <dd className="mt-0.5 text-sm text-dim">{w.text}</dd>
              </div>
            ))}
          </dl>
          {whySections.length > 2 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-accent">More reasons</summary>
              <dl className="mt-3 grid gap-3">
                {whySections.slice(2).map((w) => (
                  <div key={w.title}>
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{w.title}</dt>
                    <dd className="mt-0.5 text-sm text-dim">{w.text}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {rec.retest_candidates.filter((m) => m !== trial?.model).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {rec.retest_candidates.filter((m) => m !== trial?.model).map((model) => (
                <ButtonLink key={model} to={p(`/retest?job=${encodeURIComponent(rec.job)}&model=${encodeURIComponent(model)}`)} size="sm">
                  <IconFlask size={14} /> Start a trial on {model}
                </ButtonLink>
              ))}
            </div>
          )}
        </Panel>
      </Reveal>

      {rec.warnings.length > 0 && (
        <Reveal className="flex flex-col gap-2">
          {rec.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2 rounded-[12px] border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn">
              <IconAlert size={16} className="mt-0.5 shrink-0" /> {w}
            </p>
          ))}
        </Reveal>
      )}

      <details className="group flex flex-col gap-4">
      <summary className="cursor-pointer text-sm font-semibold text-accent">See the numbers</summary>
      <Reveal delay={0.08}>
        <Panel className="mt-4 p-5 md:p-6">
          <ChartFrame
            title="Every model you have tried, on cost and quality"
            hint={
              <>
                Up is more reliable, left is {billing === "per_use" ? "cheaper" : "lighter on your allowance"}. The green band is good enough: within {Math.round(rec.rules.margin * 100)} points of the best model.
                {billing === "per_use" ? "The cheapest" : "The lightest"} model inside it wins. Bars show where each correct-answer rate likely lies ({Math.round(rec.rules.confidence * 100)}% range).
              </>
            }
            table={{
              columns: ["Model", "Correct answers", "Likely range", billing === "per_use" ? "Cost / success" : "Cost / success (list price)", "Checked answers", "Judged"],
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
            <CostQualityMap models={rec.models} colors={colors} recommended={rec.recommended?.model} current={rec.current?.model} floor={floor} listPrice={billing !== "per_use"} />
          </ChartFrame>
        </Panel>
      </Reveal>

      <Reveal delay={0.12}>
        <Panel className="p-5 md:p-6">
          <PanelHeader title="How each model was judged" hint="The cheapest model that stays within the tolerance" />
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
                      <p className="mt-1 text-xs text-dim">{serverText(m.why, billing, null)}</p>
                    </div>
                    <div className="flex items-center gap-4 sm:justify-end">
                      <span className="tabular text-sm text-dim">{m.n_runs > 0 ? `${pct(m.weighted_pass_rate)} of ${m.n_runs.toLocaleString("en")}` : UNTESTED_LABEL} · {usd(m.cost_per_success_usd)}{billing === "per_use" ? "" : " list price"}</span>
                      <Pill tone={s.tone}>{s.label}</Pill>
                    </div>
                  </li>
                );
              })}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Based on {rec.evidence.n_runs.toLocaleString("en")} checked answers. Older answers count less.{" "}
            <Link to={`?tab=runs`} className="text-accent hover:underline">See the AI calls</Link>
          </p>
        </Panel>
      </Reveal>
      </details>
    </div>
  );
}
