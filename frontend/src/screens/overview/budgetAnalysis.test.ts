import { describe, expect, it } from "vitest";
import { BUDGET_MAX, parseBudget } from "../../features/projects/hooks/useBudget";
import { analyseBudget, exactUsd } from "./budgetAnalysis";
import type { DayPoint } from "./metrics";

const TODAY = new Date("2026-11-17T12:00:00Z");
const pt = (day: string, spend: number, job = "a"): DayPoint => ({ day, job, model: "m", runs: 10, passed: 10, failed: 0, spend_usd: spend }) as DayPoint;
/** One point per day from `from` (inclusive) to Nov 16. */
function series(from: string, spend: number | ((d: string) => number), job = "a"): DayPoint[] {
  const out: DayPoint[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse("2026-11-16T00:00:00Z"); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push(pt(d, typeof spend === "number" ? spend : spend(d), job));
  }
  return out;
}

describe("parseBudget", () => {
  it.each([
    ["$1,200.50", 1200.5],
    ["  500 ", 500],
    ["1200", 1200],
    ["0.5", 0.5],
    ["1,000,000", 1_000_000],
  ])("accepts %s", (text, value) => expect(parseBudget(text)).toEqual({ value }));

  it.each([
    ["0", /above zero/],
    ["-5", /above zero/],
    ["", /above zero/],
    ["abc", /numbers only/],
    ["1e9", /numbers only/],
    ["1.200,50", /numbers only/],
    ["12,50", /numbers only/],
    ["1,000,001", /too high/],
    ["5000000", /too high/],
  ])("rejects %s with a plain message", (text, message) => {
    const r = parseBudget(text);
    expect("error" in r && r.error).toMatch(message);
  });

  it("uses a sane maximum", () => expect(BUDGET_MAX).toBe(1_000_000));
  it("shows a limit as typed", () => {
    expect(exactUsd(1200.5)).toBe("$1,200.50");
    expect(exactUsd(500)).toBe("$500");
  });
});

describe("analyseBudget", () => {
  const history = series("2026-10-01", 10); // Oct (310) complete, Nov 1 to 16 (160) so far

  it("says Still learning, with no projection numbers, under 7 full days", () => {
    const a = analyseBudget(series("2026-11-12", 10), 500, TODAY);
    expect(a.projection).toBeNull();
    expect(a.daysToLimit).toBeNull();
    expect(a.spent).toBe(50);
  });

  it("compares the whole range with the limit: likely under, close, likely over", () => {
    expect(analyseBudget(history, 1000, TODAY).projection?.verdict).toBe("under");
    expect(analyseBudget(history, 295, TODAY).projection?.verdict).toBe("close");
    expect(analyseBudget(history, 200, TODAY).projection?.verdict).toBe("over");
    const a = analyseBudget(history, 1000, TODAY);
    expect(Math.round(a.projection!.low)).toBe(295); // 160 so far + 10 a day for 13.5 days
  });

  it("works out the 85% and 95% dollars, the days to the limit and the share used", () => {
    const a = analyseBudget(history, 400, TODAY);
    expect(a.alert85).toBeCloseTo(340);
    expect(a.alert95).toBeCloseTo(380);
    expect(a.spentShare).toBeCloseTo(0.4);
    expect(a.daysToLimit).toBe(24); // (400 - 160) / 10 a day
    expect(a.alreadyPassed).toBe(false);
  });

  it("warns when the limit is below what is already spent, and says it is already passed", () => {
    const a = analyseBudget(history, 100, TODAY);
    expect(a.belowSpent).toBe(true);
    expect(a.alreadyPassed).toBe(true);
    expect(a.daysToLimit).toBeNull();
  });

  it("back-tests only complete months the history covers", () => {
    const a = analyseBudget(history, 300, TODAY);
    expect(a.backtest?.months).toEqual([{ label: "October", spend: 310 }]);
    expect(a.backtest?.over).toBe(1);
    expect(analyseBudget(history, 400, TODAY).backtest?.over).toBe(0);
  });

  it("has no back-test and no suggestion without a complete month", () => {
    const a = analyseBudget(series("2026-11-05", 10), 300, TODAY);
    expect(a.backtest).toBeNull();
    expect(a.suggestion).toBeNull();
  });

  it("suggests last full month's spend plus 20%", () => {
    expect(analyseBudget(history, 300, TODAY).suggestion).toBe(372);
  });

  it("lists the top three tasks this month with their share", () => {
    const pts = [...series("2026-11-01", 4, "big"), ...series("2026-11-01", 2, "mid"), ...series("2026-11-01", 1, "small"), ...series("2026-11-01", 0.5, "tiny")];
    const a = analyseBudget(pts, 500, TODAY);
    expect(a.topTasks.map((t) => t.job)).toEqual(["big", "mid", "small"]);
    expect(a.topTasks[0].spend).toBe(64);
    expect(a.topTasks[0].share).toBeCloseTo(64 / 120);
  });
});
