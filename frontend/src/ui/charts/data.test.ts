import { describe, expect, it } from "vitest";
import type { DayPoint } from "../../shared/api/types";
import { change, dayRange, pivot, rollingPassRate } from "./data";

const TODAY = new Date("2026-11-13T12:00:00Z");

function point(day: string, job: string, model: string, runs: number, passed: number, failed: number, spend = 0): DayPoint {
  return { day, job, model, runs, passed, failed, spend_usd: spend };
}

describe("dayRange", () => {
  it("covers every day up to today, so a quiet day shows as zero rather than a slope", () => {
    expect(dayRange([], 3, TODAY)).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
  });
});

describe("pivot", () => {
  it("puts each job in its own column and fills missing days with zero", () => {
    const { rows, names } = pivot(
      [point("2026-11-11", "invoice", "mini", 5, 5, 0, 1.5), point("2026-11-13", "ticket", "mini", 2, 2, 0, 0.25), point("2026-11-13", "invoice", "big", 1, 1, 0, 0.5)],
      "job",
      "spend_usd",
      3,
      TODAY,
    );
    expect(names).toEqual(["invoice", "ticket"]);
    expect(rows).toEqual([
      { day: "2026-11-11", invoice: 1.5, ticket: 0 },
      { day: "2026-11-12", invoice: 0, ticket: 0 },
      { day: "2026-11-13", invoice: 0.5, ticket: 0.25 },
    ]);
  });
});

describe("rollingPassRate", () => {
  it("averages over the trailing window and stays empty until there are enough checked runs", () => {
    const points = [
      point("2026-11-11", "j", "mini", 6, 5, 1),
      point("2026-11-12", "j", "mini", 4, 2, 2),
      point("2026-11-13", "j", "mini", 10, 10, 0),
    ];
    const { rows } = rollingPassRate(points, { window: 2, minChecked: 8, days: 3, today: TODAY });
    expect(rows.map((r) => r.mini)).toEqual([null, 7 / 10, 12 / 14]);
  });

  it("does not count unchecked runs as failures", () => {
    const { rows } = rollingPassRate([point("2026-11-13", "j", "mini", 10, 8, 0)], { minChecked: 1, days: 1, today: TODAY });
    expect(rows[0].mini).toBe(1);
  });
});

describe("change", () => {
  it("compares the last period with the one before it", () => {
    const points = [point("2026-11-05", "j", "m", 10, 0, 0, 10), point("2026-11-12", "j", "m", 15, 0, 0, 15)];
    expect(change(points, "spend_usd", 7, TODAY)).toBeCloseTo(0.5);
    expect(change([point("2026-11-12", "j", "m", 1, 0, 0, 1)], "spend_usd", 7, TODAY)).toBeNull(); // nothing to compare with
  });
});
