/** The Smart budget page: the month forecast, the limit, and the "if other people use your key" what-if. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import SmartBudget from "./SmartBudget";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** `history` full days of $10 a day, then whatever the project's pay mode and limit are. */
function server(opts: { history?: number; mode?: string; budget?: number | null } = {}) {
  const { history = 12, mode = "per_use", budget = null } = opts;
  const points = Array.from({ length: history }, (_, i) => ({ day: day(i + 1), job: "invoice-extract", model: "m", runs: 10, passed: 9, failed: 1, spend_usd: 10 }));
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    seen.push(url);
    if (url.startsWith("/v1/projects/acme")) return json({ project_id: "acme", name: "Acme", billing_mode: mode, monthly_budget_usd: budget, content_retention_days: 90 });
    if (url.startsWith("/v1/insights/daily")) return json(points);
    if (url.startsWith("/v1/jobs")) return json([{ job_id: "1", name: "invoice-extract", run_count: 10, runs_by_state: {} }, { job_id: "2", name: "ticket-classify", run_count: 5, runs_by_state: {} }]);
    return json([]);
  }));
  return seen;
}

function mount() {
  renderWithProviders(<WithProject id="acme"><SmartBudget /></WithProject>);
}

describe("Smart budget", () => {
  it("explains itself in plain words and labels every figure an estimate", async () => {
    server();
    mount();
    expect(screen.getByRole("heading", { name: "Smart budget" })).toBeInTheDocument();
    expect(screen.getAllByText(/not your bill/i).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Likely by/)).toBeInTheDocument();
  });

  it("shows no forecast numbers until there is a week of history", async () => {
    server({ history: 3 });
    mount();
    expect(await screen.findByText(/Not enough days yet/)).toBeInTheDocument();
    expect(screen.queryByText(/\$\d+ to \$\d+/)).toBeNull();
  });

  it("gives a flat-plan project a pointer to its allowance and no dollar forecast", async () => {
    server({ mode: "subscription" });
    mount();
    expect(await screen.findByText("You pay a flat fee")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Usage limits" })).toBeInTheDocument();
    expect(screen.queryByText(/If other people use your key/)).toBeNull();
  });

  it("works out the what-if from the person's own spend, in plain words, and says it is a guess", async () => {
    server({ history: 12, budget: 1000 });
    const user = userEvent.setup();
    mount();
    const panel = (await screen.findByText("If other people use your key")).closest("#shared-key") as HTMLElement;
    const others = within(panel).getByLabelText(/How many other people use it/);
    await user.clear(others);
    await user.type(others, "2");
    const text = await within(panel).findByText(/If 2 other people use this key about as much as you do/);
    expect(text).toHaveTextContent(/this month could end around \$\d[\d,]* to \$\d[\d,]*, instead of about \$\d[\d,]* on your own/);
    expect(within(panel).getByText(/This is a guess, not a measurement/)).toBeInTheDocument();
    expect(within(panel).getByText(/would be about 33%/)).toBeInTheDocument(); // you and two others at your pace: a third each
    await user.click(within(panel).getByRole("tab", { name: "More than you" }));
    expect(await within(panel).findByText(/more than you do/)).toBeInTheDocument();
    expect(within(panel).getByText(/would be about 20%/)).toBeInTheDocument(); // 1 + 2 x 2 = 5 shares
  });

  it("asks for at least one other person before it shows anything, and filters by AI task", async () => {
    const seen = server({ history: 12 });
    const user = userEvent.setup();
    mount();
    const panel = (await screen.findByText("If other people use your key")).closest("#shared-key") as HTMLElement;
    const others = within(panel).getByLabelText(/How many other people use it/);
    await user.clear(others);
    await user.type(others, "0");
    expect(await within(panel).findByText(/Add at least one other person/)).toBeInTheDocument();
    await user.selectOptions(within(panel).getByLabelText("What the key is used for"), "ticket-classify");
    await waitFor(() => expect(seen.some((u) => u.includes("job=ticket-classify"))).toBe(true));
  });
});
