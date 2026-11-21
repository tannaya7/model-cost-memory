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

const NONE: ProfileUsage = { ...usage, daysOfHistory: 0, runs: 0, monthlyTokensIn: 0, monthlyTokensOut: 0, monthlySpendUsd: 0, budgetUsd: null, currentModels: [] };

function setupWith(u: ProfileUsage, job: string | null = "invoice") {
  stubApi({ "/v1/models": { items: [row("claude-haiku-5-5", 0.1, 0.5), row("claude-opus-5-5", 4, 20)], next_cursor: null } });
  return renderWithProviders(<WithProject id="acme"><ProfileSuggestPanel job={job} usage={u} /></WithProject>);
}

const saved = (key = "mcm_profile_acme_invoice") => JSON.parse(localStorage.getItem(key)!);
const pressed = () => screen.queryAllByRole("button", { pressed: true });

describe("ProfileSuggestPanel", () => {
  it("asks the questions, prefilling the budget, then shows options with links and the disclaimer", async () => {
    setup();
    expect(screen.getByText("General information, not measured on your work")).toBeInTheDocument(); // nothing answered yet
    expect(screen.queryByText("Based on your answers, not on measured quality")).toBeNull();
    expect(screen.getByLabelText(/Monthly budget/)).toHaveValue("20");
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Classification or tagging"));
    await user.click(screen.getByRole("button", { name: "Lowest cost" }));
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));

    expect(await screen.findByText("claude-haiku-5-5")).toBeInTheDocument();
    expect(screen.getByText("Based on your answers, not on measured quality")).toBeInTheDocument();
    expect(screen.getByText("Fits your monthly budget")).toBeInTheDocument();
    expect(screen.getByText("Over your monthly budget")).toBeInTheDocument();
    const link = screen.getAllByRole("link", { name: /Read about it on Anthropic's site/ })[0];
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/14 Oct 2026 to 13 Nov 2026/)).toBeInTheDocument();
    expect(screen.getAllByText("Not tested on your work yet").length).toBeGreaterThan(0);
    expect(screen.getByText(/A suggestion from your own recent calls only/)).toBeInTheDocument();
    expect(screen.getByText(/Add a check to this AI task/)).toBeInTheDocument();
    expect(saved().priority).toBe("cost");

    await user.click(screen.getByRole("button", { name: "Edit answers" }));
    expect(screen.getByRole("button", { name: "Show models to read about" })).toBeInTheDocument();
  });

  it("goes straight to the options when answers are already saved", async () => {
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify({ tasks: [], priority: "cost", needs: [], budgetUsd: null }));
    setup();
    expect(await screen.findByText("claude-haiku-5-5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show models to read about" })).toBeNull();
  });
});

