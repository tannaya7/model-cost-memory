/** How each screen speaks for each way of paying: per use, a flat subscription, or both. The server's money wording,
 * the CSV, the section headings and the plan-meter line must follow the mode, and nothing here may invent a plan meter. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { WithProject } from "../app/project";
import type { Job, Recommendation } from "../shared/api/types";
import jobsSample from "../mocks/jobs.sample.json";
import recSample from "../mocks/recommendation.sample.json";
import modelsSample from "../mocks/models.sample.json";
import Overview from "./Overview";
import Settings from "./Settings";
import Compare from "./compare/Compare";
import { sectionTitle } from "./overview/layout";

vi.mock("./compare/profile/ProfileSuggestPanel", () => ({ ProfileSuggestPanel: () => <div>profile panel</div> }));
vi.mock("./compare/profile/Disclaimer", () => ({ SuggestionDisclaimer: () => <p>disclaimer</p> }));
vi.mock("./compare/profile/modelLinks", () => ({ modelLink: () => ({ url: "https://example.com/m", label: "Read" }) }));

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const SLOW = 15_000;
const jobs = jobsSample as unknown as Job[];
const rec = recSample as unknown as Recommendation;
const today = new Date().toISOString().slice(0, 10);
const day = () => ({ day: today, job: "invoice-extract", model: "m", runs: 40, passed: 30, failed: 8, spend_usd: 12.5, tokens_in: 90_000, tokens_out: 10_000, cache_read_tokens: 0, cache_write_tokens: 0, unpriced_runs: 0, failed_spend_usd: 1 });

const projectBody = (billing: string) => ({
  project_id: "acme", name: "Acme", billing_mode: billing, content_retention_days: 90, store_tool_arguments: false, webhook_url: null,
  retest_allowed: true, retest_monthly_cap_usd: 10, monthly_budget_usd: null,
});

function api(billing: string) {
  stubApi({
    "/v1/projects/acme": projectBody(billing),
    "/v1/jobs/invoice-extract/recommendation": rec,
    "/v1/jobs/ticket-classify/recommendation": { ...rec, job: "ticket-classify", verdict: "HOLD", recommended: rec.current, forecast: null },
    "/v1/jobs/receipt-scan/recommendation": { ...rec, job: "receipt-scan", verdict: "HOLD", recommended: rec.current, forecast: null },
    "/v1/jobs": jobs,
    "/v1/models": modelsSample,
    "/v1/insights/daily": [day()],
    "/v1/insights/prompts": { days: 30, total_tokens: 85_000, groups: [{ job: "invoice-extract", prompt_version: null, calls: 40, tokens_in: 80_000, tokens_out: 5_000, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 85_000, share: 0.8, avg_tokens_in: 2000, avg_tokens_out: 125, cache_read_share: 0, text_samples: 20, repeated_start_share: 0.6, repeated_end_share: 0, repeated_start_preview: "You are" }] },
    "/v1/insights/agents": { agents: [], traces: [], tools: [], kinds: { calls: 40, uses_tools: false } },
    "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
  });
}

const mountOverview = () => renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);

describe("section heading follows how you pay", () => {
  it("is a plain function of the mode", () => {
    expect(sectionTitle("spend", "per_use")).toBe("What am I spending?");
    expect(sectionTitle("spend", "subscription")).toBe("What am I using?");
    expect(sectionTitle("spend", "both")).toBe("What am I using and spending?");
    expect(sectionTitle("quality", "subscription")).toBe("Are my answers still good?"); // other headings do not change
  });

  it.each([
    ["per_use", "What am I spending?"],
    ["subscription", "What am I using?"],
    ["both", "What am I using and spending?"],
  ])("%s: the Overview says %j", async (mode, heading) => {
    api(mode);
    mountOverview();
    expect(await screen.findByRole("heading", { level: 2, name: heading }, { timeout: SLOW })).toBeInTheDocument();
    if (mode === "subscription") expect(screen.queryByText("What am I spending?")).toBeNull();
  });
});

describe("the plan's own meter is shown as unavailable, never guessed", () => {
  const NOT_AVAILABLE = /Your plan's remaining allowance and reset time: not available\./;

  it("subscription says it is not available and names what is never guessed", async () => {
    api("subscription");
    mountOverview();
    const note = await screen.findByTestId("plan-meter", {}, { timeout: SLOW });
    expect(note).toHaveTextContent(NOT_AVAILABLE);
    expect(note).toHaveTextContent("No provider reports them to this app, so we do not guess them, or whether unused usage carries over");
    expect(note).toHaveTextContent("a cap and a reset time you enter yourself");
    expect(note.textContent).not.toMatch(/\d+\s?%|\bresets in\b|\bunits?\b/); // no invented meter reading
  });

  it("both shows it too, beside the allowance ideas", async () => {
    api("both");
    mountOverview();
    expect(await screen.findByTestId("plan-meter", {}, { timeout: SLOW })).toHaveTextContent(NOT_AVAILABLE);
  });

  it("per use has no plan meter line at all", async () => {
    api("per_use");
    mountOverview();
    await screen.findByRole("heading", { level: 2, name: "What am I spending?" }, { timeout: SLOW });
    expect(screen.queryByTestId("plan-meter")).toBeNull();
    expect(screen.queryByText(/allowance/i)).toBeNull();
  });

  it("the usage limits box says the cap is entered by the person and that the plan's meter is not visible", async () => {
    api("subscription");
    renderWithProviders(<WithProject id="acme"><Settings /></WithProject>);
    expect(await screen.findByText(/You enter the cap and when it resets\. We count the calls recorded here against it and warn you before you reach it\. We cannot see your plan's own meter\./)).toBeInTheDocument();
  });
});

describe("the Export button says how the figures are worked out", () => {
  it("the Export button says the figures are list prices when you do not pay per use", async () => {
    api("subscription");
    mountOverview();
    const button = await screen.findByRole("button", { name: /Export/ }, { timeout: SLOW });
    // the title changes once the daily figures arrive (before that there is nothing to download)
    await waitFor(() => expect(button).toHaveAttribute("title", expect.stringContaining("Dollar figures are list prices, not a bill")), { timeout: SLOW });
  });

  it("per use has no such caveat on the button", async () => {
    api("per_use");
    mountOverview();
    const button = await screen.findByRole("button", { name: /Export/ }, { timeout: SLOW });
    await waitFor(() => expect(button.getAttribute("title")).toContain("Download the last 30 days"), { timeout: SLOW });
    expect(button.getAttribute("title")).not.toContain("list prices");
  });
});

describe("Compare plans against a dollar budget only when you pay per use", () => {
  const compare = async (mode: string) => {
    api(mode);
    renderWithProviders(<WithProject id="acme"><Compare /></WithProject>);
    await screen.findByText(/Based on 1 day of use|Based on \d+ days? of use/, {}, { timeout: SLOW });
  };

  it("per use shows the monthly budget box", async () => {
    await compare("per_use");
    expect(screen.getByText("Monthly budget (US dollars)")).toBeInTheDocument();
  });

  it("both shows it too (the per-use part still has a bill)", async () => {
    await compare("both");
    expect(screen.getByText("Monthly budget (US dollars)")).toBeInTheDocument();
  });

  it("a subscription has no dollar budget to plan against", async () => {
    await compare("subscription");
    expect(screen.queryByText("Monthly budget (US dollars)")).toBeNull();
    expect(screen.queryByText(/monthly budget/i)).toBeNull();
  });
});
