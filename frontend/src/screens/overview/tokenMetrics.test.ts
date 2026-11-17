import { describe, expect, it } from "vitest";
import { avgInputPerRun, burnRate, cacheShare, dailySeries, hints, inputToOutput, limitRisk, tokenPeriods, topConsumers, totals, type TokenPoint } from "./tokenMetrics";

const today = new Date("2026-11-10T12:00:00Z");
const pt = (day: string, job: string, model: string, o: Partial<TokenPoint>): TokenPoint => ({ day, job, model, runs: 10, passed: 0, failed: 0, spend_usd: 0, ...o });
const points: TokenPoint[] = [
  pt("2026-11-10", "a", "m1", { tokens_in: 1000, tokens_out: 100, cache_read_tokens: 1000 }),
  pt("2026-11-09", "b", "m2", { tokens_in: 3000, tokens_out: 200 }),
  pt("2026-11-03", "a", "m1", { tokens_in: 1000, tokens_out: 100 }),
  pt("2026-11-01", "a", "m1", {}),
];

describe("tokenMetrics", () => {
  it("totals missing counts as zero", () => {
    expect(totals([points[3]]).all).toBe(0);
    expect(totals(points.slice(0, 2)).all).toBe(1000 + 100 + 1000 + 3000 + 200);
  });
  it("compares a period with the one before", () => {
    const r = tokenPeriods(points, 3, today);
    expect(r.cur.all).toBe(5300);
    expect(r.prev.all).toBe(0);
    expect(r.change).toBeNull();
    const x = tokenPeriods(points, 5, today);
    expect(x.prev.all).toBe(1100);
    expect(x.change).toBeCloseTo((3200 - 1100) / 1100); // completed days only: today (Nov 10) is partial
  });
  it("builds a daily series with empty days", () => {
    const rows = dailySeries(points, 3, today);
    expect(rows.map((r) => r.day)).toEqual(["2026-11-08", "2026-11-09", "2026-11-10"]);
    expect(rows[0].input).toBe(0);
    expect(rows[2]).toMatchObject({ input: 1000, output: 100, cached: 1000 });
  });
  it("works out cache share, ratio and average input", () => {
    const t = totals(points.slice(0, 1));
    expect(cacheShare(t)).toBe(0.5);
    expect(inputToOutput(t)).toBe(20);
    expect(avgInputPerRun(t)).toBe(200);
    expect(cacheShare(totals([]))).toBeNull();
    expect(inputToOutput(totals([]))).toBeNull();
  });
  it("ranks consumers with shares", () => {
    const c = topConsumers(points.slice(0, 2), "job");
    expect(c[0]).toMatchObject({ name: "b", tokens: 3200 });
    expect(c[0].share).toBeCloseTo(3200 / 5300);
    expect(topConsumers(points.slice(0, 3), "model", 1)).toHaveLength(1);
  });
  it("estimates the burn rate since the start of yesterday", () => {
    expect(burnRate(points, today)).toBeCloseTo(5300 / 36);
    expect(burnRate([], today)).toBeNull();
  });
  it("uses the limit's own hours to full, else the burn rate", () => {
    const lim = { measure: "TOKENS", used: 1000, size: 6000, hours_to_full: 9, hours_to_reset: 40, state: "AT_RISK", name: "weekly" };
    expect(limitRisk(points, [lim], today)?.hoursToFull).toBe(9);
    const r = limitRisk(points, [{ ...lim, hours_to_full: null }], today)!;
    expect(r.ownEstimate).toBe(false);
    expect(r.hoursToFull).toBeCloseTo(5000 / (5300 / 36));
    expect(limitRisk(points, [{ ...lim, measure: "USD" }], today)).toBeNull();
  });
});

const T = (o: Partial<ReturnType<typeof totals>>) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 10, all: 0, ...o });
const ids = (c: ReturnType<typeof totals>, p: ReturnType<typeof totals>) => hints(c, p).map((h) => h.id);

describe("hints", () => {
  it("flags prompt bloat above 20:1 only", () => {
    expect(ids(T({ input: 2100, output: 100 }), T({}))).toContain("bloat");
    expect(ids(T({ input: 2000, output: 100 }), T({}))).not.toContain("bloat");
  });
  it("flags growing input at +25%", () => {
    expect(ids(T({ input: 1250, output: 500 }), T({ input: 1000 }))).toContain("growth");
    expect(ids(T({ input: 1240, output: 500 }), T({ input: 1000 }))).not.toContain("growth");
    expect(ids(T({ input: 1250, output: 500 }), T({}))).not.toContain("growth");
  });
  it("suggests caching for big, barely cached inputs, without a saving figure", () => {
    const h = hints(T({ input: 20_000, output: 5000 }), T({})).find((x) => x.id === "caching")!;
    expect(h).toBeTruthy();
    expect(h.advice).not.toMatch(/\$/);
    expect(ids(T({ input: 20_000, cacheRead: 5000, output: 5000 }), T({}))).not.toContain("caching");
    expect(ids(T({ input: 10_000, output: 5000 }), T({}))).not.toContain("caching");
  });
  it("flags output heavier than input", () => {
    expect(ids(T({ input: 100, output: 200 }), T({}))).toContain("heavy-output");
    expect(ids(T({ input: 200, output: 100 }), T({}))).not.toContain("heavy-output");
  });
});
