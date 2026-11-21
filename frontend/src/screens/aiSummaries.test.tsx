/** The summary switch: off by default, says where the figures go and what is sent before anything is, and a summary on a
 * flat-fee plan cannot bring dollars back even if the server's own check were bypassed. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import type { Project } from "../shared/api/types";
import { hasMoneyWording, serverText } from "../features/projects/moneyWording";
import { AiSummariesSection } from "./Settings";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function mount(project: Partial<Project> = {}) {
  const patches: Array<Record<string, unknown>> = [];
  const p = { project_id: "acme", name: "Acme", slug: "acme", billing_mode: "per_use", ai_summary_consent: false, ai_summary_host: "generativelanguage.googleapis.com", ...project } as unknown as Project;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/v1/projects/acme")) {
      if (init?.method === "PATCH") {
        const b = JSON.parse(String(init.body));
        patches.push(b);
        Object.assign(p, b);
      }
      return json({ ...p });
    }
    return json([]);
  }));
  renderWithProviders(<WithProject id="acme"><AiSummariesSection project={p} /></WithProject>);
  return { patches };
}

const box = () => screen.getByRole("checkbox", { name: /Write a summary under each recommendation/ });

describe("the summary switch", () => {
  it("starts off and says where the figures would go", () => {
    mount();
    expect(box()).not.toBeChecked();
    expect(screen.getByText("The figures would be sent to generativelanguage.googleapis.com.")).toBeInTheDocument();
    expect(screen.getByText(/Off by default\. Never changes a recommendation\./)).toBeInTheDocument();
  });

  it("with no summary service on the server it is off, disabled and says why", () => {
    mount({ ai_summary_host: null } as Partial<Project>);
    expect(box()).toBeDisabled();
    expect(screen.getByText("This server has no summary service, so there is nothing to turn on.")).toBeInTheDocument();
  });

  it("turning it on first shows what is sent and what is not, and sends nothing until confirmed", async () => {
    const user = userEvent.setup();
    const { patches } = mount();
    await user.click(box());
    const review = screen.getByText(/Sent to generativelanguage\.googleapis\.com: model names, correct-answer rates and their ranges, and costs\./);
    expect(review).toHaveTextContent("Never your prompts, answers or any run text");
    expect(review).toHaveTextContent("A daily limit applies");
    expect(review).toHaveTextContent("checked against the figures, and is not shown if it does not match");
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send figures there" }));
    await waitFor(() => expect(patches).toEqual([{ ai_summary_consent: true }]));
  });

  it("'Keep summaries off' changes nothing", async () => {
    const user = userEvent.setup();
    const { patches } = mount();
    await user.click(box());
    await user.click(screen.getByRole("button", { name: "Keep summaries off" }));
    expect(box()).not.toBeChecked();
    expect(patches).toHaveLength(0);
  });

  it("on a flat-fee plan the review says no costs are sent", async () => {
    const user = userEvent.setup();
    mount({ billing_mode: "subscription" } as Partial<Project>);
    await user.click(box());
    const review = screen.getByText(/Sent to generativelanguage\.googleapis\.com: model names, correct-answer rates and their ranges\./);
    expect(review.textContent).not.toMatch(/costs/);
  });

  it("turning it off needs no review and says the summary then disappears", async () => {
    const user = userEvent.setup();
    const { patches } = mount({ ai_summary_consent: true } as Partial<Project>);
    await user.click(box());
    expect(screen.queryByText(/Sent to generativelanguage/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(patches).toEqual([{ ai_summary_consent: false }]));
  });
});

describe("a generated summary can never bring dollars back on a flat-fee plan", () => {
  const talks = [
    "Mini costs less and passes about as often.", "You would save money by switching.", "Mini is cheaper than big.", "That keeps the bill down.",
    "Mini is about $0.001 a call.", "The more expensive model is not needed.", "At current prices mini is the better value.", "You would pay less.",
  ];
  it.each(talks)("hides %s on a subscription", (text) => {
    expect(hasMoneyWording(text)).toBe(true);
    expect(serverText(text, "subscription", null)).toBeNull();
  });
  it("shows a summary about correct answers on a subscription, and every summary on a pay-per-use project", () => {
    const fine = "Mini gives about as many correct answers as big, though its range is still wide.";
    expect(serverText(fine, "subscription", null)).toBe(fine);
    for (const t of talks) expect(serverText(t, "per_use", null)).toBe(t);
  });
});
