import { describe, expect, it } from "vitest";
import type { DayPoint } from "./metrics";
import { toCsv } from "./metrics";

const pt = (job: string, model = "mini", spend = 0.25, runs = 1) =>
  ({ day: "2026-11-13", job, model, runs, spend_usd: spend, passed: 1, failed: 0 }) as DayPoint;

describe("toCsv formula injection", () => {
  it("prefixes a formula in a text column and still quotes it", () => {
    const row = toCsv([pt('=HYPERLINK("http://x","a")')]).split("\n")[1];
    expect(row).toBe(`2026-11-13,"'=HYPERLINK(""http://x"",""a"")",mini,1,1,0,0.25`);
  });
  it("neutralises + - @ and quotes commas", () => {
    expect(toCsv([pt("-cmd, now")])).toContain(`"'-cmd, now"`);
    expect(toCsv([pt("@SUM(1)")])).toContain(",'@SUM(1),");
    expect(toCsv([pt("+1")])).toContain(",'+1,");
  });
  it("leaves numeric columns alone, so a negative stays a number", () => {
    expect(toCsv([pt("ok", "mini", -1.5, -2)]).split("\n")[1]).toBe("2026-11-13,ok,mini,-2,1,0,-1.5");
  });
  it("leaves ordinary text unchanged", () => {
    expect(toCsv([pt("say hi")]).split("\n")[1]).toBe("2026-11-13,say hi,mini,1,1,0,0.25");
  });
});
