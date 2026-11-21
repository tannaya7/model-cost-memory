import { describe, expect, it } from "vitest";
import { nextStep, shouldAutoStartTour, TOUR_STEPS } from "./steps";

describe("tour steps", () => {
  it("has six steps and starts with sending the first call", () => {
    expect(TOUR_STEPS).toHaveLength(6);
    expect(TOUR_STEPS[0].id).toBe("first-call");
    expect(TOUR_STEPS[0].code).toBe(true);
    expect(TOUR_STEPS[0].target).toBeUndefined();
  });
  it("every other step points at a named part of the app and says what will show later", () => {
    for (const s of TOUR_STEPS.slice(1)) expect(s.target).toBeTruthy();
    for (const s of TOUR_STEPS) expect(s.later.length).toBeGreaterThan(10);
    expect(TOUR_STEPS.map((s) => s.target).filter(Boolean)).toEqual(["overview", "tasks", "compare", "activity", "settings"]);
  });
  it("walks forward and back, and ends after the last step", () => {
    expect(nextStep(0, 1)).toBe(1);
    expect(nextStep(0, -1)).toBe(0);
    expect(nextStep(5, 1)).toBeNull();
  });
});

describe("when the tour starts by itself", () => {
  const base = { flagsLoaded: true, flags: {}, owned: true, dataLoaded: true, totalRuns: 0 };
  it("starts for a new, empty project nobody has toured", () => expect(shouldAutoStartTour(base)).toBe(true));
  it("does not start once seen", () => expect(shouldAutoStartTour({ ...base, flags: { tour_seen: true } })).toBe(false));
  it("does not start when the project already has calls", () => expect(shouldAutoStartTour({ ...base, totalRuns: 3 })).toBe(false));
  it("waits until the flags and the numbers are known", () => {
    expect(shouldAutoStartTour({ ...base, flagsLoaded: false })).toBe(false);
    expect(shouldAutoStartTour({ ...base, dataLoaded: false })).toBe(false);
  });
  it("does not start on the public demo or a key-only project", () => expect(shouldAutoStartTour({ ...base, owned: false })).toBe(false));
});
