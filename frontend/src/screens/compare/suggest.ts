/** Ranked model suggestions for a job whose answers can be checked. Pure: no fetching, no rendering.
 * Measured figures come from the job's recommendation evidence; models never run on this job are only
 * ever "worth testing", priced from the catalog and the job's average tokens per run (an estimate). */
import type { Model, Recommendation } from "../../shared/api/types";
import { evidenceLine, rangeOf, tooFewFor } from "./wilson";

export type SuggestionLabel = "Cheapest proven" | "Best quality" | "Worth testing";

export interface Suggestion {
  label: SuggestionLabel;
  model: string;
  provider: string | null;
  /** Estimated cost of a month at the chosen volume. */
  monthlyCostUsd: number | null;
  /** Null when no budget is set. */
  fitsBudget: boolean | null;
  reason: string;
  evidence: "measured" | "estimate";
  passRate: number | null;
  /** Checked answers behind passRate; null for models never run on this job. */
  nChecked: number | null;
  /** 95% Wilson interval for passRate; null when there is no measurement. */
  interval: { low: number; high: number } | null;
  /** Under the product floor (25) of checked answers: show "Not enough checked answers yet" instead of a verdict. */
  tooFew: boolean;
}

export interface SuggestInput {
  rec: Recommendation;
  catalog: Model[];
  /** Average tokens per run on this job; null when the daily data carries no token counts. */
  avgTokens: { in: number; out: number } | null;
  /** Runs per month at the chosen volume. */
  runsPerMonth: number;
  budgetUsd: number | null;
  /** Empty means every provider. */
  providers?: string[];
}

/** Estimated dollars per run from list prices; null when a price is missing or tokens are unknown. */
export function estimateRunCost(
  m: Pick<Model, "price_in_per_mtok" | "price_out_per_mtok">,
  t: { in: number; out: number } | null,
): number | null {
  if (!t || m.price_in_per_mtok == null || m.price_out_per_mtok == null) return null;
  return (t.in * m.price_in_per_mtok + t.out * m.price_out_per_mtok) / 1e6;
}

export const sameFamily = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a);

/** Catalog models this job has never run (matched by family name), still on sale. */
export function untestedModels(rec: Recommendation, catalog: Model[]): Model[] {
  const seen = new Set<string>();
  return catalog.filter((m) => {
    if (m.status === "RETIRED" || rec.models.some((e) => sameFamily(e.model, m.model))) return false;
    if (seen.has(m.model)) return false;
    seen.add(m.model);
    return true;
  });
}

export function suggestForCheckedJob(input: SuggestInput): Suggestion[] {
  const { rec, catalog, avgTokens, runsPerMonth, budgetUsd } = input;
  const providerOf = (model: string) => catalog.find((c) => sameFamily(c.model, model))?.provider ?? null;
  const allowed = (provider: string | null) => !input.providers?.length || (provider !== null && input.providers.includes(provider));
  const fits = (cost: number | null) => (budgetUsd == null || cost == null ? null : cost <= budgetUsd);
  const monthly = (perRun: number | null) => (perRun == null ? null : perRun * runsPerMonth);
  const floor = rec.rules.evidence_floor;
  const out: Suggestion[] = [];
  const used = new Set<string>();

  const measured = rec.models.filter((m) => m.catalog_status !== "RETIRED" && m.status !== "RETIRED" && allowed(providerOf(m.model)));
  const proven = measured.filter((m) => m.status === "GOOD_ENOUGH" && m.eligible && m.mean_cost_usd != null);
  const cheapest = [...proven].sort((a, b) => (a.mean_cost_usd as number) - (b.mean_cost_usd as number))[0];
  if (cheapest) {
    const cost = monthly(cheapest.mean_cost_usd);
    used.add(cheapest.model);
    out.push({
      label: "Cheapest proven",
      model: cheapest.model,
      provider: providerOf(cheapest.model),
      monthlyCostUsd: cost,
      fitsBudget: fits(cost),
      reason: `${evidenceLine(cheapest.weighted_pass_rate, cheapest.n_runs, undefined, cheapest)}. On this evidence it costs the least of the models that looked good enough.`,
      evidence: "measured",
      passRate: cheapest.weighted_pass_rate,
      nChecked: cheapest.n_runs,
      interval: rangeOf(cheapest.weighted_pass_rate, cheapest.n_runs, cheapest),
      tooFew: tooFewFor(cheapest.n_runs, cheapest),
    });
  }

  const best = [...measured]
    .filter((m) => m.weighted_pass_rate != null && m.evidence_weight >= floor)
    .sort((a, b) => (b.weighted_pass_rate as number) - (a.weighted_pass_rate as number) || (a.mean_cost_usd ?? Infinity) - (b.mean_cost_usd ?? Infinity))[0];
  if (best && !used.has(best.model)) {
    const cost = monthly(best.mean_cost_usd);
    used.add(best.model);
    out.push({
      label: "Best quality",
      model: best.model,
      provider: providerOf(best.model),
      monthlyCostUsd: cost,
      fitsBudget: fits(cost),
      reason: `${evidenceLine(best.weighted_pass_rate, best.n_runs, undefined, best)}. The highest rate we measured, but the ranges of other models may overlap it.`,
      evidence: "measured",
      passRate: best.weighted_pass_rate,
      nChecked: best.n_runs,
      interval: rangeOf(best.weighted_pass_rate, best.n_runs, best),
      tooFew: tooFewFor(best.n_runs, best),
    });
  }

  const current = rec.current ? rec.models.find((m) => m.model === rec.current!.model) : undefined;
  const currentCost = monthly(current?.mean_cost_usd ?? null);
  if (currentCost != null) {
    const pick = untestedModels(rec, catalog)
      .filter((m) => allowed(m.provider))
      .map((m) => ({ m, cost: monthly(estimateRunCost(m, avgTokens)) }))
      .filter((c): c is { m: Model; cost: number } => c.cost != null && c.cost < currentCost)
      .sort((a, b) => a.cost - b.cost)[0];
    if (pick) {
      out.push({
        label: "Worth testing",
        model: pick.m.model,
        provider: pick.m.provider,
        monthlyCostUsd: pick.cost,
        fitsBudget: fits(pick.cost),
        reason:
          "Not tested on your work yet. At list prices it would cost less than the current model, so it may be worth testing on your own prompts. Its quality is unknown.",
        evidence: "estimate",
        passRate: null,
        nChecked: null,
        interval: null,
        tooFew: false,
      });
    }
  }
  return out.slice(0, 3);
}
