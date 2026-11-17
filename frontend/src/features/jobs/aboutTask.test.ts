import { describe, expect, it } from "vitest";
import type { DayPoint } from "../../shared/api/types";
import { checkExplanation, monthLine, summarizeMonth } from "./aboutTask";

const base = { name: "x", description: null };

describe("checkExplanation", () => {
  it("explains every kind in plain words", () => {
    expect(checkExplanation({ ...base, check_kind: "ANSWER_KEY", check_config: {} })[0]).toMatch(/right answer for each example/);
    expect(checkExplanation({ ...base, check_kind: "SCHEMA", check_config: {} })[0]).toMatch(/follows the format/);
    expect(checkExplanation({ ...base, check_kind: "TEST_COMMAND", check_config: {} })[0]).toMatch(/your test passes/);
    expect(checkExplanation({ ...base, check_kind: "LATE_LABEL", check_config: {} })[0]).toMatch(/only compare cost, not quality/);
  });
  it("shows field names but never answer values or secrets", () => {
    const text = checkExplanation({
      ...base, check_kind: "ANSWER_KEY",
      check_config: { fields: ["total"], answers: { total: "SECRET-1250" }, token: "sk-secret" },
    }).join(" ");
    expect(text).toContain("total");
    expect(text).not.toMatch(/SECRET|sk-/);
    const schema = checkExplanation({ ...base, check_kind: "SCHEMA", check_config: { schema: { required: ["category"] } } }).join(" ");
    expect(schema).toContain("category");
  });
  it("only characterises the work when the name or description makes it obvious", () => {
    expect(checkExplanation({ name: "ticket-classify", description: null, check_kind: "LATE_LABEL", check_config: {} }).join(" ")).toMatch(/sorting items/);
    expect(checkExplanation({ ...base, check_kind: "LATE_LABEL", check_config: {} })).toHaveLength(1);
  });
});

describe("month summary", () => {
  const pt = (o: Partial<DayPoint>) => ({ runs: 0, tokens_in: 0, tokens_out: 0, spend_usd: 0, passed: 0, failed: 0, ...o }) as DayPoint;
  it("adds the days up into one line", () => {
    const m = summarizeMonth([pt({ runs: 10, tokens_in: 100, tokens_out: 50, spend_usd: 1.5, passed: 6, failed: 2 }), pt({ runs: 5, passed: 2, failed: 0 })]);
    expect(monthLine(m)).toBe("15 AI calls · 150 tokens (100 in, 50 out) · $1.50 · 80% of checked answers correct");
  });
  it("leaves the dollar figure out on a subscription and labels it for both", () => {
    const m = summarizeMonth([pt({ runs: 10, tokens_in: 100, tokens_out: 50, spend_usd: 1.5, passed: 6, failed: 2 })]);
    expect(monthLine(m, "subscription")).toBe("10 AI calls · 150 tokens (100 in, 50 out) · 75% of checked answers correct");
    expect(monthLine(m, "both")).toContain("$1.50 at list prices");
  });
  it("is honest when there are no calls", () => {
    expect(monthLine(summarizeMonth([]))).toBe("No calls this month yet.");
  });
});
