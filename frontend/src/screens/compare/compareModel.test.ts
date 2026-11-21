/** The compare rows: what is drawn, what is listed as missing, and that nothing is recomputed or re-ranked. */
import { describe, expect, it } from "vitest";
import type { Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { buildRows, costState, diffRange, diffSentence, notDrawn, plottable, SPREAD_FLAG_RATIO, signed, yFloor, type Difference } from "./compareModel";

const base = recSample as unknown as Recommendation;
type M = Recommendation["models"][number];

export const model = (over: Partial<M> & { model: string }): M =>
  ({
    model_version: "v1", catalog_status: "ACTIVE", shutdown_date: null, n_runs: 200, failures: 10, evidence_weight: 190, effective_n: 180,
    weighted_pass_rate: 0.95, pass_rate_low: 0.91, pass_rate_high: 0.97, mean_cost_usd: 0.01, cost_per_success_usd: 0.0105,
    status: "GOOD_ENOUGH", eligible: true, why: "", vs_current: null, priced_runs: 200, unpriced_runs: 0, retest_runs: 0,
    cost_p50_usd: null, cost_p90_usd: null, ...over,
  }) as M;

export const recWith = (models: M[], over: Partial<Recommendation> = {}): Recommendation =>
  ({ ...base, current: { model: models[0].model, model_version: "v1" }, reference: models[0].model, models, ...over }) as Recommendation;

const diff = (over: Partial<Difference> = {}): Difference => ({
  against: "big", gap_points: -1.2, low_points: -5.0, high_points: 2.6, confidence: 0.99, margin_points: 3, status: "UNSURE", method: "unpaired", ...over,
});

describe("cost state: zero, missing and undefined are three different things", () => {
  it("a free model is $0, not unknown", () => expect(costState({ mean_cost_usd: 0, cost_per_success_usd: 0, weighted_pass_rate: 0.9 })).toBe("free"));
  it("no price is unpriced, never zero", () => expect(costState({ mean_cost_usd: null, cost_per_success_usd: null, weighted_pass_rate: 0.9 })).toBe("unpriced"));
  it("a model that passed nothing has a price but no cost of a correct answer", () => expect(costState({ mean_cost_usd: 0.01, cost_per_success_usd: null, weighted_pass_rate: 0 })).toBe("undefined"));
  it("a normal model is known", () => expect(costState({ mean_cost_usd: 0.01, cost_per_success_usd: 0.0105, weighted_pass_rate: 0.95 })).toBe("known"));
});

describe("rows", () => {
  const rec = recWith([model({ model: "big" }), model({ model: "free", mean_cost_usd: 0, cost_per_success_usd: 0 }), model({ model: "nopay", mean_cost_usd: null, cost_per_success_usd: null }), model({ model: "never", weighted_pass_rate: null, n_runs: 0, evidence_weight: 0, pass_rate_low: null, pass_rate_high: null, cost_per_success_usd: null })]);
  const rows = buildRows(rec);

  it("keeps the engine's order and never re-ranks", () => expect(rows.map((r) => r.model)).toEqual(["big", "free", "nopay", "never"]));
  it("draws a free model at zero and the model in use first", () => {
    expect(rows[1].cost1000).toBe(0);
    expect(plottable(rows[1])).toBe(true);
    expect(rows[0].isCurrent).toBe(true);
  });
  it("lists what is not drawn, with the reason, instead of dropping it", () => {
    const out = notDrawn(rows);
    expect(out.map((o) => o.model)).toEqual(["nopay", "never"]);
    expect(out[0].reason).toContain("no price is known");
    expect(out[1].reason).toContain("no checked answers yet");
  });
  it("a model that passed nothing is not drawn and says why", () => {
    const r = buildRows(recWith([model({ model: "zero", weighted_pass_rate: 0, cost_per_success_usd: null })]));
    expect(notDrawn(r)[0].reason).toContain("none of its checked answers passed");
  });
  it("uses the engine's range, not one worked out from the raw count", () => {
    expect(rows[0].low).toBe(0.91);
    expect(rows[0].high).toBe(0.97);
  });
  it("flags a heavy cost tail only when the dearest 1 in 10 costs at least double the typical call", () => {
    const f = (p50: number, p90: number) => buildRows(recWith([model({ model: "a", cost_p50_usd: p50, cost_p90_usd: p90 })]))[0].spread;
    expect(f(0.001, 0.001 * SPREAD_FLAG_RATIO)).toBe(true);
    expect(f(0.001, 0.0019)).toBe(false);
    expect(f(0, 0.5)).toBe(false); // no typical cost to compare with
    expect(buildRows(recWith([model({ model: "a" })]))[0].spread).toBe(false); // percentiles not available
  });
  it("carries the breakdown counts through, null when not measured", () => {
    const r = buildRows(recWith([model({ model: "a", priced_runs: 70, unpriced_runs: 30, retest_runs: 10 }), model({ model: "b", priced_runs: undefined, unpriced_runs: undefined, retest_runs: undefined })]));
    expect([r[0].priced, r[0].unpriced, r[0].retests]).toEqual([70, 30, 10]);
    expect([r[1].priced, r[1].unpriced, r[1].retests]).toEqual([null, null, null]);
  });
  it("a provider filter hides rows, it does not change anyone's numbers", () => {
    const r = buildRows(rec, (m) => m === "big");
    expect(r).toHaveLength(1);
    expect(r[0].low).toBe(0.91);
  });
});

describe("axes", () => {
  it("the quality axis starts below the lowest range and the good-enough line, on a 5 point step", () => {
    const rows = buildRows(recWith([model({ model: "a", pass_rate_low: 0.81 }), model({ model: "b", pass_rate_low: 0.9 })]));
    expect(yFloor(rows, 0.78)).toBe(0.7);
    expect(yFloor(rows, null)).toBe(0.75);
    expect(yFloor([], null)).toBe(0.95);
  });
  it("never goes below zero", () => expect(yFloor(buildRows(recWith([model({ model: "a", pass_rate_low: 0.02, weighted_pass_rate: 0.1 })])), null)).toBe(0));
  it("the difference range always includes zero, the margin line and every whole interval", () => {
    const rows = buildRows(recWith([model({ model: "a" }), model({ model: "b", vs_current: diff({ low_points: -12, high_points: -4 }) })]));
    const r = diffRange(rows)!;
    expect(r.min).toBeLessThan(-12);
    expect(r.max).toBeGreaterThan(0);
    expect(diffRange(buildRows(recWith([model({ model: "a" })])))).toBeNull();
  });
});

describe("the difference sentence never calls an unproven gap a tie", () => {
  it("a range above zero is ahead", () => expect(diffSentence(diff({ low_points: 0.4, high_points: 4, gap_points: 2, status: "GOOD_ENOUGH" }))).toContain("ahead of big"));
  it("a range that includes zero is not sure yet, with the caveat", () => {
    const s = diffSentence(diff());
    expect(s).toContain("not sure yet");
    expect(s).toContain("not proof they are the same");
    expect(s).not.toMatch(/\bties?\b|equally|look the same|no difference/);
  });
  it("good enough says at most the margin worse, not equal", () => expect(diffSentence(diff({ status: "GOOD_ENOUGH", low_points: -2.5, high_points: 1 }))).toContain("at most 3 points worse than big"));
  it("clearly worse says how far behind", () => expect(diffSentence(diff({ status: "CLEARLY_WORSE", low_points: -9, high_points: -4, gap_points: -6.5 }))).toContain("more than 3 points behind big"));
  it("uses a real minus sign and the confidence of the interval", () => {
    expect(signed(-1.24)).toBe("−1.2");
    expect(signed(0)).toBe("+0.0");
    expect(diffSentence(diff())).toContain("99% range");
  });
});
