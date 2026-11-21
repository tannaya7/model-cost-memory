/** Stopping a trial from its progress page: it asks first, says what is kept and what is still paid for, and sends one request. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { WithProject } from "../../../app/project";
import type { RetestStatus } from "../../../shared/api/types";
import { RetestProgress } from "./RetestProgress";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const trial = (over: Partial<RetestStatus> = {}) => ({
  retest_id: "11111111-1111-1111-1111-111111111111", job: "invoice-extract", candidate_model: "mini", trigger: "MANUAL", status: "RUNNING", budget_usd: 1, spent_usd: 0.1,
  runs_planned: 20, runs_done: 6, passed: 5, failed: 1, pass_rate: 0.83, monthly_cap_usd: 10, cap_remaining_usd: 9, message: null,
  created_at: "2026-11-20T10:00:00Z", started_at: "2026-11-20T10:00:01Z", finished_at: null, stopping: false, ...over,
}) as RetestStatus;

function mount(retest: RetestStatus, role: string = "owner") {
  const stops: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/stop")) {
      stops.push(`${init?.method} ${url}`);
      return json({ ...retest, status: retest.status === "QUEUED" ? "STOPPED_USER" : "RUNNING", stopping: retest.status === "RUNNING" });
    }
    if (url.startsWith("/v1/projects")) return json([{ project_id: "acme", name: "Acme", role, slug: "acme" }]);
    return json([]);
  }));
  renderWithProviders(<WithProject id="acme"><RetestProgress retest={retest} /></WithProject>);
  return stops;
}

describe("Stop this trial", () => {
  it("asks first, in the page, and says what is kept and what is still paid for", async () => {
    const stops = mount(trial());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop this trial" }));
    expect(screen.getByText(/No new prompts will be sent/)).toBeInTheDocument();
    expect(screen.getByText(/you pay your provider for them/)).toBeInTheDocument();
    expect(screen.getByText(/The 6 already replayed are kept/)).toBeInTheDocument();
    expect(stops).toHaveLength(0); // asking sends nothing
    await user.click(screen.getByRole("button", { name: "Keep it running" }));
    expect(screen.getByRole("button", { name: "Stop this trial" })).toBeInTheDocument();
    expect(stops).toHaveLength(0);
  });

  it("sends exactly one stop request once confirmed, then says it is stopping", async () => {
    const stops = mount(trial());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop this trial" }));
    await user.click(screen.getByRole("button", { name: "Stop the trial" }));
    await waitFor(() => expect(stops).toEqual(["POST /v1/jobs/invoice-extract/retest/11111111-1111-1111-1111-111111111111/stop"]));
    expect(await screen.findByText(/Stopping: no new prompts are sent/)).toBeInTheDocument();
  });

  it("tells a trial that has not started that nothing was sent and nothing is charged", async () => {
    mount(trial({ status: "QUEUED", runs_done: 0 }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Stop this trial" }));
    expect(screen.getByText(/has not started, so nothing has been sent and nothing will be charged/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep it waiting" })).toBeInTheDocument();
  });

  it("shows no stop button on a finished trial, and labels one a person stopped", async () => {
    mount(trial({ status: "STOPPED_USER", finished_at: "2026-11-20T10:05:00Z", message: "Stopped by you. The calls already sent were kept." }));
    expect(await screen.findByText("Stopped by you")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop this trial" })).toBeNull();
  });

  it("is not offered to someone who may only read", async () => {
    mount(trial(), "member");
    await screen.findByText("Your trial on a new model");
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByRole("button", { name: "Stop this trial" })).toBeNull();
  });
});
