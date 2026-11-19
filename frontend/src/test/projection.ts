import type { Projection } from "../features/insights/api/projectionApi";

export const RULE_TEXT =
  "Forecast = spend so far this month + the spend per day over the last 7 full days, for each day left. The range uses your lowest and highest of those 7 days. There is no forecast until 7 full days have passed since your first priced call, and it needs priced spend on at least 5 of the last 7 days. It pauses if no call has been recorded for 48 hours. A projected-over warning needs even the low end of the range to be above your budget.";

/** A valid forecast answer for tests: the month so far, and a range for the month's end. Override what a test needs. */
export function projectionFixture(over: Partial<Projection> = {}): Projection {
  return {
    state: "ok", reason: null, currency: "USD", timezone: "UTC", month: "2026-11",
    period_start: "2026-11-01T00:00:00Z", period_end: "2026-12-01T00:00:00Z", first_day: "2026-11-01", last_day: "2026-11-30",
    days_in_month: 30, day_of_month: 17, days_left: 13.5, actual_usd: 40, unpriced_runs: 0,
    projected_low_usd: 90, projected_likely_usd: 110, projected_high_usd: 150, history_days: 30, active_days: 7,
    recent_days: [1, 2, 3, 4, 5, 6, 7].map((k) => ({ day: `2026-11-${String(17 - k).padStart(2, "0")}`, spend_usd: 5 })),
    data_through: new Date(Date.now() - 3_600_000).toISOString(), budget_usd: null, used_share: null, vs_budget: null,
    rule: RULE_TEXT,
    data_note: "Spend is counted from calls this app has recorded, at public list prices. A call counts once your app has sent it, so the newest calls, and any delay on your provider's own billing, can be missing. Budget alerts are checked every hour.",
    ...over,
  };
}
