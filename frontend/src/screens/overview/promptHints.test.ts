import { describe, expect, it } from "vitest";
import type { PromptGroup } from "../../features/insights/api/promptsApi";
import { promptHints } from "./promptHints";

const group = (o: Partial<PromptGroup> = {}): PromptGroup => ({
  job: "invoice", prompt_version: null, calls: 100, tokens_in: 100000, tokens_out: 10000, cache_read_tokens: 0, cache_write_tokens: 0,
  total_tokens: 110000, share: 0.5, avg_tokens_in: 500, avg_tokens_out: 200, cache_read_share: null, text_samples: 20,
  repeated_start_share: null, repeated_end_share: null, repeated_start_preview: null, ...o,
});
const ids = (g: PromptGroup) => promptHints(g).map((h) => h.id);

describe("promptHints", () => {
  it("says nothing for an ordinary prompt", () => expect(ids(group())).toEqual([]));
  it("repeated start needs 30% and 1,000 input tokens", () => {
    const g = group({ repeated_start_share: 0.3, avg_tokens_in: 1000 });
    expect(promptHints(g)[0].text).toBe("30% of this prompt is the same in every call. Many providers charge much less for text they have already seen. Keep it at the very start and turn on prompt caching with your provider.");
    expect(ids(group({ repeated_start_share: 0.29, avg_tokens_in: 1000 }))).toEqual([]);
    expect(ids(group({ repeated_start_share: 0.5, avg_tokens_in: 999 }))).toEqual([]);
  });
  it("repeated end only when the start is not repeated", () => {
    expect(ids(group({ repeated_end_share: 0.3, repeated_start_share: 0.05 }))).toEqual(["repeated-end"]);
    expect(ids(group({ repeated_end_share: 0.3 }))).toEqual(["repeated-end"]);
    expect(ids(group({ repeated_end_share: 0.3, repeated_start_share: 0.1 }))).toEqual([]);
    expect(ids(group({ repeated_end_share: 0.29 }))).toEqual([]);
  });
  it("heavy input at 20 times the output, never when output is 0", () => {
    expect(ids(group({ avg_tokens_in: 2000, avg_tokens_out: 100 }))).toEqual(["heavy-input"]);
    expect(ids(group({ avg_tokens_in: 1999, avg_tokens_out: 100 }))).toEqual([]);
    expect(ids(group({ avg_tokens_in: 2000, avg_tokens_out: 0 }))).toEqual([]);
  });
  it("long answers when output is at least input", () => {
    expect(ids(group({ avg_tokens_in: 100, avg_tokens_out: 100 }))).toEqual(["long-answers"]);
    expect(ids(group({ avg_tokens_in: 100, avg_tokens_out: 99 }))).toEqual([]);
  });
  it("gives no tips under 10% share", () => {
    expect(promptHints(group({ share: 0.09, avg_tokens_in: 100, avg_tokens_out: 100, cache_read_share: 0.9 }))).toEqual([]);
    expect(ids(group({ share: 0.1, avg_tokens_in: 100, avg_tokens_out: 100 }))).toEqual(["long-answers"]);
  });
  it("gives at most 2 tips, in order, and the cache note is extra", () => {
    const g = group({ repeated_start_share: 0.6, repeated_end_share: 0.4, avg_tokens_in: 3000, avg_tokens_out: 10, cache_read_share: 0.3 });
    expect(ids(g)).toEqual(["repeated-start", "heavy-input", "cache-helping"]);
    expect(promptHints(g).find((h) => h.id === "cache-helping")!.text).toBe("Good: about 30% of what you send is already read from cache.");
    expect(ids(group({ cache_read_share: 0.29 }))).toEqual([]);
  });
});
