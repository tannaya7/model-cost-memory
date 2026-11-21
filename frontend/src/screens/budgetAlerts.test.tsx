/** Budget alert settings: in the app by default, thresholds and timezone chosen by the owner, and nothing leaves the app
 * unless the owner turns the webhook on after seeing where it would go. Nothing here can block a call. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import type { Project } from "../shared/api/types";
import Settings, { BudgetAlertsSection, timezoneChoices } from "./Settings";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function account(over: Partial<Project> = {}, failWith?: { status: number; detail: string }) {
  const project = {
    project_id: "acme", name: "Acme", slug: "acme", content_retention_days: 90, monthly_budget_usd: 100, billing_mode: "per_use",
    webhook_url: null, webhook_secret: null, retest_allowed: true, retest_monthly_cap_usd: 10, store_tool_arguments: false,
    key_prefix: "mcm_live_ab", created_at: "2026-11-01T00:00:00Z",
    budget_timezone: "UTC", budget_alert_levels: [85, 95], budget_alert_projected: true, budget_alert_webhook: false, ...over,
  } as unknown as Project;
  const patches: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/v1/projects/acme")) {
      if (init?.method === "PATCH") {
        if (failWith) return json({ detail: failWith.detail }, failWith.status);
        const body = JSON.parse(String(init.body));
        patches.push(body);
        Object.assign(project, body);
      }
      return json({ ...project });
    }
    return json([]);
  }));
  return { project, patches };
}

const mount = (project: Project) => renderWithProviders(<WithProject id="acme"><BudgetAlertsSection project={project} /></WithProject>);

describe("the defaults", () => {
  it("shows the app as the only destination, 85% and 95% ticked, the forecast warning on, and UTC", () => {
    const { project } = account();
    mount(project);
    expect(screen.getByRole("heading", { name: "Budget alerts" })).toBeInTheDocument();
    expect(screen.getByText(/Always shown in the app\. Nothing is sent anywhere unless you turn it on here\. They only warn: nothing is ever blocked\./)).toBeInTheDocument();
    for (const n of [85, 95]) expect(screen.getByRole("checkbox", { name: `${n}%` })).toBeChecked();
    for (const n of [50, 75, 90, 100]) expect(screen.getByRole("checkbox", { name: `${n}%` })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Also warn me when the forecast says I will go over/ })).toBeChecked();
    expect(screen.getByLabelText("Timezone for the month and its days")).toHaveValue("UTC");
    expect(screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ })).not.toBeChecked();
    expect(screen.getByText(/In the app/)).toBeInTheDocument();
  });

  it("explains that the forecast warning is a forecast, and when it fires", () => {
    mount(account().project);
    expect(screen.getByText(/Only when even the low end of the forecast is above your limit\. This is a forecast, not spend that has happened\./)).toBeInTheDocument();
  });

  it("says email is not available rather than offering a switch that does nothing", () => {
    mount(account().project);
    expect(screen.getByText(/Email/)).toHaveTextContent("not available yet");
    expect(screen.queryByRole("checkbox", { name: /email/i })).toBeNull();
  });
});

describe("choosing thresholds, forecast warning and timezone", () => {
  it("sends nothing until Apply, then sends exactly the choices, thresholds in order", async () => {
    const { project, patches } = account();
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "50%" }));
    await user.click(screen.getByRole("checkbox", { name: "85%" }));
    await user.click(screen.getByRole("checkbox", { name: /Also warn me when the forecast says I will go over/ }));
    await user.selectOptions(screen.getByLabelText("Timezone for the month and its days"), "UTC");
    expect(patches).toHaveLength(0);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ budget_alert_levels: [50, 95], budget_alert_projected: false, budget_timezone: "UTC", budget_alert_webhook: false });
    expect((await screen.findByText("Budget alert settings saved")).closest("[role=status]")).not.toBeNull();
  });

  it("Discard drops the changes and sends nothing", async () => {
    const { project, patches } = account();
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "90%" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("checkbox", { name: "90%" })).not.toBeChecked();
    expect(patches).toHaveLength(0);
  });

  it("every threshold can be turned off, so the person can keep only the forecast warning", async () => {
    const { project, patches } = account();
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "85%" }));
    await user.click(screen.getByRole("checkbox", { name: "95%" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].budget_alert_levels).toEqual([]);
  });

  it("offers the timezone the project already uses even if the browser's list lacks it", () => {
    expect(timezoneChoices("Etc/Odd")).toContain("Etc/Odd");
    expect(timezoneChoices("UTC")[0]).toBe("UTC");
    const { project } = account({ budget_timezone: "Europe/Berlin" });
    mount(project);
    expect(screen.getByLabelText("Timezone for the month and its days")).toHaveValue("Europe/Berlin");
    expect(screen.getByText(/The month starts and ends at midnight in this timezone\. Now: Europe\/Berlin\./)).toBeInTheDocument();
  });

  it("a refusal from the server is shown and the person's choices are kept", async () => {
    const { project } = account({}, { status: 422, detail: "budget_timezone: not a known timezone name (for example Europe/Berlin or UTC)" });
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "50%" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a known timezone name");
    expect(screen.getByRole("checkbox", { name: "50%" })).toBeChecked();
  });
});

describe("notifications are opt-in", () => {
  it("the webhook choice is disabled, with the reason, until a webhook address exists", () => {
    mount(account({ webhook_url: null }).project);
    expect(screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ })).toBeDisabled();
    expect(screen.getByText("Add a webhook address in Alerts first, then you can turn this on.")).toBeInTheDocument();
  });

  it("having a webhook address does not turn budget alerts on: it says where they would go and that it is off", () => {
    mount(account({ webhook_url: "https://hooks.example.com/abc" }).project);
    const box = screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ });
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText("They would be posted to hooks.example.com. Off by default.")).toBeInTheDocument();
  });

  it("turning it on shows where it goes and what is sent first, and sends nothing until confirmed", async () => {
    const { project, patches } = account({ webhook_url: "https://hooks.example.com/abc" });
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ }));
    expect(screen.getByText(/Budget alerts, with your spending figures but no prompt text, will also be posted to hooks\.example\.com\. You can turn this off at any time\./)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send budget alerts there" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].budget_alert_webhook).toBe(true);
  });

  it("'Keep them in the app only' changes nothing", async () => {
    const { project, patches } = account({ webhook_url: "https://hooks.example.com/abc" });
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ }));
    await user.click(screen.getByRole("button", { name: "Keep them in the app only" }));
    expect(screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ })).not.toBeChecked();
    expect(patches).toHaveLength(0);
  });

  it("turning it off needs no review, and is sent on Apply", async () => {
    const { project, patches } = account({ webhook_url: "https://hooks.example.com/abc", budget_alert_webhook: true });
    mount(project);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Also send budget alerts to my webhook/ }));
    expect(screen.queryByText(/will also be posted to/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].budget_alert_webhook).toBe(false);
  });
});

describe("where it appears", () => {
  it("per use and both have it; a subscription has no dollar alerts to set", async () => {
    for (const [mode, shown] of [["per_use", true], ["both", true], ["subscription", false]] as const) {
      account({ billing_mode: mode });
      const { unmount } = renderWithProviders(<WithProject id="acme"><Settings /></WithProject>);
      await screen.findByText(/How you pay for AI/);
      if (shown) expect(await screen.findByRole("heading", { name: "Budget alerts" })).toBeInTheDocument();
      else {
        await screen.findByText("Your allowance", { selector: "h2, h3, p, span" }).catch(() => null);
        expect(screen.queryByRole("heading", { name: "Budget alerts" })).toBeNull();
      }
      unmount();
    }
  });

  it("offers no hard stop, no cap on calls and nothing that changes the app", () => {
    const { container } = mount(account().project);
    expect(container.textContent).not.toMatch(/block calls|hard stop|enforce|throttle|stop my app|pause my app/i);
    expect(screen.getAllByRole("checkbox").every((c) => !/block|stop|cap calls/i.test(c.getAttribute("aria-label") ?? ""))).toBe(true);
  });
});
