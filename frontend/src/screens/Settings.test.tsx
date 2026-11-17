import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import { ToastProvider } from "../ui/Toast";
import type { Project } from "../shared/api/types";
import { AlertsSection, BudgetSection, PrivacySection, ProjectSection, RetestsSection } from "./Settings";
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

type Opts = { webhook?: string | null; retestAllowed?: boolean; routes?: Record<string, unknown>; budget?: number | null; billing?: string; daily?: unknown[]; failPatch?: boolean; slow?: boolean };
function account(opts: Opts = {}) {
  const project = { project_id: "acme", name: "Acme", content_retention_days: 90, store_tool_arguments: false, billing_mode: opts.billing ?? "per_use", webhook_url: opts.webhook ?? null, retest_allowed: opts.retestAllowed ?? true, retest_monthly_cap_usd: 10, monthly_budget_usd: opts.budget ?? null, key_prefix: "mcm_x" } as unknown as Project;
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
    const route = Object.keys(opts.routes ?? {}).find((r) => url.startsWith(r));
    if (route) return method === "DELETE" ? new Response(null, { status: 204 }) : json(opts.routes![route]);
    return json([]);
  }));
  return { project, patches: () => calls.filter((c) => c.method === "PATCH"), writes: () => calls.filter((c) => c.method !== "GET") };
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
    await user.click(screen.getByRole("button", { name: "Delete older text, keep 30 days" }));
    await screen.findByText("Keeping prompts and answers for 30 days");
    expect(patches().map((c) => c.body)).toEqual([{ content_retention_days: 30 }]);
  });

  it("a LOWER retention says exactly what is deleted and that it cannot come back; a higher one does not warn", async () => {
    const { project, patches } = account();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><PrivacySection project={project} /></WithProject>);
    await user.click(screen.getByRole("button", { name: "30" }));
    const note = screen.getByText(/What will be deleted\./).parentElement!;
    expect(note).toHaveTextContent("prompt, answer, tool calls and answer key of every AI call older than 30 days");
    expect(note).toHaveTextContent("Whether each call was correct, what it cost and its token counts stay");
    expect(note).toHaveTextContent("cannot be brought back");
    expect(patches()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Keep 90 days" }));
    expect(patches()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "365" }));
    expect(screen.queryByText(/What will be deleted/)).toBeNull();
  });

  it("webhook: a non-https address is refused next to the field, what you typed stays, nothing is sent", async () => {
    const { project, patches } = account();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><AlertsSection project={project} /></WithProject>);
    const box = screen.getByLabelText("Webhook URL");
    await user.type(box, "http://example.com/hook");
    await user.click(screen.getByRole("button", { name: "Save address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use an address that starts with https://.");
    expect(box).toHaveValue("http://example.com/hook");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(patches()).toHaveLength(0);
  });

  it("webhook: a good address saves with a toast; emptying it first says alerts will only be in the app", async () => {
    const { project, patches } = account({ webhook: "https://hooks.slack.com/x" });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><AlertsSection project={project} /></WithProject>);
    await user.clear(screen.getByLabelText("Webhook URL"));
    expect(screen.getByText(/alerts only appear in the app/)).toBeInTheDocument();
    expect(patches()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Remove address" }));
    const toast = (await screen.findByText("Alert address removed. Alerts now show only in the app.")).closest("[role=status]");
    expect(toast).not.toBeNull();
    expect(patches().map((c) => c.body)).toEqual([{ webhook_url: null }]);
  });

  it("trials: turning ON allow-trials shows who gets the prompts and the budget; Keep trials off sends nothing", async () => {
    const { project, writes } = account({ retestAllowed: false });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><RetestsSection project={project} /></WithProject>);
    await user.click(screen.getByRole("checkbox", { name: /Allow trials on new models/ }));
    expect(screen.getByText(/Past prompts will be sent to the provider of the model you choose to test, at their cost, within your trial budget of \$10\.00 a month\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep trials off" }));
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("checkbox", { name: /Allow trials on new models/ }));
    await user.click(screen.getByRole("button", { name: "Allow trials" }));
    await screen.findByText("Trials are allowed");
    expect(writes().filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  const KEY = { "/v1/retest/limits": { monthly_cap_usd: 10, spent_this_month_usd: 1, cap_remaining_usd: 9, provider_key: { provider: "gemini", key_hint: "abcd" } } };

  it("removing the provider key asks first, sends one DELETE on confirm, and toasts", async () => {
    const { project, writes } = account({ routes: KEY });
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><RetestsSection project={project} /></WithProject>);
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const box = screen.getByRole("group", { name: "Remove the provider key" });
    expect(box).toHaveTextContent("Remove the gemini key? New trials cannot start without a key. You can add it again.");
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Keep key" }));
    expect(writes()).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Remove the provider key" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(await screen.findByText("gemini key removed")).toBeInTheDocument();
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(["DELETE /v1/provider-key"]);
  });

  it("with several sections unsaved, leaving asks exactly once", async () => {
    const { project } = account();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/", element: <><ProjectSection project={project} /><PrivacySection project={project} /><Link to="/other">Go away</Link></> },
      { path: "/other", element: <p>Other page</p> },
    ]);
    const user = userEvent.setup();
    render(<QueryClientProvider client={client}><ToastProvider><WithProject id="acme"><RouterProvider router={router} /></WithProject></ToastProvider></QueryClientProvider>);
    await user.type(screen.getByLabelText("Name"), "!");
    await user.click(screen.getByRole("button", { name: "30" }));
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2);
    await user.click(screen.getByRole("link", { name: "Go away" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await act(async () => undefined);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Other page")).toBeNull();
    // Cancel restored nothing: both drafts are still there.
    expect(screen.getAllByText("Unsaved changes")).toHaveLength(2);
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
