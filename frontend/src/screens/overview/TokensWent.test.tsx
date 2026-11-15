import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import type { PromptGroup } from "../../features/insights/api/promptsApi";
import { TokensWent, anatomy } from "./TokensWent";
import { TokensTab } from "../job/TokensTab";
import type { Ctx, ShellProps } from "./widgets";

afterEach(() => vi.unstubAllGlobals());

const shell = { id: "tokens-went", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
const ctx = { days: 30 } as unknown as Ctx;
const g = (o: Partial<PromptGroup> = {}): PromptGroup => ({
  job: "invoice-extract", prompt_version: "v3", calls: 120, tokens_in: 240000, tokens_out: 12000, cache_read_tokens: 0, cache_write_tokens: 0,
  total_tokens: 252000, share: 0.62, avg_tokens_in: 2000, avg_tokens_out: 100, cache_read_share: null, text_samples: 20,
  repeated_start_share: 0.6, repeated_end_share: 0.1, repeated_start_preview: "You are a careful invoice reader", ...o,
});
const reply = (groups: PromptGroup[], total = 400000) => ({ days: 30, total_tokens: total, groups });

describe("TokensWent", () => {
  it("shows the group, anatomy, preview and tips", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText("62% of your tokens")).toBeInTheDocument();
    expect(screen.getByText("version v3")).toBeInTheDocument();
    expect(screen.getByText(/120 calls/)).toHaveTextContent("2,000 tokens in and 100 out");
    expect(screen.getByRole("img")).toHaveAccessibleName("60% same every time at the start, 30% changes each call, 10% same every time at the end");
    expect(screen.getByText(/Every call starts: "You are a careful invoice reader"/)).toBeInTheDocument();
    expect(screen.getByText("Estimated from your last 20 calls.")).toBeInTheDocument();
    expect(screen.getByText("Ideas, not promises")).toBeInTheDocument();
    expect(screen.getByText(/60% of this prompt is the same in every call/)).toBeInTheDocument();
    expect(screen.getByText(/You send a lot to get a little back/)).toBeInTheDocument();
  });

  it("explains an empty project", async () => {
    stubApi({ "/v1/insights/prompts": reply([], 0) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText("No AI calls yet")).toBeInTheDocument();
  });

  it("says the text was removed but still shows counts", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ text_samples: 0, repeated_start_share: null, repeated_end_share: null, repeated_start_preview: null })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText(/removed after your retention period, so we can only show the counts/)).toBeInTheDocument();
    expect(screen.getByText("62% of your tokens")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("needs at least 5 stored calls for the split", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ text_samples: 3 })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText(/We need at least 5 stored calls to show the split/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows a skeleton while loading", () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    const { container } = renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("shows an error with a retry", async () => {
    stubApi({ "/v1/insights/prompts": new Response("{}", { status: 500 }) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("computes the anatomy shares", () => {
    expect(anatomy(g({ repeated_start_share: 0.5, repeated_end_share: 0.2 }))).toEqual({ start: 0.5, changes: expect.closeTo(0.3), end: 0.2 });
    expect(anatomy(g({ text_samples: 4 }))).toBeNull();
  });
});

describe("TokensTab prompts section", () => {
  it("shows this task's prompts", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]), "/v1/insights/daily": [{ day: new Date().toISOString().slice(0, 10), job: "invoice-extract", model: "m", runs: 5, passed: 5, failed: 0, spend_usd: 1, tokens_in: 5000, tokens_out: 500 }] });
    renderWithProviders(<TokensTab job="invoice-extract" />);
    expect(await screen.findByText("62% of your tokens")).toBeInTheDocument();
  });
});
