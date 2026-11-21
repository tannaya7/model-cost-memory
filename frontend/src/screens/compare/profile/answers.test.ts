import { afterEach, describe, expect, it, vi } from "vitest";
import { clearProfile, isEmpty, NO_ANSWERS, profileKey, readProfile, saveProfile, skipProfile } from "./answers";
import type { Answers } from "./types";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const A: Answers = { tasks: ["coding"], priority: "cost", needs: ["images"], budgetUsd: 50 };

describe("answers storage", () => {
  it("stores per project and job, and per project before there is a job", () => {
    expect(saveProfile("acme", "invoice", A)).toBe(true);
    expect(profileKey("acme", "invoice")).toBe("mcm_profile_acme_invoice");
    expect(profileKey("acme", null)).toBe("mcm_profile_acme");
    expect(readProfile("acme", "invoice")).toEqual({ state: "answered", answers: A });
    expect(readProfile("acme", "other")).toEqual({ state: "none" });
    expect(readProfile("acme", null)).toEqual({ state: "none" });
  });

  it("a skip is remembered as a skip, not as answers", () => {
    expect(skipProfile("acme", null)).toBe(true);
    expect(readProfile("acme", null)).toEqual({ state: "skipped" });
  });

  it("submitting with nothing chosen is a skip: no answer is invented", () => {
    saveProfile("acme", "invoice", NO_ANSWERS);
    expect(readProfile("acme", "invoice")).toEqual({ state: "skipped" });
    expect(isEmpty(NO_ANSWERS)).toBe(true);
  });

  it("partial answers are kept as given, with the rest not answered", () => {
    const partial: Answers = { tasks: [], priority: "speed", needs: [], budgetUsd: null };
    saveProfile("acme", "invoice", partial);
    expect(readProfile("acme", "invoice")).toEqual({ state: "answered", answers: partial });
    const onlyBudget: Answers = { tasks: [], priority: null, needs: [], budgetUsd: 25 };
    saveProfile("acme", "invoice", onlyBudget);
    expect(readProfile("acme", "invoice")).toEqual({ state: "answered", answers: onlyBudget });
  });

  it("a change replaces what was saved", () => {
    saveProfile("acme", "invoice", A);
    saveProfile("acme", "invoice", { ...A, priority: "quality", tasks: ["support"] });
    expect(readProfile("acme", "invoice")).toEqual({ state: "answered", answers: { ...A, priority: "quality", tasks: ["support"] } });
  });

  it("clearing forgets the answers and a skip, and only for that task", () => {
    saveProfile("acme", "invoice", A);
    saveProfile("acme", "other", A);
    skipProfile("acme", null);
    expect(clearProfile("acme", "invoice")).toBe(true);
    expect(clearProfile("acme", null)).toBe(true);
    expect(readProfile("acme", "invoice")).toEqual({ state: "none" });
    expect(readProfile("acme", null)).toEqual({ state: "none" });
    expect(readProfile("acme", "other").state).toBe("answered");
    expect(localStorage.getItem("mcm_profile_acme_invoice")).toBeNull();
  });

  it("reads older saves, dropping the team size and keeping the rest", () => {
    localStorage.setItem(profileKey("p", "j"), JSON.stringify({ people: "11-50", tasks: ["coding"], priority: "balanced", needs: [], budgetUsd: null }));
    expect(readProfile("p", "j")).toEqual({ state: "answered", answers: { tasks: ["coding"], priority: "balanced", needs: [], budgetUsd: null } });
  });

  it("ignores damaged data", () => {
    localStorage.setItem(profileKey("p", "j"), "{nope");
    expect(readProfile("p", "j")).toEqual({ state: "none" });
    localStorage.setItem(profileKey("p", "j"), JSON.stringify({ ...A, priority: "wild" }));
    expect(readProfile("p", "j")).toEqual({ state: "none" });
    localStorage.setItem(profileKey("p", "j"), JSON.stringify({ ...A, tasks: ["not-a-task"] }));
    expect(readProfile("p", "j")).toEqual({ state: "none" });
    localStorage.setItem(profileKey("p", "j"), JSON.stringify({ ...A, budgetUsd: -5 }));
    expect(readProfile("p", "j")).toEqual({ state: "none" });
  });

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readProfile("p", "j")).toEqual({ state: "none" });
    expect(saveProfile("p", "j", A)).toBe(false);
    expect(skipProfile("p", "j")).toBe(false);
    expect(clearProfile("p", "j")).toBe(false);
  });
});