describe("the questions are optional and honest about what they do", () => {
  it("nothing is preselected, and it says the answers only organise the view and prove nothing about performance", () => {
    setup();
    expect(screen.getByTestId("why-we-ask")).toHaveTextContent("All optional. Your answers only help us pick which models to read about, and in what order. They do not show how any model performs on your work");
    expect(pressed()).toHaveLength(0);
    expect(screen.queryByText(/How many people/)).toBeNull(); // no team-size or employer question
    expect(screen.queryByLabelText(/company|employer|email|your name/i)).toBeNull();
  });

  it("a priority can be taken back", async () => {
    const user = userEvent.setup();
    setup();
    const speed = screen.getByRole("button", { name: "Speed" });
    await user.click(speed);
    expect(speed).toHaveAttribute("aria-pressed", "true");
    await user.click(speed);
    expect(speed).toHaveAttribute("aria-pressed", "false");
  });

  it("skipping saves a skip, shows only the general list, and offers the questions again", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(saved()).toEqual({ skipped: true });
    expect(await screen.findByText("General information, not measured on your work")).toBeInTheDocument();
    expect(screen.getByText(/A general list from what the providers publish; we have not tested these models on your work/)).toBeInTheDocument();
    expect(screen.queryByText(/You said/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Answer a few questions" }));
    expect(screen.getByRole("button", { name: "Show models to read about" })).toBeInTheDocument();
  });

  it("submitting with nothing chosen is a skip, never a stored answer", async () => {
    const user = userEvent.setup();
    setupWith({ ...usage, budgetUsd: null });
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));
    expect(saved()).toEqual({ skipped: true });
    expect(await screen.findByText("General information, not measured on your work")).toBeInTheDocument();
  });

  it("partial answers are used as given: only the priority chosen, the rest not answered", async () => {
    const user = userEvent.setup();
    setupWith({ ...usage, budgetUsd: null });
    await user.click(screen.getByRole("button", { name: "Lowest cost" }));
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));
    expect(saved()).toEqual({ tasks: [], priority: "cost", needs: [], budgetUsd: null });
    expect(await screen.findByText("Based on your answers, not on measured quality")).toBeInTheDocument();
    expect(screen.getAllByText(/You said lowest cost matters most/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/You said the work is/)).toBeNull();
  });

  it("changed answers replace the old ones and the list follows", async () => {
    const user = userEvent.setup();
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify({ tasks: [], priority: "cost", needs: [], budgetUsd: null }));
    setup();
    await user.click(await screen.findByRole("button", { name: "Edit answers" }));
    expect(screen.getByRole("button", { name: "Lowest cost" })).toHaveAttribute("aria-pressed", "true"); // what was saved is shown
    await user.click(screen.getByRole("button", { name: "Highest quality" }));
    await user.click(screen.getByLabelText("Images"));
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));
    expect(saved()).toMatchObject({ priority: "quality", needs: ["images"] });
    expect(await screen.findAllByText(/You said highest quality matters most/)).not.toHaveLength(0);
  });

  it("cancelling an edit changes nothing", async () => {
    const user = userEvent.setup();
    const before = { tasks: [], priority: "cost", needs: [], budgetUsd: null };
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify(before));
    setup();
    await user.click(await screen.findByRole("button", { name: "Edit answers" }));
    await user.click(screen.getByRole("button", { name: "Speed" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(saved()).toEqual(before);
  });

  it("clearing forgets the answers and asks again from the start", async () => {
    const user = userEvent.setup();
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify({ tasks: ["coding"], priority: "cost", needs: [], budgetUsd: 5 }));
    setup();
    await user.click(await screen.findByRole("button", { name: "Clear my answers" }));
    expect(localStorage.getItem("mcm_profile_acme_invoice")).toBeNull();
    expect(screen.getByRole("button", { name: "Show models to read about" })).toBeInTheDocument();
    expect(pressed()).toHaveLength(0);
  });

  it("answers given after a skip can be cleared too", async () => {
    const user = userEvent.setup();
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify({ skipped: true }));
    setup();
    await user.click(await screen.findByRole("button", { name: "Answer a few questions" }));
    await user.click(screen.getByRole("button", { name: "Lowest cost" }));
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));
    await user.click(await screen.findByRole("button", { name: "Clear my answers" }));
    expect(localStorage.getItem("mcm_profile_acme_invoice")).toBeNull();
  });
});

describe("with no measured history only general information is shown", () => {
  it("says there are no calls, and shows no cost, no budget verdict and no measured wording for any answers", async () => {
    const user = userEvent.setup();
    setupWith({ ...NONE, budgetUsd: 10 });
    expect(screen.getByTestId("no-history")).toHaveTextContent("You have no calls yet, so everything here is general");
    await user.click(screen.getByLabelText("Heavy coding"));
    await user.click(screen.getByRole("button", { name: "Highest quality" }));
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));
    await screen.findAllByText("Not tested on your work yet");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Fits your monthly budget|Over your monthly budget/);
    expect(text).not.toMatch(/measured on your|\bproven\b|cheapest proven|\d+(\.\d+)?% correct/i);
    expect(text).toMatch(/no usage with tokens is recorded yet, so no cost is estimated|Cost not estimated/i);
  });

  it("works before there is any AI task, with the answers kept for the project", async () => {
    const user = userEvent.setup();
    setupWith(NONE, null);
    await user.click(screen.getByRole("button", { name: "Speed" }));
    await user.click(screen.getByRole("button", { name: "Show models to read about" }));
    expect(saved("mcm_profile_acme").priority).toBe("speed");
    expect(await screen.findAllByText("Not tested on your work yet")).not.toHaveLength(0);
  });
});

describe("a workload choice is never shown as a measured result", () => {
  it.each([
    ["coding", "cost"], ["extraction", "quality"], ["support", "speed"], ["reasoning", "balanced"],
  ])("for %s with %s every option says it is untested and nothing claims a measured result", async (task, priority) => {
    localStorage.setItem("mcm_profile_acme_invoice", JSON.stringify({ tasks: [task], priority, needs: [], budgetUsd: null }));
    setup();
    await screen.findAllByText("Not tested on your work yet");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/we have not tested these models on your work/);
    expect(text).not.toMatch(/\bproven\b|recommended for you|best for your work|passes \d|\d+(\.\d+)?% (correct|of checked)/i);
  });
});

describe("SuggestionDisclaimer", () => {
  it("says it in plain words with readable dates", () => {
    renderWithProviders(<SuggestionDisclaimer from="2026-10-14" to="2026-11-13" />);
    expect(screen.getByText(/A suggestion from your own recent calls only\. It is not a benchmark\. Test it on your own examples before you switch\./)).toBeInTheDocument();
    expect(screen.getByText("Period used: 14 Oct 2026 to 13 Nov 2026.")).toBeInTheDocument();
  });
});
