import { describe, expect, it } from "vitest";
import { commonStart, pickPassExamples, summaryLines, typicalWords } from "./sample";

const call = (id: string, day: number, prompt: string | null) => ({ id, created_at: `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`, prompt_preview: prompt });

describe("commonStart", () => {
  it("finds the longest opening shared by half of the prompts", () => {
    expect(commonStart(["Extract the total from invoice 1", "Extract the total from invoice 2", "Something else"])).toBe("Extract the total from invoice");
  });
  it("is null when nothing is shared widely enough", () => {
    expect(commonStart(["alpha beta", "gamma delta", "epsilon zeta"])).toBeNull();
  });
  it("needs at least two words and ignores empty previews", () => {
    expect(commonStart(["Hello a", "Hello b", null])).toBeNull();
    expect(commonStart([null, null])).toBeNull();
    expect(commonStart(["Only one"])).toBeNull();
  });
  it("counts exactly half", () => {
    expect(commonStart(["a b c x", "a b c y", "q r", "s t"])).toBe("a b c");
  });
});

describe("typicalWords", () => {
  it("is the median word count", () => {
    expect(typicalWords(["one two", "one two three four", "one"])).toBe(2);
  });
  it("is null when a preview was cut at the limit", () => {
    expect(typicalWords(["x".repeat(240)])).toBeNull();
    expect(typicalWords([null])).toBeNull();
  });
});

describe("summaryLines", () => {
  it("uses words and the common start when available", () => {
    const s = summaryLines({ calls: 1200, tokensIn: 0, previews: ["Sort ticket one", "Sort ticket two"] });
    expect(s.sent).toBe("Your app sent 1,200 AI calls here in the last 30 days.");
    expect(s.typical).toBe('A typical prompt starts "Sort ticket" and is about 3 words.');
    expect(s.tokens).toBe(false);
  });
  it("falls back to tokens", () => {
    const s = summaryLines({ calls: 10, tokensIn: 5000, previews: ["x".repeat(240)] });
    expect(s.typical).toBe("A typical prompt is about 500 tokens.");
    expect(s.tokens).toBe(true);
  });
  it("has no typical line without previews or tokens", () => {
    expect(summaryLines({ calls: 0, tokensIn: 0, previews: [] }).typical).toBeNull();
  });
});

describe("pickPassExamples", () => {
  it("picks the latest, then the most different of the latest 20", () => {
    const pass = [call("a", 5, "total of invoice seven"), call("b", 4, "total of invoice six"), call("c", 3, "translate this poem"), call("d", 2, "total invoice")];
    const r = pickPassExamples(pass);
    expect(r.typical?.id).toBe("a");
    expect(r.different?.id).toBe("c");
  });
  it("breaks ties with the longest prompt", () => {
    const r = pickPassExamples([call("a", 5, "zzz"), call("b", 4, "foo"), call("c", 3, "bar baz")]);
    expect(r.different?.id).toBe("c");
  });
  it("omits the second with fewer than two, and handles none", () => {
    expect(pickPassExamples([call("a", 1, "x")]).different).toBeNull();
    expect(pickPassExamples([])).toEqual({ typical: null, different: null });
  });
  it("copes with null previews", () => {
    const r = pickPassExamples([call("a", 2, null), call("b", 1, null)]);
    expect(r.different?.id).toBe("b");
  });
});
