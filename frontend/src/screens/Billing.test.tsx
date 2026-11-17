import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { WithProject } from "../app/project";
import type { Job, Project, Recommendation } from "../shared/api/types";
import jobsSample from "../mocks/jobs.sample.json";
import recSample from "../mocks/recommendation.sample.json";
import { useBillingMode } from "../features/projects/hooks/useBillingMode";
import { allowanceWays, SMALLER_MODEL_TEXT } from "./overview/allowanceWays";
import type { PromptGroup } from "../features/insights/api/promptsApi";
import type { DayPoint } from "./overview/metrics";
import { AlertItemCard } from "../features/alerts/components/AlertItemCard";
import type { Alert } from "../shared/api/types";
import { MONEY_ALERT_FALLBACK } from "../features/projects/moneyWording";
import Overview from "./Overview";
import Settings, { BillingSection } from "./Settings";
import NewProject from "./NewProject";
import { payModeChange } from "../features/projects/payModeChange";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const jobs = jobsSample as unknown as Job[];
const downgrade = {
  ...(recSample as unknown as Recommendation),
  forecast: { runs_per_month: 3640, monthly_saving_usd: 101.6, extra_failures_per_month: 10.9, extra_failures_low: 1.8, extra_failures_high: 21.4 },
};
const hold = (job: string): Recommendation => ({ ...downgrade, job, verdict: "HOLD", recommended: downgrade.current, forecast: null });
const today = new Date().toISOString().slice(0, 10);
const day = (over: Partial<DayPoint> = {}) => ({ day: today, job: "invoice-extract", model: "m", runs: 40, passed: 30, failed: 8, spend_usd: 12.5, tokens_in: 90_000, tokens_out: 10_000, cache_read_tokens: 0, cache_write_tokens: 0, ...over });
const group = (over: Partial<PromptGroup> = {}): PromptGroup => ({
  job: "invoice-extract", prompt_version: null, calls: 40, tokens_in: 80_000, tokens_out: 5_000, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 85_000, share: 0.8,
  avg_tokens_in: 2000, avg_tokens_out: 125, cache_read_share: 0, text_samples: 20, repeated_start_share: 0.6, repeated_end_share: 0, repeated_start_preview: "You are", ...over,
});

function overviewApi(billing: string | null) {
  return stubApi({
    "/v1/projects/acme": { project_id: "acme", name: "Acme", billing_mode: billing },
    "/v1/jobs/invoice-extract/recommendation": downgrade,
    "/v1/jobs/ticket-classify/recommendation": hold("ticket-classify"),
    "/v1/jobs/receipt-scan/recommendation": hold("receipt-scan"),
    "/v1/jobs": jobs,
    "/v1/insights/daily": [day()],
    "/v1/insights/prompts": { days: 30, total_tokens: 85_000, groups: [group()] },
    "/v1/insights/agents": { agents: [], traces: [], tools: [{ job: "invoice-extract", avg_tools_tokens: 12_000, runs: 40, share_of_tokens_in: 0.2 }], kinds: { calls: 40, uses_tools: true, works_like_agent: null, tool_source: null, tool_servers: [], multi_agent: false } },
    "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
  });
}
const mountOverview = () => renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);

describe("allowanceWays (measured facts only)", () => {
  it("builds ways from shares and token counts, never dollars", () => {
    const ways = allowanceWays({
      groups: [group()],
      agents: { tools: [{ job: "invoice-extract", avg_tools_tokens: 12_000, runs: 40, share_of_tokens_in: 0.2 }], traces: [] },
      cur: [day() as DayPoint],
      cheaperTasks: 2,
    });
    expect(ways.map((w) => w.id.split(":")[0])).toEqual(["start", "tools", "failed", "smaller-model"]);
    const text = ways.map((w) => `${w.title} ${w.text}`).join("\n");
    expect(text).toMatch(/60% of this prompt \(about 1,200 tokens per call\)/);
    expect(text).toMatch(/about 12K tokens to every call/);
    expect(text).not.toMatch(/\$/);
    const smaller = ways.at(-1)!;
    expect(smaller.text).toBe(SMALLER_MODEL_TEXT);
    expect(smaller.text).not.toMatch(/\d/);
    expect(smaller.measured).toBe(false);
  });

  it("says nothing when the facts are thin", () => {
    expect(allowanceWays({ groups: [group({ text_samples: 2 })], agents: null, cur: [day({ failed: 1 }) as DayPoint], cheaperTasks: 0 })).toEqual([]);
  });
});

