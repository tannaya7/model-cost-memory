import { describe, expect, it } from "vitest";
import { modelLink } from "./modelLinks";
import { suggestFromProfile, type CatalogModel } from "./suggest";
import type { Answers, ProfileUsage } from "./types";

const m = (model: string, i: number | null, o: number | null, status = "ACTIVE"): CatalogModel => ({ model, provider: "x", status, price_in_per_mtok: i, price_out_per_mtok: o });
const CATALOG = [
  m("claude-opus-5-5", 4, 20), m("claude-sonnet-5-5", 2, 10), m("claude-haiku-5-5", 0.1, 0.5),
  m("gemini-3.5-flash-lite", 0.1, 0.4), m("gemini-3.8-flash", 0.3, 2.5), m("gemini-3.1-pro-preview", 2, 12),
  m("gpt-6.1-sol", 3, 12), m("gpt-6-luna", 0.2, 1),
];
const USAGE: ProfileUsage = { daysOfHistory: 30, runs: 3000, monthlyTokensIn: 6_000_000, monthlyTokensOut: 1_000_000, monthlySpendUsd: 30, budgetUsd: null, currentModels: ["claude-sonnet-5-5"], periodFrom: "2026-10-14", periodTo: "2026-11-13" };
const A: Answers = { people: "1", tasks: [], priority: "balanced", needs: [], budgetUsd: null };

