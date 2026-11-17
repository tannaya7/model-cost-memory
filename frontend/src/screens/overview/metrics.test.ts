import { describe, expect, it } from "vitest";
import { byWeekday, compareSeries, delta, monthProjection, passRate, periods, rangeLabel, splitBy, sum, toCsv, unitCosts, unpricedRuns, wastedSpend, type DayPoint } from "./metrics";

const today = new Date("2026-11-13T15:00:00Z"); // a Friday
const pt = (day: string, job: string, model: string, runs: number, spend: number, passed = 0, failed = 0) =>
  ({ day, job, model, runs, spend_usd: spend, passed, failed }) as DayPoint;

const points = [
  pt("2026-11-13", "invoice", "mini", 10, 1.5, 9, 1),
  pt("2026-11-07", "invoice", "large", 4, 2, 4, 0),
  pt("2026-11-06", "tickets", "mini", 6, 0.5, 3, 3), // first day of the previous 7
  pt("2026-10-30", "tickets", "mini", 99, 99), // older than both periods
];

describe("overview numbers", () => {
  it("splits the points into this period and the one before, today included", () => {
    const { cur, prev } = periods(points, 7, today);
    expect(cur.map((p) => p.day)).toEqual(["2026-11-13", "2026-11-07"]);
    expect(prev.map((p) => p.day)).toEqual(["2026-11-06"]);
  });

  it("sums, rates and compares", () => {
    const { cur, prev } = periods(points, 7, today);
    expect(sum(cur, "spend_usd")).toBe(3.5);
    expect(passRate(cur)).toBeCloseTo(13 / 14);
    expect(passRate([])).toBeNull();
    expect(delta(sum(cur, "runs"), sum(prev, "runs"))).toBeCloseTo((14 - 6) / 6);
    expect(delta(5, 0)).toBeNull();
  });

  it("lines each day up with the same day of the period before", () => {
    const rows = compareSeries(points, 7, "runs", today);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ day: "2026-11-07", cur: 4, prev: 0, prevDay: "2026-10-31" });
    expect(rows[6]).toMatchObject({ day: "2026-11-13", cur: 10, prevDay: "2026-11-06", prev: 6 });
  });

  it("counts runs per weekday and splits by job, largest first", () => {
    const week = byWeekday(points.slice(0, 3));
    expect(week[5]).toBe(16); // Fridays: 13 Nov and 6 Nov
    expect(week[6]).toBe(4); // Saturday 7 Nov
    expect(splitBy(points.slice(0, 3), "job", "spend_usd")).toEqual([
      { name: "invoice", value: 3.5 },
      { name: "tickets", value: 0.5 },
    ]);
  });

  it("exports CSV with quoting where a value needs it", () => {
    const csv = toCsv([pt("2026-11-13", 'say "hi", please', "mini", 1, 0.25, 1, 0)]);
    expect(csv).toBe('day,job,model,runs,passed,failed,spend_usd\n2026-11-13,"say ""hi"", please",mini,1,1,0,0.25\n');
  });

  it("labels the period", () => {
    expect(rangeLabel(7, today)).toBe("7 Nov – 13 Nov 2026");
  });
});

