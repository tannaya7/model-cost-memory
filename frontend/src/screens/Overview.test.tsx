import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import type { Job, Recommendation } from "../shared/api/types";
import jobsSample from "../mocks/jobs.sample.json";
import recSample from "../mocks/recommendation.sample.json";
import { WithProject } from "../app/project";
import Overview from "./Overview";
import { DEFAULT_LAYOUT } from "./overview/layout";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const jobs = jobsSample as unknown as Job[];
const downgrade = {
  ...(recSample as unknown as Recommendation),
  forecast: { runs_per_month: 3640, monthly_saving_usd: 101.6, extra_failures_per_month: 10.9, extra_failures_low: 1.8, extra_failures_high: 21.4 },
};
const hold = (job: string): Recommendation => ({ ...downgrade, job, verdict: "HOLD", recommended: downgrade.current, forecast: null });

function api(recs: Record<string, Recommendation>) {
  return stubApi({
    "/v1/jobs/invoice-extract/recommendation": recs["invoice-extract"],
    "/v1/jobs/ticket-classify/recommendation": recs["ticket-classify"],
    "/v1/jobs/receipt-scan/recommendation": recs["receipt-scan"],
    "/v1/jobs": jobs,
    "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
  });
}

describe("Overview", () => {
  it("leads with the money a cheaper model would save", async () => {
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<Overview />);
    // A big page: role-name lookups are slow in jsdom under load, so wait longer than the 1 s default.
    const hero = await screen.findByRole("heading", { level: 3, name: /You could save/ }, { timeout: 15_000 });
    expect(hero).toHaveTextContent("a month");
    expect(screen.getByText(/can move to a cheaper model\. Nothing changes unless you decide/)).toBeInTheDocument();
  });

  it("says every job is on the right model when nothing cheaper is proven", async () => {
    api({ "invoice-extract": hold("invoice-extract"), "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<Overview />);
    expect(await screen.findByRole("heading", { level: 3, name: /Every AI task is on the right model/ })).toBeInTheDocument();
  });

  it("lists each job with its verdict, linking to the job", async () => {
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    const link = (await screen.findAllByRole("link", { name: "Invoice extract" })).find((a) => a.getAttribute("href") === "/p/acme/jobs/invoice-extract");
    expect(link).toBeDefined();
    const row = link!.closest("tr")!;
    expect(await within(row).findByText("Cheaper model found")).toBeInTheDocument();
  });

  it("asks for twice the period, so the one before can be compared", async () => {
    const calls = api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    await vi.waitFor(() => expect(calls).toContain("GET /v1/insights/daily?days=60"));
  });

  it("keeps the widgets a person added, and takes one away when removed", async () => {
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    await user.click(await screen.findByRole("button", { name: "Add widget" }));
    const drawer = await screen.findByRole("dialog", { name: "Add widget" });
    const card = within(drawer).getByText("Spend per day by AI task").closest("li")!;
    await user.click(within(card).getByRole("button", { name: "Add" }));
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).toContain("spend-by-job");
    await user.click(within(drawer).getAllByRole("button", { name: "Remove" })[0]);
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).not.toContain("spend-month");
    // Removing is applied at once, says so politely (no focus taken) and can be undone.
    const toast = (await screen.findByText(/^Removed "Spend"$/)).closest("[role=status]")!;
    expect(toast.contains(document.activeElement)).toBe(false);
    await user.click(within(toast as HTMLElement).getByRole("button", { name: "Undo" }));
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).toContain("spend-month");
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).toContain("spend-by-job");
  });

  it("starts with exactly seven widgets, and the others are still there to add", async () => {
    expect(DEFAULT_LAYOUT).toEqual(["spend-month", "spend-split", "wasted-spend", "correct", "attention", "next-step", "jobs-table"]);
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    for (const name of ["What am I spending?", "Are my answers still good?", "What should I do next?"]) {
      expect(await screen.findByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: /Token usage|Where your tokens went|What is using your tokens|Busiest day|What 1,000 correct answers cost/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add widget" }));
    const drawer = await screen.findByRole("dialog", { name: "Add widget" });
    for (const moved of ["What 1,000 correct answers cost you", "Token usage", "Where your tokens went", "What is using your tokens", "Busiest day", "How it works", "In the news", "Spend per day by AI task"]) {
      expect(within(within(drawer).getByText(moved).closest("li")!).getByRole("button", { name: "Add" })).toBeInTheDocument();
    }
    // the cards that were merged into the new ones are not offered again
    expect(within(drawer).queryByText("Key numbers")).toBeNull();
  });

  it("leaves a layout someone already saved exactly as it is", async () => {
    localStorage.setItem("mcm_layout_acme", JSON.stringify(["kpis", "savings", "jobs-table"]));
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    expect(await screen.findByRole("heading", { level: 2, name: /You could save/ }, { timeout: 15_000 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What am I spending?" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).toEqual(["kpis", "savings", "jobs-table"]);
  });

  it("never shows a blank page when a saved layout holds only widgets that no longer exist", async () => {
    localStorage.setItem("mcm_layout_acme", JSON.stringify(["gone-widget"]));
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    expect(await screen.findByRole("heading", { level: 2, name: "What am I spending?" })).toBeInTheDocument();
  });

  it("shows the three money widgets and offers to set a monthly limit", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const point = (n: number, spend: number, failed: number) => ({ day: day(n), job: "invoice-extract", model: "acme-large", runs: 10, passed: 10 - failed, failed, spend_usd: spend });
    stubApi({
      "/v1/jobs/invoice-extract/recommendation": downgrade,
      "/v1/jobs/ticket-classify/recommendation": hold("ticket-classify"),
      "/v1/jobs/receipt-scan/recommendation": hold("receipt-scan"),
      "/v1/jobs": jobs,
      "/v1/insights/daily": Array.from({ length: 10 }, (_, i) => point(i + 1, 2, i % 3)),
      "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
    });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    expect(await screen.findByRole("heading", { name: /^Spend, last 30 days/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Money spent on wrong answers/ })).toBeInTheDocument();
    expect(await screen.findByText(/answers that were checked and found wrong/)).toBeInTheDocument();
    // honesty: the month-end figure says it is an estimate and gives a range
    expect(await screen.findByText("estimate")).toBeInTheDocument();
    expect(screen.getByText(/likely \$.* to \$/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Set a monthly limit" }));
    expect(await screen.findByLabelText("Monthly spending limit in US dollars")).toBeInTheDocument();
    expect(screen.getByText("The limit only warns, it never blocks.")).toBeInTheDocument();
  });
});
