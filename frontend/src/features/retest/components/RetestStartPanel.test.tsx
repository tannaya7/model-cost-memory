import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { RetestStartPanel } from "./RetestStartPanel";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const preview = (over: Record<string, unknown> = {}) => ({
  job: "invoice-extract", candidate_model: "gem-mini", budget_usd: 2, sample_size_requested: 50, can_start: true, blocked: null,
  statements: ["Your live traffic is not touched. Nothing is routed, switched or changed in your app or source code.", "The candidate model is not added to your project or its settings. Only the replay results are recorded, as test runs.", "This runs once, after you confirm, and is not repeated or scheduled."],
  evaluator_kind: "ANSWER_KEY", evaluator: "The task's own answer key.", provider: "gemini", destination_host: "gemini.example",
  examples: { available: 80, planned: 50, left_out_for_tool_use: 4 },
  data: [
    { kind: "sent", what: "The text of 50 past prompts from this task.", where: "Sent to gemini.example, the provider behind the key you stored." },
    { kind: "stays", what: "The saved correct answers.", where: "Used here to check each replayed answer. Not sent to the provider." },
  ],
  retention_note: "Your prompts are sent to gemini.example. How long it keeps them depends on that provider. This product does not know and cannot check that.",
  cost: { low_usd: 0.05, high_usd: 0.4, worst_case_usd: 0.9, budget_usd: 2, monthly_cap_remaining_usd: 9, note: "Low assumes answers as long as the originals.", estimated_from: "50 sampled prompts" },
  confirmation: "c".repeat(60), expires_at: "2026-11-19T10:10:00Z", confirm_minutes: 10, ...over,
});

function api(failStart = false, previewOver: Record<string, unknown> = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/v1/jobs") return json([{ job_id: "j1", name: "invoice-extract", retest_consent: true, run_count: 90 }]);
    if (url.startsWith("/v1/retest/limits")) return json({ monthly_cap_usd: 10, spent_this_month_usd: 1, cap_remaining_usd: 9, provider_key: { provider: "gemini", key_hint: "abcd" } });
    if (url.startsWith("/v1/models")) return json({ items: [{ model: "gem-mini", provider: "gemini", status: "ACTIVE", price_in_per_mtok: 0.1, price_out_per_mtok: 0.4 }], total: 1 });
    if (method === "POST" && url.endsWith("/retest/preview")) return json(preview(previewOver));
    if (method === "POST") return failStart ? json({ detail: "Provider refused" }, 500) : json({ retest_id: "t1", job: "invoice-extract" }, 202);
    return json([]);
  }));
  return { starts: () => calls.filter((c) => c.startsWith("POST")) };
}

describe("starting a trial", () => {
  it("the button only opens a review with provider, model, cost cap and budget; nothing is sent until Start trial", async () => {
    const { starts } = api();
    const user = userEvent.setup();
    renderWithProviders(<RetestStartPanel />);
    const open = await screen.findByRole("button", { name: "Review and start a trial" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const box = screen.getByRole("group", { name: "Start this trial" });
    expect(box).toHaveTextContent("gem-mini");
    expect(box).toHaveTextContent("(gemini)");
    expect(box).toHaveTextContent("Replay 50 past prompts");
    expect(box).toHaveTextContent("Sent to gemini.example, the provider behind the key you stored.");
    expect(box).toHaveTextContent("Not sent to the provider");
    expect(box).toHaveTextContent("$0.0500 to $0.4000, never more than your budget of $2.00");
    expect(box).toHaveTextContent("This product does not know and cannot check that");
    expect(box).toHaveTextContent("live traffic is not touched");
    expect(box).toHaveTextContent("4 prompts are left out because their runs used tools");
    expect(starts()).toEqual(["POST /v1/jobs/invoice-extract/retest/preview"]); // only the preview: nothing is paid for yet
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Start this trial" })).toBeNull();
    expect(starts().filter((c) => !c.endsWith("/preview"))).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Review and start a trial" }));
    await user.click(await screen.findByRole("button", { name: /Confirm and start/ }));
    await waitFor(() => expect(starts().filter((c) => !c.endsWith("/preview"))).toEqual(["POST /v1/jobs/invoice-extract/retest"]));
  });

  it("a failed start shows the reason as an alert and keeps the form", async () => {
    api(true);
    const user = userEvent.setup();
    renderWithProviders(<RetestStartPanel />);
    const open = await screen.findByRole("button", { name: "Review and start a trial" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await user.click(await screen.findByRole("button", { name: /Confirm and start/ }));
    expect(await screen.findByText("Provider refused")).toBeInTheDocument();
    expect(screen.getByLabelText(/Most this trial may spend/)).toHaveValue(2);
  });

  it("sends the confirmation the preview returned, and nothing else paid", async () => {
    const bodies: string[] = [];
    api();
    const inner = globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: RequestInit) => {
      if (i?.method === "POST" && !u.endsWith("/preview")) bodies.push(String(i.body));
      return inner(u, i);
    }));
    const user = userEvent.setup();
    renderWithProviders(<RetestStartPanel />);
    const open = await screen.findByRole("button", { name: "Review and start a trial" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await user.click(await screen.findByRole("button", { name: /Confirm and start/ }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(JSON.parse(bodies[0]).confirmation).toBe("c".repeat(60));
  });

  it("when the preview says it cannot start, it explains why and offers no confirm button", async () => {
    api(false, { can_start: false, confirmation: null, blocked: { code: "consent_off", message: "Trials are off for this AI task: turn on trials for it first" } });
    const user = userEvent.setup();
    renderWithProviders(<RetestStartPanel />);
    const open = await screen.findByRole("button", { name: "Review and start a trial" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    expect(await screen.findByText(/turn on trials for it first/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm and start/ })).toBeNull();
  });
});
