import { describe, expect, it } from "vitest";
import { modelLink } from "./modelLinks";

describe("modelLink", () => {
  it("opens the model's own page where the pattern is verified", () => {
    expect(modelLink("claude-sonnet-5-5")?.url).toBe("https://platform.claude.com/docs/en/models/sonnet-5-5/overview");
    expect(modelLink("claude-haiku-5-5")?.url).toBe("https://platform.claude.com/docs/en/models/haiku-5-5/overview");
    expect(modelLink("gemini-2.5-flash")?.url).toBe("https://aistudio.google.com/docs/models/gemini-2.5-flash");
    expect(modelLink("gpt-6-luna")?.url).toBe("https://developers.openai.com/api/docs/models/gpt-6-luna");
    expect(modelLink("claude-sonnet-5-5")?.label).toBe("Read about it on Anthropic's site");
  });
  it("falls back to the overview for ids without a known page", () => {
    expect(modelLink("claude-sonnet-5-5-20261001")?.url).toBe("https://platform.claude.com/docs/en/models/overview");
    expect(modelLink("claude-opus-9-9")?.url).toBe("https://platform.claude.com/docs/en/models/overview");
    expect(modelLink("gemini-9.9-pro")?.url).toBe("https://aistudio.google.com/docs/models");
    expect(modelLink("gpt-4o")?.url).toBe("https://developers.openai.com/api/docs/models");
  });
  it("returns null for unknown models", () => {
    expect(modelLink("my-private-model")).toBeNull();
  });
});
