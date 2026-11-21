/** What the compare page draws, turned into plain rows. Everything here comes from the engine's evidence: the pass-rate
 * range, the difference interval against the model in use, the counts of priced and re-tested runs. Nothing is
 * recomputed in the browser, so the picture can never say more than the verdict does. */
import type { Recommendation } from "../../shared/api/types";
import { rangeOf, tooFewFor } from "./wilson";

type Evidence = Recommendation["models"][number];
export type Difference = NonNullable<Evidence["vs_current"]>;

/** The 90th-percentile call costing this many times the median is worth a flag: an average then hides the tail. */
export const SPREAD_FLAG_RATIO = 2;

export type CostState = "known" | "free" | "unpriced" | "undefined";

export interface Row {
  model: string;
  isCurrent: boolean;
  /** engine status, in words, or null when the evidence is not comparable */
  status: Evidence["status"];
  rate: number | null;
  low: number | null;
  high: number | null;
  checked: number;
  tooFew: boolean;
  cost1000: number | null;
  costState: CostState;
  priced: number | null;
  unpriced: number | null;
  retests: number | null;
  p50: number | null;
  p90: number | null;
  spread: boolean;
  diff: Difference | null;
  why: string;
}

export const STATUS_WORDS: Record<Evidence["status"], string> = {
  GOOD_ENOUGH: "Good enough",
  UNSURE: "Not sure yet",
  CLEARLY_WORSE: "Clearly worse",
  BELOW_FLOOR: "Too few checked answers",
  RETIRED: "Retired by the provider",
};

export const DIFF_WORDS: Record<Difference["status"], string> = {
  GOOD_ENOUGH: "At most the margin worse",
  UNSURE: "Not sure yet",
  CLEARLY_WORSE: "Clearly worse",
};

export function costState(m: Pick<Evidence, "mean_cost_usd" | "cost_per_success_usd" | "weighted_pass_rate">): CostState {
  if (m.mean_cost_usd == null) return "unpriced";
  if (m.weighted_pass_rate != null && m.weighted_pass_rate <= 0) return "undefined"; // cost of a correct answer when none is correct
  if (m.cost_per_success_usd == null) return "undefined";
  return m.cost_per_success_usd === 0 ? "free" : "known";
}

/** One row per model the job has run, in the engine's order, never re-ranked here. */
export function buildRows(rec: Recommendation, allowed: (model: string) => boolean = () => true): Row[] {
  const current = rec.current?.model;
  return rec.models.filter((m) => allowed(m.model)).map((m) => {
    const range = m.weighted_pass_rate != null ? rangeOf(m.weighted_pass_rate, m.n_runs, m) : null;
    const cs = costState(m);
    const spread = m.cost_p50_usd != null && m.cost_p90_usd != null && m.cost_p50_usd > 0 && m.cost_p90_usd >= SPREAD_FLAG_RATIO * m.cost_p50_usd;
    return {
      model: m.model,
      isCurrent: m.model === current,
      status: m.status,
      rate: m.weighted_pass_rate,
      low: range?.low ?? null,
      high: range?.high ?? null,
      checked: m.n_runs,
      tooFew: m.weighted_pass_rate == null || tooFewFor(m.n_runs, m),
      cost1000: cs === "known" || cs === "free" ? (m.cost_per_success_usd as number) * 1000 : null,
      costState: cs,
      priced: m.priced_runs ?? null,
      unpriced: m.unpriced_runs ?? null,
      retests: m.retest_runs ?? null,
      p50: m.cost_p50_usd ?? null,
      p90: m.cost_p90_usd ?? null,
      spread,
      diff: m.vs_current ?? null,
      why: m.why,
    };
  });
}

/** Points that can be drawn on cost against quality: a measured quality AND a cost of a correct answer (zero counts). */
export const plottable = (r: Row) => r.rate != null && r.cost1000 != null;

/** Models measured but not drawn, with the reason: never silently dropped. */
export function notDrawn(rows: Row[]): Array<{ model: string; reason: string }> {
  return rows.filter((r) => !plottable(r)).map((r) => ({
    model: r.model,
    reason:
      r.rate == null ? "no checked answers yet"
      : r.costState === "unpriced" ? "no price is known, so its cost cannot be shown"
      : "none of its checked answers passed, so the cost of a correct answer cannot be worked out",
  }));
}

/** The y axis starts where the data does, never at an arbitrary number, and the chart says where it starts. */
export function yFloor(rows: Row[], goodLine: number | null): number {
  const lows = rows.filter(plottable).map((r) => r.low ?? r.rate ?? 1);
  const lo = Math.min(...lows, goodLine ?? 1);
  return Math.max(0, Math.floor((lo - 0.05) * 20) / 20);
}

/** The difference chart's x range in points: always includes zero and the margin line, and the whole of every interval. */
export function diffRange(rows: Row[]): { min: number; max: number } | null {
  const ds = rows.map((r) => r.diff).filter((d): d is Difference => d != null);
  if (ds.length === 0) return null;
  const margin = ds[0].margin_points;
  const lo = Math.min(...ds.map((d) => d.low_points), -margin, 0);
  const hi = Math.max(...ds.map((d) => d.high_points), 0);
  const pad = Math.max(1, (hi - lo) * 0.06);
  return { min: Math.max(-100, lo - pad), max: Math.min(100, hi + pad) };
}

/** "−1.2" / "+0.4" for a gap in points, with a real minus sign. */
export const signed = (x: number, digits = 1) => `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(digits)}`;

/** One sentence for a difference that never calls an unproven gap a tie (a range that includes zero is not proof of "same"). */
export function diffSentence(d: Difference, margin = d.margin_points): string {
  const range = `${signed(d.gap_points)} points (${d.confidence * 100}% range ${signed(d.low_points)} to ${signed(d.high_points)})`;
  if (d.low_points > 0) return `${range}: ahead of ${d.against}, and the range is above zero.`;
  if (d.high_points < 0 && d.status === "CLEARLY_WORSE") return `${range}: more than ${margin} points behind ${d.against}.`;
  if (d.status === "GOOD_ENOUGH") return `${range}: shown to be at most ${margin} points worse than ${d.against}.`;
  return `${range}: not sure yet whether it is within ${margin} points of ${d.against}. A range that includes zero is not proof they are the same.`;
}
