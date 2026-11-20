import { describe, expect, it } from "vitest";
import type { Model, Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { estimateRunCost, suggestForCheckedJob, untestedModels } from "./suggest";

const base = recSample as unknown as Recommendation;
const ev = (model: string, over: Record<string, unknown>) => ({ ...base.models[0], model, model_version: model, catalog_status: "ACTIVE", ...over });
const rec = {
  ...base,
  current: { model: "big", model_version: "big" },
  rules: { ...base.rules, evidence_floor: 30 },
  models: [
    ev("big", { status: "GOOD_ENOUGH", eligible: true, mean_cost_usd: 0.02, weighted_pass_rate: 0.99, evidence_weight: 100, n_runs: 100 }),
    ev("small", { status: "GOOD_ENOUGH", eligible: true, mean_cost_usd: 0.005, weighted_pass_rate: 0.98, evidence_weight: 80, n_runs: 80 }),
  ],
} as unknown as Recommendation;
const cat = (model: string, provider: string, pin: number, pout: number, status = "ACTIVE") =>
  ({ model, model_version: model, provider, price_in_per_mtok: pin, price_out_per_mtok: pout, status }) as unknown as Model;
const catalog = [cat("big", "acme", 3, 15), cat("small", "acme", 0.3, 1), cat("tiny", "other", 0.1, 0.4), cat("old", "other", 0.01, 0.01, "RETIRED")];
const run = { rec, catalog, avgTokens: { in: 1000, out: 200 }, runsPerMonth: 1000, budgetUsd: null };

describe("suggestForCheckedJob", () => {
  it("carries n and a Wilson range, and flags thin evidence", () => {
    const s = suggestForCheckedJob(run);
    expect(s[0]).toMatchObject({ nChecked: 80, tooFew: false });
    expect(s[0].interval!.low).toBeLessThan(0.98);
    expect(s[0].reason).toMatch(/80 checked answers/);
    expect(s[2]).toMatchObject({ nChecked: null, interval: null });
    const thin = suggestForCheckedJob({ ...run, rec: { ...rec, models: rec.models.map((m) => ({ ...m, n_runs: 10, evidence_weight: 10 })) } as typeof rec });
    expect(thin[0].tooFew).toBe(true);
    expect(thin[0].reason).toMatch(/Not enough checked answers yet/);
  });

  it("names the cheapest proven, the best quality and a model worth testing", () => {
    const s = suggestForCheckedJob(run);
    expect(s.map((x) => x.label)).toEqual(["Cheapest good enough", "Best quality", "Worth testing"]);
    expect(s[0]).toMatchObject({ model: "small", evidence: "measured", monthlyCostUsd: 5 });
    expect(s[1].model).toBe("big");
    expect(s[2]).toMatchObject({ model: "tiny", evidence: "estimate", passRate: null });
    expect(s[2].monthlyCostUsd).toBeCloseTo(0.18, 5);
    expect(s[2].reason).toMatch(/Not tested on your work yet/);
    expect(s[2].reason).not.toMatch(/better/);
  });
  it("checks each against the budget", () => {
    const s = suggestForCheckedJob({ ...run, budgetUsd: 10 });
    expect(s.map((x) => x.fitsBudget)).toEqual([true, false, true]);
  });
  it("skips untested suggestions when tokens are unknown, and retired models always", () => {
    const s = suggestForCheckedJob({ ...run, avgTokens: null });
    expect(s.map((x) => x.label)).toEqual(["Cheapest good enough", "Best quality"]);
    expect(untestedModels(rec, catalog).map((m) => m.model)).toEqual(["tiny"]);
  });
  it("respects the provider filter", () => {
    const s = suggestForCheckedJob({ ...run, providers: ["other"] });
    expect(s).toHaveLength(1);
    expect(s[0].model).toBe("tiny");
  });
  it("estimates a run from list prices", () => {
    expect(estimateRunCost(catalog[1], { in: 1_000_000, out: 1_000_000 })).toBeCloseTo(1.3);
    expect(estimateRunCost({ price_in_per_mtok: null, price_out_per_mtok: 1 }, { in: 1, out: 1 })).toBeNull();
  });
});
