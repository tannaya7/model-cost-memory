import { describe, expect, it } from "vitest";
import type { Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { buildWhy } from "./why";

const rec = recSample as unknown as Recommendation;
const text = (r: Recommendation) => buildWhy(r).map((s) => `${s.title}: ${s.text}`).join("\n");

describe("buildWhy", () => {
  it("explains a cheaper-model case with the gap and both costs", () => {
    const out = text({ ...rec, forecast: { monthly_saving_usd: 300, runs_per_month: 3000, extra_failures_per_month: 4, extra_failures_low: 1, extra_failures_high: 9 } as Recommendation["forecast"] });
    expect(out).toMatch(/What we looked at: 1,?084 checked answers/);
    expect(out).toMatch(/acme-mini got .* of answers correct.* per correct answer instead of/);
    expect(out).toMatch(/save about \$300/);
    expect(out).toMatch(/could be 1 to 9 more/);
    expect(out).toMatch(/Nothing changes until you decide/);
  });

  it("leads with the evidence and uncertainty before the reasons, and ends with the check-yourself line", () => {
    const titles = buildWhy(rec).map((s) => s.title);
    expect(titles[0]).toBe("What we looked at");
    expect(titles[1]).toBe("How sure are we");
    expect(titles.indexOf("How sure are we")).toBeLessThan(titles.findIndex((t) => /^Why /.test(t)));
    const last = buildWhy(rec).at(-1)!;
    expect(last.text).toBe("This is based on your recent AI calls; check it on a few examples yourself.");
    expect(text(rec)).toMatch(/95% range/);
  });

  it("says too few answers instead of a confident range under the floor of checked answers", () => {
    const thin = { ...rec, models: rec.models.map((m) => ({ ...m, n_runs: 12 })) };
    const out = text(thin);
    expect(out).toMatch(/Not enough checked answers yet/);
    expect(out).not.toMatch(/95% range/);
  });

  it("says what is missing instead of advising when evidence is thin", () => {
    const out = text({ ...rec, verdict: "INSUFFICIENT_EVIDENCE", recommended: null, forecast: null, progress: 0.4 });
    expect(out).toMatch(/What is missing: We need at least 25 recent checked answers/);
    expect(out).toMatch(/40% of the way/);
    expect(out).not.toMatch(/Why this model/);
  });

  it("keeps what you have on HOLD", () => {
    expect(text({ ...rec, verdict: "HOLD", recommended: rec.current, forecast: null })).toMatch(/Why keep it/);
  });
});
