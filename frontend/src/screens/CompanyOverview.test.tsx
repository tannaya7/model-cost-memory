import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { stubApi } from "../test/api";
import CompanyOverview from "./CompanyOverview";

const ORG = "00000000-0000-0000-0000-0000000000aa";
afterEach(() => vi.unstubAllGlobals());

const coverage = { calls: 30, calls_reporting_tokens: 24, calls_without_token_counts: 6, token_report_share: 0.8, calls_in_money_projects: 20, calls_priced: 18, calls_with_task_id: 10, calls_with_agent_label: 5, task_id_share: 0.33, agent_label_share: 0.17 };
const attribution = [
  { dimension: "project", source: "verified", detail: "Set by the project key.", coverage_share: 1 },
  { dimension: "task", source: "caller_supplied", detail: "The task name the app chose.", coverage_share: 1 },
  { dimension: "person", source: "not_recorded", detail: "No individual user identity is collected, so there are no per-person figures.", coverage_share: null },
];
const full = {
  org_id: ORG, name: "Acme", days: 30, since: "2026-10-19T00:00:00Z", until: "2026-11-18T00:00:00Z", your_role: "admin", projects_shown: 2, members: 3,
  totals: { calls: 30, tokens: 35000, billable_usd: 0.2, billable_basis: "calculated: reported tokens x dated list price; not an invoice", mixed_mode_usd: 0, unpriced_calls: 2, has_data: true },
  by_mode: { per_use: { projects: 1, calls: 10, tokens: 10000, usd: 0.2, unpriced_calls: 2 }, both: { projects: 0, calls: 0, tokens: 0, usd: 0, unpriced_calls: 0 }, subscription: { projects: 1, calls: 20, tokens: 25000, usd: null, unpriced_calls: 0 } },
  coverage, attribution, chargeback_grade: false,
  projects: [
    { project_id: "p-1", slug: "metered", name: "Metered", pay_mode: "per_use", calls: 10, tokens: 10000, cost_usd: 0.2, cost_kind: "billable_list_price", unpriced_calls: 2, calls_reporting_tokens: 10 },
    { project_id: "p-2", slug: "flat", name: "Flat", pay_mode: "subscription", calls: 20, tokens: 25000, cost_usd: null, cost_kind: "none_flat_plan", unpriced_calls: 0, calls_reporting_tokens: 14 },
  ],
  trend: [{ day: "2026-11-17", calls: 30, tokens: 35000, billable_usd: 0.2 }],
  tasks: [{ project: "Metered", project_id: "p-1", task: "invoice", calls: 10, tokens: 10000, cost_usd: 0.2, unpriced_calls: 2, pay_mode: "per_use", label_source: "caller_supplied" }],
  models: [{ model: "mini", calls: 30, tokens: 35000, cost_usd: 0.2, unpriced_calls: 2, flat_plan_calls: 20, label_source: "caller_supplied" }],
  notes: ["Task and model names come from the calling app and can be spoofed by anyone with a project key."],
};

function open(body: unknown) {
  stubApi({ [`/v1/organisations/${ORG}/overview`]: body });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/company/${ORG}/overview`]}><Routes><Route path="/company/:orgId/overview" element={<CompanyOverview />} /></Routes></MemoryRouter></QueryClientProvider>);
}

describe("company overview", () => {
  it("shows counts, list-price cost and what each number is", async () => {
    open(full);
    expect(await screen.findByRole("heading", { name: "Acme: overview" })).toBeInTheDocument();
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(within(totals).getByText("Calculated at list price, not an invoice")).toBeInTheDocument();
    expect(within(totals).getByText("Counted")).toBeInTheDocument();
    expect(within(totals).getByText("Cost unknown, not counted as free")).toBeInTheDocument();
  });

  it("keeps pay-per-use and flat-plan projects apart, with a way into each project", async () => {
    open(full);
    const projects = await screen.findByRole("region", { name: "Projects" });
    expect(within(projects).getByText("No dollars on a flat plan")).toBeInTheDocument();
    expect(within(projects).getByText("Pay per use")).toBeInTheDocument();
    expect(within(projects).getByText("Flat plan")).toBeInTheDocument();
    expect(within(projects).getByRole("link", { name: "Open Metered" })).toHaveAttribute("href", "/p/metered");
  });

  it("says what is verified and what the app supplied, and that no people are recorded", async () => {
    open(full);
    const trust = await screen.findByRole("region", { name: "Data coverage and attribution" });
    expect(within(trust).getByText("Verified")).toBeInTheDocument();
    expect(within(trust).getByText("Set by the app")).toBeInTheDocument();
    expect(within(trust).getByText("Not recorded")).toBeInTheDocument();
    expect(within(trust).getByText(/Not suitable for charging customers or teams/)).toBeInTheDocument();
    expect(within(trust).getByText(/80% of calls report token counts/)).toBeInTheDocument();
    expect(within(trust).getByText(/spoofed/)).toBeInTheDocument();
  });

  it("has no people, rankings or scores on the page", async () => {
    open(full);
    await screen.findByRole("heading", { name: "Acme: overview" });
    const text = document.body.textContent ?? "";
    for (const bad of ["leaderboard", "ranking", "productivity", "top spender", "worst"]) expect(text.toLowerCase()).not.toContain(bad);
  });

  it("explains an empty company plainly instead of showing zeros or a blank page", async () => {
    open({ ...full, projects_shown: 0, projects: [], tasks: [], models: [], trend: [], totals: { ...full.totals, calls: 0, tokens: 0, billable_usd: 0, unpriced_calls: 0, has_data: false } });
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  });

  it("explains a company with projects but no calls", async () => {
    open({ ...full, tasks: [], models: [], trend: [], totals: { ...full.totals, calls: 0, has_data: false } });
    expect(await screen.findByText("No AI calls recorded in this period")).toBeInTheDocument();
  });

  it("asks for another period when the choice changes", async () => {
    open(full);
    await screen.findByRole("heading", { name: "Acme: overview" });
    await userEvent.click(screen.getByRole("tab", { name: "7 days" }));
    expect((globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls.some((c) => c[0].includes("days=7"))).toBe(true);
  });
});

describe("the company report file", () => {
  it("is offered to admins and owners, and asks the server for the period on screen", async () => {
    open({ ...full, your_role: "admin" });
    const button = await screen.findByRole("button", { name: /Export CSV/ });
    expect(button).toHaveAttribute("title", expect.stringContaining("never prompts or people"));
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response("section\r\n", { status: 200, headers: { "content-disposition": 'attachment; filename="model-cost-memory-company-last-30-days.csv"', "x-export-rows": "7", "x-export-neutralized": "1" } });
    }));
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.click(button);
    expect(calls).toEqual([`/v1/organisations/${ORG}/overview/export.csv?days=30`]);
    const note = await screen.findByText(/Saved 7 rows for the last 30 days of Acme/);
    expect(note).toHaveTextContent("1 text value began with = + - or @");
  });

  it.each(["viewer", "member"])("is not offered to a %s, who may see the screen but not take the file", async (role) => {
    open({ ...full, your_role: role });
    await screen.findByRole("heading", { name: "Acme: overview" });
    expect(screen.queryByRole("button", { name: /Export CSV/ })).toBeNull();
  });

  it("is not offered when there is nothing to export", async () => {
    open({ ...full, your_role: "owner", totals: { ...full.totals, has_data: false, calls: 0 } });
    await screen.findByRole("heading", { name: "Acme: overview" });
    expect(screen.queryByRole("button", { name: /Export CSV/ })).toBeNull();
  });
});
