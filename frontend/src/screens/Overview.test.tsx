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
    const hero = await screen.findByRole("heading", { level: 2, name: /You could save/ });
    expect(hero).toHaveTextContent("a month");
    expect(screen.getByText(/can move to a cheaper model that gives just as many correct answers/)).toBeInTheDocument();
  });

  it("says every job is on the right model when nothing cheaper is proven", async () => {
    api({ "invoice-extract": hold("invoice-extract"), "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<Overview />);
    expect(await screen.findByRole("heading", { level: 2, name: /Every AI task is on the right model/ })).toBeInTheDocument();
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
    expect(within(drawer).getByText("Spend per day by AI task")).toBeInTheDocument();
    await user.click(within(drawer).getAllByRole("button", { name: "Add" })[0]);
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).toContain("spend-by-job");
    await user.click(within(drawer).getAllByRole("button", { name: "Remove" })[0]);
    expect(JSON.parse(localStorage.getItem("mcm_layout_acme")!)).not.toContain("kpis");
  });

  it("shows the three money widgets and keeps a budget the person sets", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const point = (n: number, spend: number, failed: number) => ({ day: day(n), job: "invoice-extract", model: "acme-large", runs: 10, passed: 10 - failed, failed, spend_usd: spend });
    stubApi({
      "/v1/jobs/invoice-extract/recommendation": downgrade,
      "/v1/jobs/ticket-classify/recommendation": hold("ticket-classify"),
      "/v1/jobs/receipt-scan/recommendation": hold("receipt-scan"),
      "/v1/jobs": jobs,
      "/v1/insights/daily": [point(1, 2, 1), point(2, 2, 2), point(3, 2, 0)],
      "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
    });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    expect(await screen.findByRole("heading", { name: "Where this month's spending is heading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Money spent on wrong answers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What 1,000 correct answers cost you" })).toBeInTheDocument();
    expect(await screen.findByText(/answers that were checked and found wrong/)).toBeInTheDocument();

    await user.type(await screen.findByLabelText("Set a monthly budget"), "500");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(localStorage.getItem("mcm_budget_acme")).toBe("500");
    expect(await screen.findByText(/Budget \$500 a month/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(localStorage.getItem("mcm_budget_acme")).toBeNull();
  });
});
