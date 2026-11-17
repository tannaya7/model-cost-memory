import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { stubApi } from "../../test/api";
import { AboutTask } from "./AboutTask";

const job = { job_id: "j1", name: "invoice-extract", description: null, check_kind: "SCHEMA", check_config: {}, retest_consent: false, run_count: 3 } as never;
const summary = (over: object) => ({ state: "off", text: null, consent: false, service: "ai.example.com", ...over });
const facts = { calls: 80, window_days: 30, enough_data: true, models: ["acme-mini"], uses_tools: false, works_like_agent: "probably", tool_source: null, multi_agent: false, typical_tokens_in: 1840, typical_tokens_out: 96 };

async function show(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AboutTask job={job} />
    </QueryClientProvider>,
  );
  if (open) await userEvent.setup().click(screen.getByRole("button", { name: "Show how we know" }));
}

describe("What this task is", () => {
  it("is collapsed by default: description and models up top, the three layers behind Show how we know", async () => {
    stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, summary: summary({}) } });
    await show(false);
    expect(await screen.findByText(/Models used: acme-mini/)).toBeInTheDocument();
    expect(screen.queryByText("What we can see from your calls")).not.toBeInTheDocument();
    expect(screen.queryByText(/outside AI service/)).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Show how we know" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(btn);
    expect(screen.getByText("What we can see from your calls")).toBeInTheDocument();
    expect(await screen.findByText(/outside AI service/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide how we know" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a friendly prompt when there is no description, and labels measured vs estimate", async () => {
    stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, summary: summary({}) } });
    await show();
    expect(await screen.findByText(/Add a one-line description so your team knows what this task does/)).toBeInTheDocument();
    expect(await screen.findByText("acme-mini")).toBeInTheDocument();
    expect(screen.getByText(/About 1.8k tokens in and 96 tokens out/)).toBeInTheDocument();
    expect(screen.getByText("Looks like an agent")).toBeInTheDocument();
    expect(screen.getAllByText("(estimate)")).toHaveLength(1);
    expect(screen.getAllByText("(measured)").length).toBeGreaterThan(3);
  });

  it("uses the not-enough-data box under 25 calls", async () => {
    stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, calls: 7, enough_data: false, summary: summary({}) } });
    await show();
    expect(await screen.findByText("Not enough calls yet")).toBeInTheDocument();
    expect(screen.getByText(/You have 7 so far/)).toBeInTheDocument();
  });

  it("asks for consent in plain words, naming the service, and sends nothing until Turn on", async () => {
    const calls = stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, summary: summary({}) }, "/v1/task-summary-consent": summary({ consent: true, state: "pending" }) });
    await show();
    expect(await screen.findByText("ai.example.com")).toBeInTheDocument();
    expect(screen.getByText(/outside AI service/)).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Turn on AI summaries" }));
    // The review is open and still nothing is sent.
    expect(screen.getByRole("group", { name: "Turn on AI summaries" })).toHaveTextContent(/names and other free text cannot be spotted/);
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keep it off" }));
    expect(screen.queryByRole("group", { name: "Turn on AI summaries" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("PUT"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Turn on AI summaries" }));
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(calls.filter((c) => c === "PUT /v1/task-summary-consent")).toHaveLength(1));
  });

  it("shows the written summary under the warning label with delete and off controls", async () => {
    const calls = stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, summary: summary({ consent: true, state: "ready", text: "It pulls totals out of invoices." }) }, "/v1/jobs/invoice-extract/summary": null });
    await show();
    expect(await screen.findByText("It pulls totals out of invoices.")).toBeInTheDocument();
    expect(screen.getByText(/Written by AI from a few of your sample calls/)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeChecked();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete this summary" }));
    expect(screen.getByRole("group", { name: "Delete this summary" })).toHaveTextContent(/cannot be brought back/);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete this summary" }));
    await user.click(screen.getByRole("button", { name: "Delete summary" }));
    await waitFor(() => expect(calls.filter((c) => c === "DELETE /v1/jobs/invoice-extract/summary")).toHaveLength(1));
  });

  it("says calmly when no sample text is kept or the server has no AI set up", async () => {
    stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, summary: summary({ consent: true, state: "no_samples" }) } });
    await show();
    expect(await screen.findByText(/No sample text kept, so no summary/)).toBeInTheDocument();
  });

  it("explains each layer in the help bubble", async () => {
    stubApi({ "/v1/jobs/invoice-extract/profile": { ...facts, summary: summary({ state: "unavailable" }) } });
    await show();
    expect(await screen.findByText(/not set up on this server/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "What is in this box?" }));
    expect(screen.getByText(/Three layers/)).toBeInTheDocument();
  });
});