// A big page: role-name lookups are slow in jsdom under load, so wait longer than the 1 s default.
const SLOW = 15_000;

describe("Overview by billing mode", () => {
  it("per use: Spend, the saving banner and no subscription wording", async () => {
    overviewApi("per_use");
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: /You could save/ }, { timeout: SLOW })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /^Spend, last 30 days/ })).toBeInTheDocument();
    expect(screen.queryByText(/allowance/i)).toBeNull();
    expect(screen.queryByText(/not your bill/)).toBeNull();
  });

  it("the spend split is titled by what it shows: money for per use, usage for a subscription", async () => {
    overviewApi("per_use");
    const first = mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: "Where the money goes" }, { timeout: SLOW })).toBeInTheDocument();
    first.unmount();
    overviewApi("subscription");
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: "Where your usage goes" }, { timeout: SLOW })).toBeInTheDocument();
    expect(screen.queryByText("Where the money goes")).toBeNull();
  });

  it("both: the split title follows the Measure toggle", async () => {
    overviewApi("both");
    const user = userEvent.setup();
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: "Where the money goes" }, { timeout: SLOW })).toBeInTheDocument();
    const header = screen.getByRole("heading", { level: 3, name: "Where the money goes" }).closest("header")!;
    await user.click(within(header).getByRole("tab", { name: "AI calls" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Where your usage goes" }, { timeout: SLOW })).toBeInTheDocument();
  });

  it("an older project with no billing mode is treated as per use", async () => {
    overviewApi(null);
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: /You could save/ }, { timeout: SLOW })).toBeInTheDocument();
  });

  it("subscription: usage and ways to make the allowance last, no saved money", async () => {
    overviewApi("subscription");
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: /Ways to make your allowance last longer/ }, { timeout: SLOW })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /^Usage, last 30 days/ })).toBeInTheDocument();
    expect(await screen.findByText(/List price \$12\.50, not your bill/)).toBeInTheDocument();
    expect((await screen.findAllByText(/60% of this prompt/)).length).toBeGreaterThan(0);
    // the top two ideas show first; the rest are one click away
    await userEvent.setup().click(await screen.findByRole("button", { name: /Show \d+ more idea/ }));
    expect(screen.getByText(/A smaller model may use less of your allowance\. We cannot say how much/)).toBeInTheDocument();
    for (const gone of [/Saving available/, /You could save/, /Saved per month/, /^Spend$/, /Money spent on wrong answers/, /spending is heading/]) {
      // widgets that leave on a billing change stay on screen for their short exit animation, so wait for them to go
      await waitFor(() => expect(screen.queryByText(gone)).toBeNull());
    }
  });

  it("both: shows each view, labelled, with the honest line", async () => {
    overviewApi("both");
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: /You could save/ }, { timeout: SLOW })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 3, name: /Ways to make your allowance last longer/ }, { timeout: SLOW })).toBeInTheDocument();
    expect(screen.getByText("If you pay per use")).toBeInTheDocument();
    expect(screen.getByText("If you pay a subscription")).toBeInTheDocument();
    // said once, in the page header, not repeated on cards
    expect(screen.getAllByText("We cannot tell which calls were paid which way, so we show both.")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3, name: /^Usage, last 30 days/ })).toBeInTheDocument();
  });

  it("thin data on a subscription gets a plain explanation, not a blank card", async () => {
    stubApi({
      "/v1/projects/acme": { project_id: "acme", name: "Acme", billing_mode: "subscription" },
      "/v1/jobs/invoice-extract/recommendation": hold("invoice-extract"),
      "/v1/jobs/ticket-classify/recommendation": hold("ticket-classify"),
      "/v1/jobs/receipt-scan/recommendation": hold("receipt-scan"),
      "/v1/jobs": jobs,
      "/v1/insights/daily": [day({ runs: 3, passed: 1, failed: 0 })],
      "/v1/insights/prompts": { days: 30, total_tokens: 0, groups: [] },
      "/v1/insights/agents": { agents: [], traces: [], tools: [], kinds: { calls: 0, uses_tools: false, works_like_agent: null, tool_source: null, tool_servers: [], multi_agent: false } },
      "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
    });
    mountOverview();
    expect(await screen.findByRole("heading", { level: 3, name: /Ways to make your allowance last longer/ }, { timeout: SLOW })).toBeInTheDocument();
    expect(await screen.findByText(/Next step: keep using your app/)).toBeInTheDocument();
  });
});

