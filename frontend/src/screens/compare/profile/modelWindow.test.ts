import { describe, expect, it } from "vitest";
import { claudeWindow, entryFor } from "./modelCatalog";

describe("Claude context window by version", () => {
  it("uses 1M only for the versions the official overview lists at 1M", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-8"]) expect(claudeWindow(id)).toBe(1_000_000);
  });
  it("uses 200K for the older 4.5 ids", () => {
    for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1", "claude-opus-4"]) expect(claudeWindow(id)).toBe(200_000);
  });
  it("gives no window for ids that are not on the page", () => {
    expect(claudeWindow("claude-haiku-9-9")).toBeUndefined();
    expect(entryFor("claude-3-haiku")?.contextWindow).toBeUndefined();
    expect(entryFor("claude-sonnet-4-5")?.contextWindow).toBe(200_000);
  });
});
