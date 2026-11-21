/** Wilson score interval for a pass rate, and the plain labels that go with it.
 * Wilson is the interval recommended for small samples (Brown, Cai and DasGupta 2001); the plain
 * "p plus or minus 1.96 standard errors" interval is unreliable when n is small or the rate is near 0 or 1. */

/** The one product floor: under this many checked answers we give no recommendation and no range.
 * Matches the recommendation rule (`rules.evidence_floor`); screens that have the rule should pass it in. */
export const MIN_CHECKED_ANSWERS = 25;

const Z95 = 1.959964;

/** 95% Wilson interval for `passes` out of `n`. Returns null when n is not a positive number. */
export function wilsonInterval(passes: number, n: number, z = Z95): { low: number; high: number } | null {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(passes)) return null;
  const p = Math.min(Math.max(passes / n, 0), 1);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Same, from a rate (0..1) and the number of checked answers behind it. */
export function wilsonFromRate(rate: number | null | undefined, n: number | null | undefined) {
  if (rate == null || n == null) return null;
  return wilsonInterval(rate * n, n);
}

export const TOO_FEW_LABEL = "Not enough checked answers yet";
export const UNTESTED_LABEL = "Not tested on your work yet";

export const isTooFew = (n: number | null | undefined, floor: number = MIN_CHECKED_ANSWERS) => n == null || n < floor;

const pc = (v: number) => `${Math.round(v * 100)}%`;

/** What the API says about one model's evidence: its own pass-rate range and its freshness-weighted evidence (old runs count less).
 * Screens use these instead of recomputing from the raw run count, which would give a narrower range than the engine. */
export interface ApiEvidence {
  pass_rate_low?: number | null;
  pass_rate_high?: number | null;
  evidence_weight?: number | null;
}

/** The engine's range when it sent one, else a Wilson range from the raw count (only for data without an API range). */
export function rangeOf(rate: number | null | undefined, n: number | null | undefined, api?: ApiEvidence): { low: number; high: number } | null {
  if (api && api.pass_rate_low != null && api.pass_rate_high != null) return { low: api.pass_rate_low, high: api.pass_rate_high };
  return wilsonFromRate(rate, n);
}

/** Too few when the freshness-weighted evidence is under the floor (the engine's own test); the raw count only when no weight is given. */
export function tooFewFor(n: number | null | undefined, api?: ApiEvidence, floor: number = MIN_CHECKED_ANSWERS): boolean {
  return api && api.evidence_weight != null ? api.evidence_weight < floor : isTooFew(n, floor);
}

/** "93% correct, 86% to 97% (95% range), from 100 checked answers", or the too-few label. */
export function evidenceLine(rate: number | null | undefined, n: number | null | undefined, floor: number = MIN_CHECKED_ANSWERS, api?: ApiEvidence): string {
  if (rate == null || n == null || n <= 0) return UNTESTED_LABEL;
  const ci = rangeOf(rate, n, api);
  const count = `${Math.round(n).toLocaleString("en")} checked ${Math.round(n) === 1 ? "answer" : "answers"}`;
  if (tooFewFor(n, api, floor) || !ci) return `${TOO_FEW_LABEL}: ${count} so far, we need ${floor}`;
  return `${pc(rate)} correct, probably ${pc(ci.low)} to ${pc(ci.high)} (95% range), from ${count}`;
}

/** Newcombe's 95% interval for the difference of two pass rates (second minus first), built from their Wilson intervals
 * (method 10 in Newcombe 1998). Two overlapping Wilson ranges do NOT mean "no difference": this is the proper test. */
export function newcombeDifference(rate1: number, n1: number, rate2: number, n2: number): { diff: number; low: number; high: number } | null {
  const a = wilsonInterval(rate1 * n1, n1);
  const b = wilsonInterval(rate2 * n2, n2);
  if (!a || !b) return null;
  const diff = rate2 - rate1;
  return {
    diff,
    low: diff - Math.sqrt((rate2 - b.low) ** 2 + (a.high - rate1) ** 2),
    high: diff + Math.sqrt((b.high - rate2) ** 2 + (rate1 - a.low) ** 2),
  };
}
