/** Wilson score interval for a pass rate, and the plain labels that go with it.
 * Wilson is the interval recommended for small samples (Brown, Cai and DasGupta 2001); the plain
 * "p plus or minus 1.96 standard errors" interval is unreliable when n is small or the rate is near 0 or 1. */

/** Under this many checked answers we do not give a confident-sounding verdict. */
export const MIN_CHECKED_ANSWERS = 30;

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

export const TOO_FEW_LABEL = "Too few answers to be sure";
export const UNTESTED_LABEL = "Not tested on your work yet";

export const isTooFew = (n: number | null | undefined) => n == null || n < MIN_CHECKED_ANSWERS;

const pc = (v: number) => `${Math.round(v * 100)}%`;

/** "93% correct, 86% to 97% (95% range), from 100 checked answers", or the too-few label. */
export function evidenceLine(rate: number | null | undefined, n: number | null | undefined): string {
  if (rate == null || n == null || n <= 0) return UNTESTED_LABEL;
  const ci = wilsonFromRate(rate, n);
  const count = `${Math.round(n).toLocaleString("en")} checked ${Math.round(n) === 1 ? "answer" : "answers"}`;
  if (isTooFew(n) || !ci) return `${TOO_FEW_LABEL} (${count})`;
  return `${pc(rate)} correct, probably ${pc(ci.low)} to ${pc(ci.high)} (95% range), from ${count}`;
}
