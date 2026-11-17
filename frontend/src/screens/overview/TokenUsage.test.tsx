import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import type { DayPoint } from "../../shared/api/types";
import { TokensTab } from "../job/TokensTab";
import { TokenUsage } from "./TokenUsage";
import type { Ctx, ShellProps } from "./widgets";
import type { TokenPoint } from "./tokenMetrics";

afterEach(() => vi.unstubAllGlobals());

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const point = (offset: number, job: string, o: Partial<TokenPoint>): TokenPoint => ({ day: day(offset), job, model: "m", runs: 10, passed: 10, failed: 0, spend_usd: 1, ...o });
const points: TokenPoint[] = [
  point(1, "invoice-extract", { tokens_in: 30_000, tokens_out: 1000 }),
  point(2, "ticket-classify", { tokens_in: 5000, tokens_out: 2000, cache_read_tokens: 1000 }),
  point(9, "invoice-extract", { tokens_in: 10_000, tokens_out: 1000 }),
];
const shell = { id: "kpis", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
const ctx = (pts: TokenPoint[], over: Partial<Ctx> = {}): Ctx => {
  const cutoff = day(6);
  return { days: 7, points: pts as DayPoint[], cur: pts.filter((p) => p.day >= cutoff) as DayPoint[], prev: pts.filter((p) => p.day < cutoff) as DayPoint[], dailyPending: false, jobs: [], jobsPending: false, byJob: new Map(), recsPending: false, ...over };
};

describe("TokenUsage", () => {
  it("shows the total, cache share, top consumers and a token limit's risk", async () => {
    stubApi({ "/v1/limits": [{ limit_id: "1", name: "weekly", measure: "TOKENS", used: 40_000, size: 100_000, hours_to_full: 9, hours_to_reset: 100, state: "AT_RISK", share_used: 0.4, rate_per_hour: 1, resets_at: "2026-12-01T00:00:00Z", model: null, message: "", hours_to_full_after: null, lasts_after: null }] });
    renderWithProviders(<TokenUsage ctx={ctx(points)} shell={shell} />);
    expect(await screen.findByText(/the weekly limit is full in 9 h/)).toHaveTextContent(/caused \d+% of the tokens/);
    expect(screen.getByText("invoice-extract")).toBeInTheDocument();
    expect(screen.getByText(/Limits and rates are estimates/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /Show table/ }));
    expect(screen.getByRole("table")).toHaveTextContent("Cached");
  });

  it("says so when no token counts were recorded", () => {
    stubApi({ "/v1/limits": [] });
    renderWithProviders(<TokenUsage ctx={ctx([point(1, "a", {})])} shell={shell} />);
    expect(screen.getByText("No token counts yet")).toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    stubApi({ "/v1/limits": [] });
    const { container } = renderWithProviders(<TokenUsage ctx={ctx([], { dailyPending: true })} shell={shell} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("TokensTab", () => {
  it("lists optimisation hints with their numbers", async () => {
    stubApi({ "/v1/insights/daily": points });
    renderWithProviders(<TokensTab job="invoice-extract" />);
    expect(await screen.findByText("Ways to use fewer tokens")).toBeInTheDocument();
    expect(screen.getByText("Prompt caching may help")).toBeInTheDocument();
  });
});
