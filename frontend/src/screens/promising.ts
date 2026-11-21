/** The "Promising, worth a trial" level and the two-stage progress words. Plain language, never advice:
 * it never says recommend, switch now, safe or guaranteed, and it never offers a one-click switch. */
import type { Recommendation } from "../shared/api/types";

export const PROMISING_LABEL = "Promising, worth a trial";
export const PROMISING_ACTION = "Run a trial";
export const TRIAL_BUDGET_NOTE = "The trial uses the trial budget cap from Settings before it starts.";

/** Words that must never appear in Promising text. */
export const BANNED_IN_PROMISING = [/recommend(?! a switch)/i, /switch now/i, /\bsafe\b/i, /guarantee/i, /will save/i, /95% sure/i];

type Promising = NonNullable<Recommendation["promising"]>;

const sign = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}`;

export function promisingOf(rec: Recommendation | null | undefined): Promising | null {
  return rec && rec.verdict === "HOLD" && rec.promising ? rec.promising : null;
}

export function promisingLine(p: Promising): string {
  return `Looks close to ${p.current} so far. Not enough checked answers to be sure. Try it on your own examples.`;
}

/** "between -4.8 and +2.1 points" */
export function gapRange(p: Promising): string {
  return `between ${sign(p.low_points)} and ${sign(p.high_points)} points`;
}

export function promisingDetails(p: Promising): string[] {
  const out = [
    `${p.model} is ${sign(p.gap_points)} points from ${p.current} on checked answers so far, ${gapRange(p)}.`,
    "The gap may be overstated while the sample is small.",
  ];
  if (p.more_needed && p.more_needed > 0) {
    out.push(`About ${p.more_needed.toLocaleString("en")} more checked answers to be sure enough to recommend a switch.`);
  }
  return out;
}

/** How confident the engine really is, in plain words with the exact figure for the details line.
 * Its "99%" is a two-sided level, which is about 99.5% one-sided; "95%" is about 97.5%. */
export function confidenceWords(level: number): { plain: string; exact: string } {
  const oneSided = 1 - (1 - level) / 2;
  return {
    plain: level >= 0.99 ? "very high confidence" : "high confidence",
    exact: `about ${(oneSided * 100).toFixed(1)}%, one-sided`,
  };
}

export interface TwoStage {
  stage1: { have: number; need: number };
  stage2: { have: number; need: number | null };
  text: string;
}

/** The two-stage bar's numbers. `sure_enough.needed` is per model, at today's observed rates; it moves as data
 * arrives and is never a guarantee. Missing or unusable numbers fall back to words, never NaN. */
export function twoStage(rec: Pick<Recommendation, "progress" | "evidence" | "rules" | "sure_enough">, have1: number): TwoStage {
  const floor = rec.rules.evidence_floor;
  const needed = rec.sure_enough?.needed;
  const need2 = typeof needed === "number" && Number.isFinite(needed) && needed > 0 ? Math.max(Math.round(needed), floor) : null;
  const h = rec.sure_enough?.have;
  const have2 = typeof h === "number" && Number.isFinite(h) ? Math.max(0, Math.round(h)) : have1;
  const stage2 = need2 === null ? "Stage 2: we will say how many once there are results to compare." : `Stage 2: about ${need2.toLocaleString("en")} to be sure enough to recommend a switch.`;
  return {
    stage1: { have: have1, need: floor },
    stage2: { have: need2 === null ? 0 : Math.min(have2, need2), need: need2 },
    text: `Stage 1: ${floor} checked answers to start seeing results. ${stage2}`,
  };
}
