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

  it("repeated start needs 30% and 1,000 input tokens, and says what was seen, not what to expect", () => {
    const g = group({ repeated_start_share: 0.3, avg_tokens_in: 1000 });
    const [hint] = promptHints(g);
    expect(hint.title).toBe("Large repeated input observed");
    expect(hint.text).toBe("About 30% of the sampled prompts (the newest 20 calls with stored text) starts the same way in every call. Providers that cache repeated input may charge less for it. Whether that applies depends on your provider, model and settings.");
    expect(ids(group({ repeated_start_share: 0.29, avg_tokens_in: 1000 }))).toEqual([]);
    expect(ids(group({ repeated_start_share: 0.5, avg_tokens_in: 999 }))).toEqual([]);
  });

  it("repeated end only when the start is not repeated", () => {
    expect(ids(group({ repeated_end_share: 0.3, repeated_start_share: 0.05 }))).toEqual(["repeated-end"]);
    expect(ids(group({ repeated_end_share: 0.3 }))).toEqual(["repeated-end"]);
    expect(ids(group({ repeated_end_share: 0.3, repeated_start_share: 0.1 }))).toEqual([]);
    expect(ids(group({ repeated_end_share: 0.29 }))).toEqual([]);
  });

  it("heavy input at 20 times the output, never when output is 0, and quotes the real averages", () => {
    const [hint] = promptHints(group({ avg_tokens_in: 2000, avg_tokens_out: 100 }));
    expect(hint.id).toBe("heavy-input");
    expect(hint.text).toBe("On average about 2,000 tokens go in for 100 out. It may be worth checking that every part you send is needed.");
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
    expect(promptHints(g).find((h) => h.id === "cache-helping")!.text).toBe("About 30% of the input was read from the provider's cache.");
    expect(ids(group({ cache_read_share: 0.29 }))).toEqual([]);
  });

  it("labels each hint as measured over every call or estimated from a sample of stored text", () => {
    const g = group({ repeated_start_share: 0.6, repeated_end_share: 0.4, avg_tokens_in: 3000, avg_tokens_out: 10, cache_read_share: 0.5 });
    const by = Object.fromEntries(promptHints(g).map((h) => [h.id, h.basis]));
    expect(by).toEqual({ "repeated-start": "estimated", "heavy-input": "measured", "cache-helping": "measured" });
    expect(promptHints(group({ repeated_end_share: 0.3 }))[0].basis).toBe("estimated");
  });

  it("never promises a saving, an amount or a number of tokens saved, in any mode", () => {
    const everything = group({ repeated_start_share: 0.6, repeated_end_share: 0.05, avg_tokens_in: 3000, avg_tokens_out: 5000, cache_read_share: 0.5 });
    for (const mode of ["per_use", "both", "subscription"] as const) {
      const text = promptHints(everything, mode).map((h) => `${h.title} ${h.text}`).join(" ");
      expect(text).not.toMatch(/\$|\bsav(e|es|ed|ing|ings)\b|will (cut|reduce|lower)|guarantee|\bcut the cost\b|% (cheaper|less)|fewer tokens/i);
    }
    const long = promptHints(group({ avg_tokens_in: 100, avg_tokens_out: 300 }))[0].text;
    expect(long).toBe("On average about 300 tokens come out for 100 in. A maximum length, or a request for shorter answers, can make each call smaller.");
  });

  it("a subscription gets allowance-neutral wording, per use is unchanged", () => {
    const g = group({ repeated_start_share: 0.3, avg_tokens_in: 1000, avg_tokens_out: 1500 });
    const sub = promptHints(g, "subscription").map((h) => h.text).join(" ");
    expect(sub).toContain("Some providers count text they have already seen differently. We have not verified how your plan counts it.");
    expect(sub).not.toMatch(/charge|cost|cheaper|\$/i);
    expect(promptHints(g, "both")[0].text).toBe(promptHints(g)[0].text);
    expect(promptHints(g)[0].text).toContain("may charge less");
  });

  it("does not invent a sample size when none was stored", () => {
    const [hint] = promptHints(group({ repeated_start_share: 0.5, avg_tokens_in: 2000, text_samples: 0 }));
    expect(hint.text).toMatch(/^About 50% of the sampled prompts starts the same way/);
    expect(hint.text).not.toContain("newest 0");
  });
});
