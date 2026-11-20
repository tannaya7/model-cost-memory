import { describe, expect, it } from "vitest";
import { LEAN_FACTOR, MAX_OTHERS, sharedKeyScenario } from "./sharedKey";

const TODAY = new Date(Date.UTC(2026, 10, 16, 12, 0, 0)); // 16 Nov 2026, noon: 14.5 days of November left
// $100 spent so far, $10 a day lately, so about $245 at month end.
const MONTH = { mtd: 100, projected: 245, low: 200, high: 300, dailyRate: 10, learning: false };

describe("sharing a key: a what-if from your own spend", () => {
  it("gives nothing while there is under a week of history, and nothing when nobody else is added", () => {
    expect(sharedKeyScenario({ ...MONTH, learning: true }, 2, "same", null, TODAY)).toBeNull();
    expect(sharedKeyScenario(MONTH, 0, "same", null, TODAY)).toBeNull();
  });

  it("scales only the days still to come and leaves what is already spent alone", () => {
    const s = sharedKeyScenario(MONTH, 2, "same", null, TODAY)!;
    expect(s.multiplier).toBe(3); // you plus two people who use it as much as you
    expect(s.expected).toBe(100 + (245 - 100) * 3); // 535
    expect(s.low).toBe(100 + (200 - 100) * 3);
    expect(s.high).toBe(100 + (300 - 100) * 3);
    expect(s.yours).toBe(245);
    expect(s.extra).toBe(535 - 245);
  });

  it("uses the three plain steps: half, as much, double", () => {
    expect(LEAN_FACTOR).toEqual({ lighter: 0.5, same: 1, heavier: 2 });
    expect(sharedKeyScenario(MONTH, 2, "lighter", null, TODAY)!.multiplier).toBe(2);
    expect(sharedKeyScenario(MONTH, 2, "heavier", null, TODAY)!.multiplier).toBe(5);
  });

  it("says when a limit would be used up, and on which day", () => {
    const s = sharedKeyScenario(MONTH, 2, "same", 300, TODAY)!; // $200 left, $30 a day now: 6.67 days
    expect(s.alreadyPassed).toBe(false);
    expect(s.lastsToMonthEnd).toBe(false);
    expect(s.runsOutOn!.toISOString().slice(0, 10)).toBe("2026-11-23");
  });

  it("says the limit lasts to the end of the month when it does, and that it is used up when it already is", () => {
    const roomy = sharedKeyScenario(MONTH, 1, "lighter", 5000, TODAY)!;
    expect(roomy.lastsToMonthEnd).toBe(true);
    expect(roomy.runsOutOn).toBeNull();
    const spent = sharedKeyScenario(MONTH, 1, "same", 90, TODAY)!;
    expect(spent.alreadyPassed).toBe(true);
    expect(spent.runsOutOn).toBeNull();
  });

  it("makes no date up when there is no pace to go on, and no limit means no date", () => {
    expect(sharedKeyScenario({ ...MONTH, dailyRate: 0 }, 2, "same", 300, TODAY)!.runsOutOn).toBeNull();
    expect(sharedKeyScenario(MONTH, 2, "same", null, TODAY)!.lastsToMonthEnd).toBeNull();
  });

  it("caps the number of other people and ignores nonsense", () => {
    expect(sharedKeyScenario(MONTH, 500, "same", null, TODAY)!.multiplier).toBe(1 + MAX_OTHERS);
    expect(sharedKeyScenario(MONTH, -3, "same", null, TODAY)).toBeNull();
    expect(sharedKeyScenario(MONTH, 2.9, "same", null, TODAY)!.multiplier).toBe(3);
  });
});
