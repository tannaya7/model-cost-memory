/** "What if other people use this key too?": a planning scenario worked out from the person's OWN recorded spend.
 *
 * It is not a measurement. We do not know how much the others would use, so the person says how much, in three plain steps, and
 * the days still to come in the month are scaled by that. Days already spent stay exactly as recorded. If the others already use
 * the recorder, their calls are in the recorded spend and this scenario would count them twice, so the page says so.
 * Pure functions, so every rule is easy to test. */
import type { monthProjection } from "./metrics";

export type Lean = "lighter" | "same" | "heavier";

/** How much one other person uses compared with you. Round numbers on purpose: it is a guess, so it should look like one. */
export const LEAN_FACTOR: Record<Lean, number> = { lighter: 0.5, same: 1, heavier: 2 };
export const LEAN_WORDS: Record<Lean, string> = {
  lighter: "less than you do",
  same: "about as much as you do",
  heavier: "more than you do",
};
export const MAX_OTHERS = 20;

const DAY = 86_400_000;

type Month = Pick<ReturnType<typeof monthProjection>, "mtd" | "projected" | "low" | "high" | "dailyRate" | "learning">;

export type KeyScenario = {
  /** 1 for you, plus each other person at their share of your use. */
  multiplier: number;
  /** Month-end range with the others added to the days still to come. */
  low: number;
  expected: number;
  high: number;
  /** What the others add on top of your own month-end figure. */
  extra: number;
  /** Your own month-end figure, unchanged, for comparison. */
  yours: number;
  /** The date the limit would be used up, null when it lasts to the end of the month or there is no limit or no pace. */
  runsOutOn: Date | null;
  /** True when a limit exists and, at this pace, the month ends before it is used up. */
  lastsToMonthEnd: boolean | null;
  /** The limit is already used up this month. */
  alreadyPassed: boolean;
};

/** Null while there is less than a week of history (no numbers at all then), or when nobody else is added. */
export function sharedKeyScenario(
  month: Month,
  others: number,
  lean: Lean,
  limit: number | null,
  today: Date = new Date(),
): KeyScenario | null {
  if (month.learning) return null;
  const n = Math.max(0, Math.min(MAX_OTHERS, Math.floor(others)));
  if (n === 0) return null;
  const multiplier = 1 + n * LEAN_FACTOR[lean];
  const scale = (value: number) => month.mtd + Math.max(0, value - month.mtd) * multiplier;
  const expected = scale(month.projected);
  const yours = month.projected;
  let runsOutOn: Date | null = null;
  let lastsToMonthEnd: boolean | null = null;
  let alreadyPassed = false;
  if (limit !== null && limit > 0) {
    const left = limit - month.mtd;
    const dailyNow = month.dailyRate * multiplier;
    if (left <= 0) {
      alreadyPassed = true;
    } else if (dailyNow > 0) {
      const when = new Date(today.getTime() + (left / dailyNow) * DAY);
      const monthEnd = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
      if (when.getTime() < monthEnd) runsOutOn = when;
      lastsToMonthEnd = when.getTime() >= monthEnd;
    }
  }
  return { multiplier, low: scale(month.low), expected, high: scale(month.high), extra: expected - yours, yours, runsOutOn, lastsToMonthEnd, alreadyPassed };
}
