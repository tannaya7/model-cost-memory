import { describe, expect, it } from "vitest";
import { correctAnswersSentence, summaryText } from "./promptCompare";
import type { PromptVersion } from "../../features/insights/api/promptVersionsApi";

const v = (label: string, rate: number, checked: number): PromptVersion => ({
  label, kind: "tagged", first_seen: "2026-11-01T00:00:00Z", last_seen: "2026-11-10T00:00:00Z", calls: checked, typical_tokens_in: 1, typical_tokens_out: 1, cache_read_share: null,
  priced_calls: checked, unpriced_calls: 0, cost_per_call: 0.01, checked, correct_rate: rate, rate_low: 0, rate_high: 1, start_preview: null,
});

describe("prompt version correct-answers wording (F21)", () => {
  it("70% against 95% at 25 checked each is not 'about the same'", () => {
    const s = correctAnswersSentence(v("v1", 0.7, 25), v("v2", 0.95, 25))!;
    expect(s).not.toMatch(/about the same/);
  });
  it("85% against 95% at 100 each is a real difference: both rates are stated", () => {
    const s = correctAnswersSentence(v("v1", 0.85, 100), v("v2", 0.95, 100))!;
    expect(s).toBe("Correct answers differ: 85% for v1 and 95% for v2, from 100 and 100 checked answers.");
  });
  it("says not enough to tell when the range for the difference spans 0", () => {
    expect(correctAnswersSentence(v("v1", 0.9, 30), v("v2", 0.93, 30))).toMatch(/^Correct answers: not enough to tell whether they differ \(90% for v1 and 93% for v2/);
  });
  it("swaps the server's 'look about the same' sentence in the summary", () => {
    const server = "v2 sends about 32% fewer input tokens than v1. Correct answers look about the same, from 100 and 100 checked answers.";
    const out = summaryText(server, [v("v1", 0.85, 100), v("v2", 0.95, 100)], "v1", "v2");
    expect(out).toContain("Correct answers differ: 85% for v1 and 95% for v2");
    expect(out).not.toMatch(/about the same, from/);
    expect(summaryText("Correct answers look about the same, but only 20 were checked.", [], "a", "b")).toMatch(/not enough to tell/);
  });
});