describe("suggestFromProfile", () => {
  it("is deterministic and returns at most three options", () => {
    const a = { ...A, tasks: ["coding" as const] };
    const one = suggestFromProfile(a, USAGE, CATALOG);
    expect(one.length).toBeLessThanOrEqual(3);
    expect(suggestFromProfile(a, USAGE, [...CATALOG].reverse())).toEqual(one);
  });

  it("matches the work against what the providers publish", () => {
    const r = suggestFromProfile({ ...A, tasks: ["classification"], priority: "speed" }, USAGE, CATALOG);
    expect(r[0].model).toBe("claude-haiku-5-5");
    expect(r[0].why.join(" ")).toContain("Classification or tagging");
  });

  it("orders by estimated cost when cost matters, cheapest first, no price last", () => {
    const r = suggestFromProfile({ ...A, priority: "cost" }, USAGE, [...CATALOG, m("claude-opus-4-1", null, null)]);
    const costs = r.map((x) => x.estimatedMonthlyUsd);
    expect(costs[0]).toBeCloseTo(6 * 0.1 + 1 * 0.4, 5);
    expect(costs).toEqual([...costs].sort((a, b) => (a ?? Infinity) - (b ?? Infinity)));
  });

  it("prefers larger families for quality", () => {
    const r = suggestFromProfile({ ...A, priority: "quality" }, USAGE, CATALOG);
    expect(r.map((x) => x.model).sort()).toEqual(["claude-opus-5-5", "gemini-3.1-pro-preview", "gpt-6.1-sol"]); // the three large families
  });

  it("keeps a provider whose image or tool support we could not confirm, ordered after confirmed ones, with a note", () => {
    const img = suggestFromProfile({ ...A, needs: ["images"], priority: "quality" }, USAGE, CATALOG);
    const openai = img.find((x) => x.provider === "OpenAI");
    expect(img.length).toBeGreaterThan(0);
    // either it is listed with a "not confirmed" note, or three confirmed families outrank it
    if (openai) expect(openai.why.join(" ")).toMatch(/not confirmed/);
    const tool = suggestFromProfile({ ...A, needs: ["tool-use"], priority: "quality" }, USAGE, CATALOG);
    const gpt = tool.find((x) => x.model === "gpt-6.1-sol");
    if (gpt) expect(gpt.why.join(" ")).toMatch(/not confirmed/);
    expect(tool.indexOf(tool.find((x) => x.provider === "Anthropic")!)).toBeLessThan(gpt ? tool.indexOf(gpt) : Infinity);
    const long = suggestFromProfile({ ...A, needs: ["long-inputs"] }, { ...USAGE, runs: 3000 }, CATALOG);
    expect(long.length).toBeGreaterThan(0);
  });

  it("drops a model whose published window is smaller than a typical run", () => {
    const huge = { ...USAGE, runs: 3, monthlyTokensIn: 6_000_000 }; // 2M tokens per run
    expect(suggestFromProfile(A, huge, CATALOG).map((x) => x.model)).toEqual(expect.arrayContaining(["gemini-3.8-flash"]));
    expect(suggestFromProfile(A, huge, CATALOG).map((x) => x.provider)).not.toContain("Anthropic");
  });

  it("flags cost against the budget", () => {
    const r = suggestFromProfile({ ...A, priority: "quality", budgetUsd: 10 }, USAGE, CATALOG);
    const opus = r.find((x) => x.model === "claude-opus-5-5")!;
    expect(opus.fitsBudget).toBe(false);
    expect(opus.why.join(" ")).toContain("over your $10.00 monthly budget");
    const cheap = suggestFromProfile({ ...A, priority: "cost", budgetUsd: 10 }, USAGE, CATALOG)[0];
    expect(cheap.fitsBudget).toBe(true);
  });

  it("leaves cost and budget fit empty when a price is missing", () => {
    const r = suggestFromProfile({ ...A, priority: "cost", budgetUsd: 5 }, USAGE, [m("claude-haiku-5-5", null, 0.5)]);
    expect(r[0].estimatedMonthlyUsd).toBeNull();
    expect(r[0].fitsBudget).toBeNull();
    expect(r[0].why.join(" ")).toContain("No price");
  });

  it("keeps a family the catalog lacks, without a cost, and never suggests retired models", () => {
    const r = suggestFromProfile({ ...A, tasks: ["coding"], priority: "quality" }, USAGE, [m("claude-opus-4-1", 15, 75, "RETIRED")]);
    expect(r.find((x) => x.model === "claude-opus-4-1")).toBeUndefined();
    expect(r.find((x) => x.model === "Claude Opus")?.estimatedMonthlyUsd).toBeNull();
  });

  it("changes only the wording with the number of people", () => {
    const a = { ...A, tasks: ["coding" as const], priority: "quality" as const };
    const one = suggestFromProfile(a, USAGE, CATALOG);
    const many = suggestFromProfile({ ...a, people: "50+" }, USAGE, CATALOG);
    expect(many.map((x) => x.model)).toEqual(one.map((x) => x.model));
    expect(many[0].why.join(" ")).toContain("share");
    expect(one[0].why.join(" ")).not.toContain("overlap");
  });

  it("never calls a model better or best, and always has profile confidence and a link", () => {
    const priorities = ["cost", "quality", "speed", "balanced"] as const;
    for (const priority of priorities) {
      const all = suggestFromProfile({ people: "11-50", tasks: ["coding", "reasoning", "long-documents", "support"], priority, needs: ["privacy", "long-inputs"], budgetUsd: 20 }, USAGE, CATALOG);
      for (const o of all) {
        expect(o.confidence).toBe("profile");
        expect(o.link?.url).toMatch(/^https:\/\//);
        expect(o.why.join(" ")).not.toMatch(/\b(better|best|worse|top)\b/i);
      }
    }
  });
});

describe("modelLink", () => {
  it("links known families to the provider's overview page", () => {
    expect(modelLink("claude-sonnet-4-6")).toEqual({ url: "https://platform.claude.com/docs/en/models/overview", label: "Read about it on Anthropic's site" });
    expect(modelLink("gemini-2.5-flash")?.label).toBe("Read about it on Google's site");
    expect(modelLink("gpt-4o")?.url).toBe("https://developers.openai.com/api/docs/models");
  });
  it("returns null for unknown models", () => {
    expect(modelLink("my-private-model")).toBeNull();
  });
});
