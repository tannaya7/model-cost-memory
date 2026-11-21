import type { Recommendation } from "../../shared/api/types";
import { pct, usd } from "../../ui/format";
import { rangeOf, TOO_FEW_LABEL, tooFewFor } from "../compare/wilson";
import { confidenceWords } from "../promising";
import { volumeWords, wrongAnswerWords } from "../forecastText";

export interface WhySection {
  title: string;
  text: string;
}

const n = (v: number) => Math.round(v).toLocaleString("en");
const pts = (v: number) => `${(v * 100).toFixed(1)} points`;

export const CHECK_YOURSELF = "This is based on your recent AI calls; check it on a few examples yourself.";

/** The reasoning behind a recommendation, in plain words. Evidence and uncertainty come first, reasons after:
 * explanations alone make people accept wrong advice, so the numbers lead. */
export function buildWhy(rec: Recommendation, billing: "per_use" | "subscription" | "both" = "per_use"): WhySection[] {
  const find = (name?: string | null) => rec.models.find((m) => m.model === name);
  const cur = find(rec.current?.model);
  const to = find(rec.recommended?.model);
  const best = find(rec.reference);
  const checked = rec.evidence.n_runs;
  const out: WhySection[] = [];

  const names = rec.models.map((m) => m.model);
  out.push({
    title: "What we looked at",
    text:
      checked > 0
        ? `${n(checked)} checked answers from ${names.length} ${names.length === 1 ? "model" : "models"}${names.length ? ` (${names.join(", ")})` : ""}. Recent answers count more than old ones.`
        : "No answers have been checked yet, so there is nothing to compare.",
  });

  const focus = to ?? cur;
  if (focus && focus.weighted_pass_rate != null && focus.n_runs > 0) {
    const ci = rangeOf(focus.weighted_pass_rate, focus.n_runs, focus);
    out.push({
      title: "How sure are we",
      text: tooFewFor(focus.n_runs, focus, rec.rules.evidence_floor) || !ci
        ? `${TOO_FEW_LABEL}. ${focus.model} has ${n(focus.n_runs)} checked ${focus.n_runs === 1 ? "answer" : "answers"} and we need the weight of ${n(rec.rules.evidence_floor)} recent ones (older answers count less). Treat the ${pct(focus.weighted_pass_rate, 0)} correct as a guess.`
        : `${focus.model}: ${pct(focus.weighted_pass_rate, 0)} of answers correct, from ${n(focus.n_runs)} checked answers. Allowing for chance, the true rate is probably between ${pct(ci.low, 0)} and ${pct(ci.high, 0)} (${Math.round(rec.rules.confidence * 100)}% range).${
            ci.high - ci.low > 0.2 ? " That range is wide; more checked answers would narrow it." : ""
          }`,
    });
  }

  if (rec.verdict === "INSUFFICIENT_EVIDENCE") {
    out.push({
      title: "What is missing",
      text: `We need about ${n(rec.rules.evidence_floor)} recent checked answers on a model before we advise anything. We are ${Math.round(rec.progress * 100)}% of the way there. Checking more of your AI calls will get us there.`,
    });
    out.push({ title: "Nothing changes until you decide", text: "We are not advising a change yet, and we never change your model for you." });
    out.push({ title: "Check it yourself", text: CHECK_YOURSELF });
    return out;
  }

  if (rec.verdict === "DOWNGRADE" && to) {
    const gap = best?.weighted_pass_rate != null && to.weighted_pass_rate != null ? best.weighted_pass_rate - to.weighted_pass_rate : null;
    const closeness =
      gap === null || best === undefined
        ? ""
        : gap <= 0.0005 || best.model === to.model
          ? `, as good as the best model`
          : `, only ${pts(gap)} below the best (${best.model}, ${pct(best.weighted_pass_rate)})`;
    const cost =
      billing !== "subscription" && to.cost_per_success_usd != null && cur?.cost_per_success_usd != null
        ? `, and costs ${usd(to.cost_per_success_usd)} per correct answer instead of ${usd(cur.cost_per_success_usd)}${billing === "both" ? " (at list prices, if you pay per use)" : ""}`
        : "";
    out.push({ title: "Why this model", text: `${to.model} got ${pct(to.weighted_pass_rate)} of answers correct${closeness}${cost}. Our rule: pick the cheapest model shown to be within ${pts(rec.rules.margin)} of both the best model and your current one.` });
  } else if (rec.verdict === "SWITCH" && to && cur) {
    const diff = (to.weighted_pass_rate ?? 0) - (cur.weighted_pass_rate ?? 0);
    out.push({
      title: "Why this model",
      text: `${cur.model} got ${pct(cur.weighted_pass_rate)} of answers correct and ${to.model} got ${pct(to.weighted_pass_rate)}, ${pts(Math.max(diff, 0))} more${
        billing !== "subscription" && to.cost_per_success_usd != null && cur.cost_per_success_usd != null ? `, at ${usd(to.cost_per_success_usd)} per correct answer against ${usd(cur.cost_per_success_usd)}${billing === "both" ? " (list prices, if you pay per use)" : ""}` : ""
      }. We only advise this with ${confidenceWords(rec.rules.switch_confidence).plain} (${confidenceWords(rec.rules.switch_confidence).exact}) that the difference is real.`,
    });
  } else {
    const keep = cur ?? to;
    out.push({
      title: "Why keep it",
      text: `${keep?.model ?? "Your current model"} got ${pct(keep?.weighted_pass_rate)} of answers correct. No cheaper model we have tried is shown to be within ${pts(rec.rules.margin)} of both the best model and your current one, so we would not move.`,
    });
  }

  const f = rec.forecast;
  if (f && (rec.verdict === "DOWNGRADE" || rec.verdict === "SWITCH")) {
    const money = f.monthly_saving_usd >= 0 ? `save about ${usd(f.monthly_saving_usd)} a month` : `see your bill rise by about ${usd(Math.abs(f.monthly_saving_usd))} a month`;
    const smaller = "use a smaller model, which may use less of your allowance (we cannot say how much: providers do not publish exact rates)";
    const w = wrongAnswerWords(f);
    out.push({
      title: "What would change",
      text: `If you moved, you would ${billing === "subscription" ? smaller : billing === "both" ? `${money} on calls paid per use (and, on a subscription, ${smaller})` : money} and get ${w.headline} (${w.range}), ${volumeWords(f, rec.current?.model)}.`,
    });
  } else if (rec.verdict === "HOLD") {
    out.push({ title: "What would change", text: "Nothing, for now. If a cheaper or better model is shown to do the job later, we will tell you." });
  }

  out.push({
    title: "Nothing changes until you decide",
    text: rec.retest_candidates.length ? "We never switch models for you. You can first try the new model on your past prompts." : "We never switch models for you.",
  });
  out.push({ title: "Check it yourself", text: CHECK_YOURSELF });
  return out;
}
