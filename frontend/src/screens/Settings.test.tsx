import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import { ToastProvider } from "../ui/Toast";
import type { Project } from "../shared/api/types";
import { BudgetSection, PrivacySection, ProjectSection } from "./Settings";
import Settings from "./Settings";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** One day of spend per day from `from` to Nov 16, as the API sends it. */
const series = (from: string, spend: number, job = "invoice-extract") => {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= NOW - DAY; t += DAY) out.push({ day: iso(t), job, model: "m", runs: 10, passed: 10, failed: 0, spend_usd: spend });
  return out;
};

type Opts = { budget?: number | null; billing?: string; daily?: unknown[]; failPatch?: boolean; slow?: boolean };
function account(opts: Opts = {}) {
  const project = { project_id: "acme", name: "Acme", content_retention_days: 90, store_tool_arguments: false, billing_mode: opts.billing ?? "per_use", webhook_url: null, retest_allowed: true, retest_monthly_cap_usd: 10, monthly_budget_usd: opts.budget ?? null, key_prefix: "mcm_x" } as unknown as Project;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/v1/projects/acme")) {
      if (method === "PATCH") {
        if (opts.slow) await new Promise((r) => setTimeout(r, 150));
        if (opts.failPatch) return json({ detail: "The server said no" }, 500);
        Object.assign(project, JSON.parse(String(init?.body)));
      }
      return json({ ...project });
    }
    if (url.startsWith("/v1/insights/daily")) return json(opts.daily ?? []);
    return json([]);
  }));
  return { project, patches: () => calls.filter((c) => c.method === "PATCH") };
}

describe("Settings: nothing applies until you press Apply", () => {
  it("project name: typing sends nothing, Apply sends exactly one request and a toast says so without taking focus", async () => {
    const { project, patches } = account();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><ProjectSection project={project} /></WithProject>);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    const box = screen.getByLabelText("Name");
    await user.clear(box);
    await user.type(box, "Acme Two");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    const toast = (await screen.findByText("Settings applied")).closest("[role=status]");
    expect(toast).not.toBeNull();
    expect(toast!.contains(document.activeElement)).toBe(false);
    expect(patches().map((c) => c.body)).toEqual([{ name: "Acme Two" }]);
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    expect(screen.getByLabelText("Name")).toHaveValue("Acme Two");
  });

  it("Discard puts the saved value back and sends nothing", async () => {
    const { project, patches } = account();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><ProjectSection project={project} /></WithProject>);
    await user.type(screen.getByLabelText("Name"), " more");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Acme");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(patches()).toHaveLength(0);
  });

  it("an error keeps what you typed, shows an alert and leaves the bar open", async () => {
    const { project } = account({ failPatch: true });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><ProjectSection project={project} /></WithProject>);
    await user.type(screen.getByLabelText("Name"), " X");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server said no");
    expect(screen.getByLabelText("Name")).toHaveValue("Acme X");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(screen.queryByText("Settings applied")).toBeNull();
  });

  it("a double click on Apply sends one request and the button reads Applying…", async () => {
    const { project, patches } = account({ slow: true });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><ProjectSection project={project} /></WithProject>);
    await user.type(screen.getByLabelText("Name"), "!");
    await user.dblClick(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    await screen.findByText("Settings applied");
    expect(patches()).toHaveLength(1);
  });

  it("retention days keep their own message and need Apply", async () => {
    const { project, patches } = account();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><PrivacySection project={project} /></WithProject>);
    await user.click(screen.getByRole("button", { name: "30" }));
    expect(patches()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText("Settings applied");
    expect(patches().map((c) => c.body)).toEqual([{ content_retention_days: 30 }]);
  });

  it("asks before leaving while there are unsaved changes, and warns the browser only while dirty", async () => {
    const { project } = account();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/", element: <><ProjectSection project={project} /><Link to="/other">Go away</Link></> },
      { path: "/other", element: <p>Other page</p> },
    ]);
    const user = userEvent.setup();
    render(<QueryClientProvider client={client}><ToastProvider><WithProject id="acme"><RouterProvider router={router} /></WithProject></ToastProvider></QueryClientProvider>);
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await user.type(screen.getByLabelText("Name"), "!");
    expect(unload()).toBe(true);
    await user.click(screen.getByRole("link", { name: "Go away" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.queryByText("Other page")).toBeNull();
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("link", { name: "Go away" }));
    expect(await screen.findByText("Other page")).toBeInTheDocument();
    await act(async () => undefined);
    expect(unload()).toBe(false);
  });
});

