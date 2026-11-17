import { afterEach, describe, expect, it, vi } from "vitest";
import { profileKey, readAnswers, writeAnswers } from "./answers";
import type { Answers } from "./types";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const A: Answers = { people: "2-10", tasks: ["coding"], priority: "cost", needs: ["images"], budgetUsd: 50 };

describe("answers storage", () => {
  it("stores per project and job", () => {
    expect(writeAnswers("acme", "invoice", A)).toBe(true);
    expect(localStorage.getItem("mcm_profile_acme_invoice")).not.toBeNull();
    expect(profileKey("acme", "invoice")).toBe("mcm_profile_acme_invoice");
    expect(readAnswers("acme", "invoice")).toEqual(A);
    expect(readAnswers("acme", "other")).toBeNull();
  });
  it("ignores damaged data", () => {
    localStorage.setItem(profileKey("p", "j"), "{nope");
    expect(readAnswers("p", "j")).toBeNull();
    localStorage.setItem(profileKey("p", "j"), JSON.stringify({ ...A, priority: "wild" }));
    expect(readAnswers("p", "j")).toBeNull();
  });
  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readAnswers("p", "j")).toBeNull();
    expect(writeAnswers("p", "j", A)).toBe(false);
  });
});
