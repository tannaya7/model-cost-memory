import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { WithProject } from "../../app/project";
import type { Project } from "../../shared/api/types";
import { BudgetSection } from "../Settings";
import { MonthProjection } from "./moneyWidgets";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daily = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ day: day(n), job: "j", model: "m", runs: 10, passed: 10, failed: 0, spend_usd: 2 }));

/** A tiny account: GET and PATCH of the project, plus the daily spend. */
function account(budget: number | null) {
  const project = { project_id: "acme", name: "Acme", content_retention_days: 90, monthly_budget_usd: budget } as unknown as Project;
  const patches: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("/v1/projects/acme")) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        project.monthly_budget_usd = body.monthly_budget_usd;
      }
      return json({ ...project });
    }
    if (url.startsWith("/v1/insights/daily")) return json(daily);
    return json([]);
  }));
  return { project, patches };
}

const shell = { id: "projection" } as never;

describe("Settings: monthly spending limit", () => {
  it("sends nothing until Apply, rejects bad amounts beside the field, then applies once and shows the analysis", async () => {
    const { patches, project } = account(null);
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><BudgetSection project={project} /></WithProject>);
    expect(screen.getByText("Not set")).toBeInTheDocument();
    const box = screen.getByLabelText("Monthly spending limit in US dollars");
    expect(box).toHaveAttribute("type", "text");
    expect(box).toHaveAttribute("inputmode", "decimal");
    expect(screen.getByText("The limit only warns, it never blocks.")).toBeInTheDocument();
    await user.type(box, "-5");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Type an amount above zero");
    expect(patches).toHaveLength(0);
    await user.clear(box);
    await user.type(box, "$1,200.50");
    expect(patches).toHaveLength(0); // typing alone sends nothing
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByText("Limit set to $1,200.50")).closest("[role=status]")).not.toBeNull();
    expect(patches).toEqual([{ monthly_budget_usd: 1200.5 }]);
    expect(await screen.findByRole("region", { name: "What this limit means" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull(); // the bar closed
  });

  it("removes a saved limit and says so", async () => {
    const { patches, project } = account(500);
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><BudgetSection project={project} /></WithProject>);
    expect(screen.getByText("$500 a month")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Remove limit" }));
    expect((await screen.findByText("Limit removed")).closest("[role=status]")).not.toBeNull();
    expect(patches).toEqual([{ monthly_budget_usd: null }]);
  });
});

describe("Month projection widget", () => {
  it("uses the budget on the account", async () => {
    account(500);
    renderWithProviders(<WithProject id="acme"><MonthProjection shell={shell} /></WithProject>);
    expect(await screen.findByText(/Limit \$500 a month/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved in this browser only/)).not.toBeInTheDocument();
  });

  it("offers once to move a browser-only budget to the account, then clears the browser copy", async () => {
    localStorage.setItem("mcm_budget_acme", "300");
    const { patches } = account(null);
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><MonthProjection shell={shell} /></WithProject>);
    expect(await screen.findByText("Saved in this browser only. Save it to your account?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to my account" }));
    expect((await screen.findByText("Limit set to $300")).closest("[role=status]")).not.toBeNull();
    expect(patches).toEqual([{ monthly_budget_usd: 300 }]);
    expect(localStorage.getItem("mcm_budget_acme")).toBeNull();
  });
});