describe("Settings: monthly spending limit analysis", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOW }));

  async function setLimit(user: ReturnType<typeof userEvent.setup>, project: Project, amount: string) {
    renderWithProviders(<WithProject id="acme"><BudgetSection project={project} /></WithProject>);
    await user.type(screen.getByLabelText("Monthly spending limit in US dollars"), amount);
    return user;
  }
  const apply = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Apply" }));
  const card = () => screen.findByRole("region", { name: "What this limit means" });

  it("under 7 full days says Still learning and shows no month-end numbers", async () => {
    const { project, patches } = account({ daily: series("2026-11-13", 10) });
    const user = await setLimit(userEvent.setup(), project, "500");
    await apply(user);
    const c = await card();
    expect(c).toHaveTextContent("Still learning");
    expect(c).not.toHaveTextContent("Month-end estimate");
    expect(patches().map((p) => p.body)).toEqual([{ monthly_budget_usd: 500 }]);
  });

  it.each([
    ["1000", "likely under your limit"],
    ["295", "close to your limit, could go either way"],
    ["200", "likely over your limit"],
  ])("limit %s: month-end range reads '%s'", async (limit, verdict) => {
    const { project } = account({ daily: series("2026-10-01", 10) });
    const user = await setLimit(userEvent.setup(), project, limit);
    await apply(user);
    const c = await card();
    expect(c).toHaveTextContent("$295 to $295");
    expect(c).toHaveTextContent(verdict);
    expect(c).toHaveTextContent("Estimate from recorded calls at list prices, not your bill.");
  });

  it("a limit below what is already spent is warned about before Apply, and still allowed", async () => {
    const { project, patches } = account({ daily: series("2026-10-01", 10) });
    const user = await setLimit(userEvent.setup(), project, "100");
    expect(await screen.findByText(/You have already used about \$160 \(estimate\), above this limit\. The 85% and 95% warnings will not fire again this month\./)).toBeInTheDocument();
    await apply(user);
    await card();
    expect(patches()).toHaveLength(1);
  });

  it("with no complete month it says there is not enough history and hides the starting-point chip", async () => {
    const { project } = account({ daily: series("2026-11-05", 10) });
    const user = await setLimit(userEvent.setup(), project, "500");
    expect(screen.queryByText(/Last full month's spend plus 20%/)).toBeNull();
    await apply(user);
    const c = await card();
    expect(c).toHaveTextContent("Not enough history yet to check past months.");
  });

  it("offers last full month plus 20% as a starting point and fills the box when chosen", async () => {
    account({ daily: series("2026-10-01", 10) });
    const user = userEvent.setup();
    const { project } = account({ daily: series("2026-10-01", 10) });
    renderWithProviders(<WithProject id="acme"><BudgetSection project={project} /></WithProject>);
    await user.click(await screen.findByRole("button", { name: /Last full month's spend plus 20%: \$372 \(a starting point, not a recommendation\)/ }));
    expect(screen.getByLabelText("Monthly spending limit in US dollars")).toHaveValue("372");
  });

  it("subscription hides the dollar editor and keeps the allowance card", async () => {
    account({ billing: "subscription" });
    renderWithProviders(<WithProject id="acme"><Settings /></WithProject>);
    expect((await screen.findAllByText("Your allowance")).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Monthly spending limit in US dollars")).toBeNull();
  });
});