function HookProbe() {
  const { mode, canEdit } = useBillingMode();
  return <p>{mode}|{String(canEdit)}</p>;
}

describe("useBillingMode", () => {
  it("reads the owned project's mode", async () => {
    stubApi({ "/v1/projects/acme": { project_id: "acme", billing_mode: "both" } });
    renderWithProviders(<WithProject id="acme"><HookProbe /></WithProject>);
    expect(await screen.findByText("both|true")).toBeInTheDocument();
  });
  it("is per use without an owned project", () => {
    stubApi({});
    renderWithProviders(<WithProject id="demo"><HookProbe /></WithProject>);
    expect(screen.getByText("per_use|false")).toBeInTheDocument();
  });
});

function account(mode: string) {
  const project = { project_id: "acme", name: "Acme", content_retention_days: 90, store_tool_arguments: false, billing_mode: mode, webhook_url: null, retest_allowed: true, retest_monthly_cap_usd: 10, monthly_budget_usd: 50, key_prefix: "mcm_x" } as unknown as Project;
  const calls: { method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/v1/projects/acme")) {
      if (method === "PATCH") Object.assign(project, JSON.parse(String(init?.body)));
      return json({ ...project });
    }
    return json([]);
  }));
  return { project, calls };
}

describe("Settings: how you pay for AI", () => {
  it("shows the three choices with an example each and saves only that field", async () => {
    const { project, calls } = account("per_use");
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><BillingSection project={project} /></WithProject>);
    expect(screen.getByRole("radio", { name: /Pay per use/ })).toBeChecked();
    expect(screen.getByText("Each call costs money, for example the Claude, OpenAI or Gemini API.")).toBeInTheDocument();
    expect(screen.getByText(/Claude Pro or Max, ChatGPT Plus, Copilot, Cursor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About how you pay for AI" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Monthly subscription/ }));
    // a review panel, no request yet
    expect(screen.getByText(/Switching to Monthly subscription turns off dollar limits and projected-over alerts\. Screens will show allowance windows instead\. Spend figures are still estimates from recorded calls at list prices, not your bill\. Your saved limit of \$50 is kept and returns if you switch back\./)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Switch to Monthly subscription" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ billing_mode: "subscription" }]));
    expect((await screen.findByText("Pay mode changed to Monthly subscription")).closest("[role=status]")).not.toBeNull();
  });

  it("Keep Pay per use drops the draft and sends nothing", async () => {
    const { project, calls } = account("per_use");
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><BillingSection project={project} /></WithProject>);
    await user.click(screen.getByRole("radio", { name: /Both/ }));
    await user.click(screen.getByRole("button", { name: "Keep Pay per use" }));
    expect(screen.getByRole("radio", { name: /Pay per use/ })).toBeChecked();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("says what really changes for each move", () => {
    expect(payModeChange("per_use", "both", 50)).toMatch(/keeps dollar figures but labels them as list prices rather than your bill, and also shows your allowance.*Your limit warnings stay on\./);
    expect(payModeChange("subscription", "per_use", 50)).toMatch(/turns dollar figures, the spending limit and projected-over alerts back on.*Your saved limit of \$50 starts warning again\./);
    expect(payModeChange("subscription", "both", null)).not.toMatch(/saved limit/);
    expect(payModeChange("both", "per_use", null)).toMatch(/shows dollar figures as what you pay/);
    expect(payModeChange("both", "subscription", null)).toMatch(/^Switching to Monthly subscription turns off dollar limits/);
  });

  it("per use keeps the spending limit box", async () => {
    account("per_use");
    renderWithProviders(<WithProject id="acme"><Settings /></WithProject>);
    expect(await screen.findByText("Monthly spending limit")).toBeInTheDocument();
    expect(screen.getByText("Spending limit")).toBeInTheDocument(); // the side-nav label
    expect(screen.queryByText("Your allowance")).toBeNull();
  });

  it("subscription swaps the spending limit for a pointer to usage limits", async () => {
    account("subscription");
    renderWithProviders(<WithProject id="acme"><Settings /></WithProject>);
    expect((await screen.findAllByText("Your allowance")).length).toBe(2); // the side-nav label and the box
    expect(screen.queryByText("Spending limit")).toBeNull();
    expect(screen.queryByText("Monthly spending limit")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Usage limits" }).some((a) => a.getAttribute("href") === "#limits")).toBe(true);
  });

  it("both keeps the spending limit box", async () => {
    account("both");
    renderWithProviders(<WithProject id="acme"><Settings /></WithProject>);
    expect(await screen.findByText("Monthly spending limit")).toBeInTheDocument();
  });
});

describe("New project: how do you pay for AI?", () => {
  it("defaults to pay per use and sends the chosen mode", async () => {
    const calls: { method: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST") return json({ project: { project_id: "p1", slug: "bot", name: "Bot", billing_mode: "subscription" }, api_key: "mcm_live_abcdef" }, 201);
      return json([]);
    }));
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);
    expect(screen.getByText("How do you pay for AI?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Pay per use/ })).toBeChecked();
    expect(screen.getByText(/You can change this later in Settings/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Project name"), "Bot");
    await user.click(screen.getByRole("radio", { name: /Monthly subscription/ }));
    await user.click(screen.getByRole("button", { name: /Create project/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Bot", billing_mode: "subscription" }));
  });
});

describe("Server-written alert wording on a subscription", () => {
  const budget = {
    alert_id: "id-b", job: "invoice-extract", kind: "BUDGET", summary: "You have used 85% of your $500.00 monthly AI budget.",
    detail: { level: "85", spent_usd: 425, budget_usd: 500 }, created_at: "2026-11-10T09:00:00Z", delivered_at: null, delivery_attempts: 0, delivery_failed_at: null, resolved_at: null,
  } as unknown as Alert;
  const card = () => <WithProject id="acme"><AlertItemCard item={{ kind: "regression", alert: budget, timestamp: budget.created_at }} /></WithProject>;

  it("hides dollar wording and shows the neutral line", async () => {
    stubApi({ "/v1/projects/acme": { project_id: "acme", name: "Acme", billing_mode: "subscription" } });
    renderWithProviders(card());
    expect(await screen.findByText(MONEY_ALERT_FALLBACK)).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("per use still shows the server's wording", async () => {
    stubApi({ "/v1/projects/acme": { project_id: "acme", name: "Acme", billing_mode: "per_use" } });
    renderWithProviders(card());
    expect(await screen.findByText(budget.summary)).toBeInTheDocument();
    expect(screen.getByText("Spent $425 of your $500 limit.")).toBeInTheDocument();
  });
});