describe("money widgets", () => {
  // Friday 13 November: five days at $2, seven days at $1 (6 to 12 Nov), and $1.50 so far today.
  const month: DayPoint[] = [
    ...[1, 2, 3, 4, 5].map((d) => pt(`2026-11-0${d}`, "invoice", "mini", 10, 2)),
    ...[6, 7, 8, 9, 10, 11, 12].map((d) => pt(`2026-11-${String(d).padStart(2, "0")}`, "invoice", "mini", 10, 1)),
    pt("2026-11-13", "invoice", "mini", 5, 1.5),
  ];

  it("projects the month from the spend so far and the last 7 days", () => {
    const r = monthProjection(month, today);
    expect(r.mtd).toBeCloseTo(18.5);
    expect(r.dailyRate).toBeCloseTo(1);
    expect(r.projected).toBeCloseTo(35.5); // 18.5 + 17 days left at $1
    expect(r.daysInMonth).toBe(30);
    expect(r.monthLabel).toBe("November 2026");
  });

  it("judges the projection against a budget", () => {
    expect(monthProjection(month, today, null).status).toBe("none");
    expect(monthProjection(month, today, 100).status).toBe("ok");
    expect(monthProjection(month, today, 40).status).toBe("close"); // 35.5 is 89% of 40
    const over = monthProjection(month, today, 30);
    expect(over.status).toBe("over");
    expect(over.overBy).toBeCloseTo(5.5);
  });

  it("warns when most of the budget is already spent, even if the pace is low", () => {
    // a quiet last week (runs, but no spend) keeps the pace near zero, so only the amount already spent can warn
    const r = monthProjection([pt("2026-11-02", "a", "m", 1, 85), pt("2026-11-10", "a", "m", 5, 0)], today, 100);
    expect(r.usedShare).toBeCloseTo(0.85);
    expect(r.status).toBe("close");
  });

  it("has no projection from an empty month", () => {
    const r = monthProjection([], today);
    expect(r.projected).toBe(0);
  });

  it("splits spend by the share of runs that failed", () => {
    const w = wastedSpend([pt("2026-11-12", "invoice", "mini", 10, 5, 8, 2), pt("2026-11-12", "tickets", "mini", 4, 2, 0, 4), pt("2026-11-12", "clean", "mini", 5, 1, 5, 0)]);
    expect(w.spend).toBe(8);
    expect(w.wasted).toBeCloseTo(1 + 2);
    expect(w.share).toBeCloseTo(3 / 8);
    expect(w.failedRuns).toBe(6);
    expect(w.byJob.map((j) => j.name)).toEqual(["tickets", "invoice"]); // largest first; "clean" wasted nothing
    expect(wastedSpend([]).share).toBeNull();
  });

  it("prices 1,000 good answers per job, against the period before", () => {
    const cur = [pt("2026-11-12", "a", "m", 30, 10, 20, 10), pt("2026-11-12", "b", "m", 10, 3, 0, 10)];
    const prev = [pt("2026-11-01", "a", "m", 20, 8, 20, 0)];
    const { all, jobs } = unitCosts(cur, prev);
    expect(jobs[0].job).toBe("b"); // no passing answers sorts first (the worst)
    expect(jobs[0].per1k).toBeNull();
    const a = jobs.find((j) => j.job === "a")!;
    expect(a.per1k).toBeCloseTo(500);
    expect(a.prevPer1k).toBeCloseTo(400);
    expect(a.change).toBeCloseTo(0.25);
    expect(all.per1k).toBeCloseTo((13 / 20) * 1000);
  });

  it("gives a range from the spread of the last 7 full days", () => {
    const r = monthProjection(month, today);
    expect(r.learning).toBe(false);
    expect(r.low).toBeCloseTo(35.5); // every one of the 7 days was $1
    expect(r.high).toBeCloseTo(35.5);
    const spiky = monthProjection([...month, { ...pt("2026-11-12", "invoice", "mini", 10, 6) }], today);
    expect(spiky.low).toBeCloseTo(24.5 + 17 * 1);
    expect(spiky.high).toBeCloseTo(24.5 + 17 * 7);
    expect(spiky.low).toBeLessThanOrEqual(spiky.projected);
    expect(spiky.projected).toBeLessThanOrEqual(spiky.high);
  });

  it("is still learning with fewer than 7 days of history", () => {
    const few = [pt("2026-11-10", "a", "m", 4, 2), pt("2026-11-12", "a", "m", 4, 2)];
    expect(monthProjection(few, today).learning).toBe(true);
    expect(monthProjection([], today).learning).toBe(true);
  });

  it("counts unpriced runs, and only this month's for the projection", () => {
    const withUnpriced = [{ ...pt("2026-11-12", "a", "m", 10, 1), unpriced_runs: 3 }, { ...pt("2026-10-20", "a", "m", 10, 1), unpriced_runs: 9 }];
    expect(unpricedRuns(withUnpriced)).toBe(12);
    expect(monthProjection(withUnpriced, today).unpriced).toBe(3);
    expect(unitCosts(withUnpriced, []).all.unpriced).toBe(12);
    expect(wastedSpend(withUnpriced).unpriced).toBe(12);
    expect(unpricedRuns(month)).toBe(0);
  });

  it("uses the actual cost of failed runs when the API gives it", () => {
    const w = wastedSpend([
      { ...pt("2026-11-12", "invoice", "mini", 10, 5, 8, 2), failed_spend_usd: 0.4 },
      { ...pt("2026-11-12", "tickets", "mini", 4, 2, 0, 4), failed_spend_usd: 2 },
    ]);
    expect(w.wasted).toBeCloseTo(2.4);
    expect(w.estimated).toBe(false);
    expect(wastedSpend([pt("2026-11-12", "a", "m", 10, 5, 8, 2)]).estimated).toBe(true); // no actual figure: the split
  });
});
