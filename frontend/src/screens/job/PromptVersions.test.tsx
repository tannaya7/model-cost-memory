import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import type { PromptVersion, PromptVersions as Data } from "../../features/insights/api/promptVersionsApi";
import { PromptVersions } from "./PromptVersions";

afterEach(() => vi.unstubAllGlobals());

const v = (o: Partial<PromptVersion> = {}): PromptVersion => ({
  label: "Version v1", kind: "tagged", first_seen: "2026-11-01T00:00:00Z", last_seen: "2026-11-10T00:00:00Z", calls: 100,
  typical_tokens_in: 1000, typical_tokens_out: 100, cache_read_share: 0.4, priced_calls: 100, unpriced_calls: 0, cost_per_call: 0.01,
  checked: 80, correct_rate: 0.9, rate_low: 0.81, rate_high: 0.95, start_preview: null, ...o,
});
const data = (o: Partial<Data> = {}): Data => ({ job: "t", days: 30, source: "tagged", reason: null, versions: [v(), v({ label: "Version v2" })], comparison: null, ...o });
const show = (d: Data) => {
  stubApi({ "/v1/insights/prompt-versions": d });
  renderWithProviders(<PromptVersions job="t" />);
};

describe("PromptVersions", () => {
  it("shows tagged versions, the side-by-side note, the summary and the caveat", async () => {
    show(data({ comparison: { older: "Version v1", newer: "Version v2", side_by_side: true, summary: "Version v2 sends about 32% fewer input tokens than Version v1." } }));
    expect(await screen.findByText("Ran side by side")).toBeInTheDocument();
    expect(screen.getByText(/about 32% fewer input tokens/)).toBeInTheDocument();
    expect(screen.getByText(/This shows what changed, not why/)).toBeInTheDocument();
    expect(screen.getAllByText("Version v2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Detected")).toBeNull();
  });

  it("says when versions ran at different times", async () => {
    show(data({ comparison: { older: "a", newer: "b", side_by_side: false, summary: "x" } }));
    expect(await screen.findByText("Ran at different times, so other things may have changed")).toBeInTheDocument();
  });

  it("labels detected versions and shows no rate below the floor, and unpriced calls", async () => {
    show(data({
      source: "detected",
      versions: [v({ label: "Detected version 1", kind: "detected", checked: 10, correct_rate: null, rate_low: null, rate_high: null, start_preview: "You are a bot", unpriced_calls: 5 }), v({ label: "Detected version 2", kind: "detected" })],
    }));
    expect((await screen.findAllByText("Detected")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not enough checked answers yet/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/5 of 100 calls not priced/).length).toBeGreaterThan(0);
    expect(screen.getByText(/you did not tag versions/)).toBeInTheDocument();
  });

  it("explains when text was not kept", async () => {
    show(data({ source: "none", reason: "text_not_kept", versions: [] }));
    expect(await screen.findByText("Not available: the prompt text was not kept.")).toBeInTheDocument();
  });

  it("with nothing to compare, explains how to tag a version", async () => {
    show(data({ source: "none", reason: "no_change", versions: [] }));
    expect(await screen.findByText("Only one version so far.")).toBeInTheDocument();
    expect(screen.getByText(/record_ai_call\("your-task".*prompt_version="v2"\)/)).toBeInTheDocument();
  });
});
