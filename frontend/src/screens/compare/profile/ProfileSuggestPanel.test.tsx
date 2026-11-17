import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { stubApi } from "../../../test/api";
import { WithProject } from "../../../app/project";
import { ProfileSuggestPanel } from "./ProfileSuggestPanel";
import { SuggestionDisclaimer } from "./Disclaimer";
import type { ProfileUsage } from "./types";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const usage: ProfileUsage = { daysOfHistory: 30, runs: 3000, monthlyTokensIn: 6_000_000, monthlyTokensOut: 1_000_000, monthlySpendUsd: 30, budgetUsd: 20, currentModels: ["claude-sonnet-5-5"], periodFrom: "2026-10-14", periodTo: "2026-11-13" };
const row = (model: string, i: number, o: number) => ({ model, model_version: "", provider: "x", status: "ACTIVE", price_in_per_mtok: i, price_out_per_mtok: o, shutdown_date: null, source: "SYNC", first_seen_at: "2026-01-01T00:00:00Z" });

function setup() {
  stubApi({ "/v1/models": { items: [row("claude-haiku-5-5", 0.1, 0.5), row("claude-opus-5-5", 4, 20)], next_cursor: null } });
  return renderWithProviders(<WithProject id="acme"><ProfileSuggestPanel job="invoice" usage={usage} /></WithProject>);
}

describe("ProfileSuggestPanel", () => {
  it("asks the questions, prefilling the budget, then shows options with links and the disclaimer", async () => {
    setup();
    expect(screen.getByText("Based on your answers, not on measured quality")).toBeInTheDocument();
    expect(screen.getByLabelText(/Monthly budget/)).toHaveValue("20");
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Classification or tagging"));
    await user.click(screen.getByLabelText("Lowest cost"));
    await user.click(screen.getByRole("button", { name: "Show suggestions" }));

    expect(await screen.findByText("claude-haiku-5-5")).toBeInTheDocument();
    expect(screen.getByText("Fits your monthly budget")).toBeInTheDocument();
    expect(screen.getByText("Over your monthly budget")).toBeInTheDocument();
    const link = screen.getAllByRole("link", { name: /Read about it on Anthropic's site/ })[0];
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/14 Oct 2026 to 13 Nov 2026/)).toBeInTheDocument();
    expect(screen.getAllByText("Not tested on your work yet").length).toBeGreaterThan(0);
    expect(screen.getByText(/A suggestion from your own recent calls only/)).toBeInTheDocument();
    expect(screen.getByText(/Add a check to this AI task/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("mcm_profile_acme_invoice")!).priority).toBe("cost");

    await user.click(screen.getByRole("button", { name: "Edit answers" }));
    expect(screen.getByRole("button", { name: "Show suggestions" })).toBeInTheDocument();
  });

  it("goes straight to the options when answers are already saved", async () => {
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify({ people: "1", tasks: [], priority: "cost", needs: [], budgetUsd: null }));
    setup();
    expect(await screen.findByText("claude-haiku-5-5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show suggestions" })).toBeNull();
  });
});

describe("SuggestionDisclaimer", () => {
  it("says it in plain words with readable dates", () => {
    renderWithProviders(<SuggestionDisclaimer from="2026-10-14" to="2026-11-13" />);
    expect(screen.getByText(/A suggestion from your own recent calls only\. It is not a benchmark\. Test it on your own examples before you switch\./)).toBeInTheDocument();
    expect(screen.getByText("Period used: 14 Oct 2026 to 13 Nov 2026.")).toBeInTheDocument();
  });
});
