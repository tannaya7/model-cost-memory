import { describe, expect, it } from "vitest";
import { evidenceLine, isTooFew, MIN_CHECKED_ANSWERS, TOO_FEW_LABEL, UNTESTED_LABEL, wilsonInterval } from "./wilson";

describe("wilsonInterval", () => {
  it("matches the values in the research notes", () => {
    const a = wilsonInterval(93, 100)!;
    expect(a.low).toBeCloseTo(0.8625, 3);
    expect(a.high).toBeCloseTo(0.9657, 3);
    const b = wilsonInterval(2, 100)!;
    expect(b.low).toBeCloseTo(0.0055, 3);
    expect(b.high).toBeCloseTo(0.07, 3);
    const c = wilsonInterval(8, 10)!;
    expect(c.low).toBeCloseTo(0.49, 2);
    expect(c.high).toBeCloseTo(0.943, 2);
  });
  it("stays inside 0..1 and handles empty input", () => {
    expect(wilsonInterval(0, 5)!.low).toBe(0);
    expect(wilsonInterval(5, 5)!.high).toBe(1);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe("labels", () => {
  it("uses the one product floor of 25 checked answers", () => {
    expect(MIN_CHECKED_ANSWERS).toBe(25);
    expect(isTooFew(24)).toBe(true);
    expect(isTooFew(25)).toBe(false);
    expect(isTooFew(40, 50)).toBe(true);
    expect(evidenceLine(0.9, 12)).toContain("we need 25");
  });
  it("refuses a confident line under the floor", () => {
    expect(isTooFew(24)).toBe(true);
    expect(evidenceLine(0.9, 12)).toContain(TOO_FEW_LABEL);
    expect(evidenceLine(0.9, 12)).not.toMatch(/probably/);
  });
  it("shows n and the range from the floor up", () => {
    expect(evidenceLine(0.8, 100)).toMatch(/80% correct, probably 71% to 87% .*100 checked answers/);
  });
  it("labels untested models without a score", () => {
    expect(evidenceLine(null, null)).toBe(UNTESTED_LABEL);
  });
});
