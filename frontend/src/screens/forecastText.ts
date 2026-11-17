/** Plain wording for a forecast, shared by every surface that shows one, so direction is never a sign to decode. */
import type { Recommendation } from "../shared/api/types";

type Forecast = NonNullable<Recommendation["forecast"]>;

const whole = (x: number) => Math.round(Math.abs(x));

/** "about 0 fewer wrong answers a month" and the range in words ("could be up to 39 more or 39 fewer").
 * In the data a positive number means MORE wrong answers; here that is always said as "more". */
export function wrongAnswerWords(f: Pick<Forecast, "extra_failures_per_month" | "extra_failures_low" | "extra_failures_high">): { headline: string; range: string } {
  const mid = f.extra_failures_per_month;
  const n = whole(mid);
  const dir = n > 0 && mid > 0 ? "more" : "fewer";
  const headline = `about ${n.toLocaleString("en")} ${dir} wrong ${n === 1 ? "answer" : "answers"} a month`;
  const lo = f.extra_failures_low;
  const hi = f.extra_failures_high;
  let range: string;
  if (lo < 0 && hi > 0) range = `could be up to ${whole(hi)} more or ${whole(lo)} fewer`;
  else if (lo >= 0) range = `could be ${whole(lo)} to ${whole(hi)} more`;
  else range = `could be ${whole(hi)} to ${whole(lo)} fewer`;
  return { headline, range };
}

/** The volume the saving is worked out from, in words. */
export function volumeWords(f: Pick<Forecast, "runs_per_month">, model: string | null | undefined): string {
  const calls = f.runs_per_month.toLocaleString("en");
  return model ? `based on ${calls} calls a month on ${model}` : `based on ${calls} calls a month`;
}

/** The one pass rate shown for a task everywhere: the model in use now (checked answers on that model only). */
export function passRateInUse(rec: Pick<Recommendation, "models" | "current"> | null | undefined): number | null {
  const cur = rec?.models.find((m) => m.model === rec.current?.model);
  return cur?.weighted_pass_rate ?? null;
}

export const NOT_A_BENCHMARK = "A suggestion from your own recent calls only. It is not a benchmark. Test it on your own examples before you switch.";

/** Calls a month on the models in use, summed over the tasks whose saving is counted. */
export function savingVolume(recs: Array<Recommendation | null | undefined>): number {
  return recs.reduce(
    (s, r) => s + ((r && (r.verdict === "DOWNGRADE" || r.verdict === "SWITCH") && (r.forecast?.monthly_saving_usd ?? 0) > 0 ? r.forecast?.runs_per_month : 0) ?? 0),
    0,
  );
}

/** Same rule as the month projection on the budget alert (backend PROJECTION_DAYS): under 7 days of data a
 * "per month" figure is only a rough guess, never a fact. */
export const MIN_DAYS_FOR_MONTH = 7;

export const daysWord = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export const isRoughMonth = (daysOfUse: number) => daysOfUse < MIN_DAYS_FOR_MONTH;
