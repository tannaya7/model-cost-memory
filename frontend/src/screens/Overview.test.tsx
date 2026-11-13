import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import type { Job, Recommendation } from "../shared/api/types";
import jobsSample from "../mocks/jobs.sample.json";
import recSample from "../mocks/recommendation.sample.json";
import { WithProject } from "../app/project";
import Overview from "./Overview";

afterEach(() => {
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
    const hero = await screen.findByRole("heading", { level: 1, name: /You could save/ });
    expect(hero).toHaveTextContent("a month");
    expect(screen.getByText(/One job can move to a cheaper model/)).toBeInTheDocument();
  });

  it("says every job is on the right model when nothing cheaper is proven", async () => {
    api({ "invoice-extract": hold("invoice-extract"), "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<Overview />);
    expect(await screen.findByRole("heading", { level: 1, name: /Every job is on the right model/ })).toBeInTheDocument();
  });

  it("lists each job with its verdict, linking to the job", async () => {
    api({ "invoice-extract": downgrade, "ticket-classify": hold("ticket-classify"), "receipt-scan": hold("receipt-scan") });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    const card = (await screen.findAllByRole("link", { name: /invoice-extract/ })).find((a) => a.getAttribute("href") === "/p/acme/jobs/invoice-extract");
    expect(card).toBeDefined();
    expect(within(card!).getByText("Cheaper model found")).toBeInTheDocument();
    expect(within(card!).getByText("$102/mo")).toBeInTheDocument();
  });
});
