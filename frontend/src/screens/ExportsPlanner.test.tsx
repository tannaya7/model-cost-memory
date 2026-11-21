/** The planner's shareable link and file, and the cost-by-feature file: a link holds only what the person typed, a bad link is refused in words,
 *  and the download buttons appear only for people the server would let download. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import CostAnalysis from "./CostAnalysis";
import CostPlanner, { draftFromParams, draftToParams } from "./CostPlanner";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const csv = () => new Response("﻿a,b\r\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="x.csv"', "x-export-rows": "2", "x-export-neutralized": "0" } });
const draft = { job: "t", days: "30", calls: ["100", "200", ""], retry: "20", input: "", output: "-5", farOut: true, period: "week" as const };

function Probe() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}{l.search}</p>;
}

describe("the link", () => {
  it("holds only what was typed, and leaves empty boxes out", () => {
    const p = draftToParams(draft);
    expect(p).toEqual({ task: "t", days: "30", period: "week", tasks: "100,200", retry: "20", output: "-5", farout: "1" });
    expect(Object.keys(p).sort()).toEqual(["days", "farout", "output", "period", "retry", "task", "tasks"]);
  });
  it("round-trips, falls back on anything unknown, and is empty without a task", () => {
    expect(draftFromParams(new URLSearchParams(draftToParams(draft)))).toEqual(draft);
    const odd = draftFromParams(new URLSearchParams("task=t&days=9999&period=decade&tasks=1,2,3,4,5"));
    expect(odd).toEqual(expect.objectContaining({ days: "30", period: "month", calls: ["1", "2", "3"] }));
    expect(draftFromParams(new URLSearchParams("days=30"))).toBeNull();
  });
});

function server(role = "owner") {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith("/v1/projects")) return json([{ project_id: "acme", slug: "acme", name: "Acme", role }]);
    if (url.startsWith("/v1/jobs")) return json([{ name: "t", description: null }]);
    if (url.includes("/export.csv")) return csv();
    if (url.startsWith("/v1/insights/planner")) {
      return json({ job: "t", check_kind: "ANSWER_KEY", success_definition: "s", currency: "USD", period_label: "week", period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z", period_days: 30, timezone: "UTC",
        truncated: false, assumptions: [], observed_retry_rate: null, models: [], not_tested: [], notes: [], disclaimer: "not a bill" });
    }
    if (url.startsWith("/v1/insights/features")) return json({ currency: "USD", timezone: "UTC", period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z", period_days: 30, rows: [], total_runs: 0, labelled_runs: 0, labelled_share: null, truncated: false, notes: [] });
    return json({ detail: "x" }, 404);
  }));
  return urls;
}

describe("Cost planner link and file", () => {
  it("opens a link and calculates at once, with the typed numbers", async () => {
    const urls = server();
    renderWithProviders(<WithProject id="acme"><CostPlanner /><Probe /></WithProject>, { route: "/planner?task=t&tasks=100,200&retry=20&period=week" });
    await waitFor(() => expect(urls.some((u) => u.startsWith("/v1/insights/planner"))).toBe(true));
    const sent = urls.find((u) => u.startsWith("/v1/insights/planner")) as string;
    expect(sent).toContain("retry_rate=0.2");
    expect(sent).toContain("period=week");
    expect(sent.match(/calls=/g)).toHaveLength(2);
  });

  it("refuses a bad link in words and sends nothing", async () => {
    const urls = server();
    renderWithProviders(<WithProject id="acme"><CostPlanner /></WithProject>, { route: "/planner?task=t&tasks=0" });
    expect(await screen.findByTestId("planner-error")).toHaveTextContent("whole numbers");
    expect(urls.some((u) => u.startsWith("/v1/insights/planner"))).toBe(false);
  });

  it("writes the numbers into the address when calculating, and copies the link", async () => {
    server();
    const write = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
    renderWithProviders(<WithProject id="acme"><CostPlanner /><Probe /></WithProject>);
    await screen.findByLabelText("Task");
    await userEvent.type(screen.getByLabelText(/Retries/), "30");
    await userEvent.click(screen.getByRole("button", { name: "Calculate" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("retry=30"));
    expect(screen.getByTestId("where")).toHaveTextContent("task=t");
    await userEvent.click(await screen.findByRole("button", { name: "Copy link to this scenario" }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("copy-note")).toHaveTextContent("only the numbers you typed");
  });

  it("says so when the link could not be copied", async () => {
    server();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => { throw new Error("no"); } } });
    renderWithProviders(<WithProject id="acme"><CostPlanner /></WithProject>, { route: "/planner?task=t&tasks=100" });
    await userEvent.click(await screen.findByRole("button", { name: "Copy link to this scenario" }));
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  });

  it("downloads the same scenario the screen shows, as a file, for an owner", async () => {
    const urls = server("owner");
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderWithProviders(<WithProject id="acme"><CostPlanner /></WithProject>, { route: "/planner?task=t&tasks=100,200&retry=20" });
    await userEvent.click(await screen.findByRole("button", { name: /Download scenarios \(CSV\)/ }));
    await waitFor(() => expect(urls.some((u) => u.includes("/planner/export.csv"))).toBe(true));
    const screenQuery = (urls.find((u) => u.startsWith("/v1/insights/planner?")) as string).split("?")[1];
    const fileQuery = (urls.find((u) => u.includes("/planner/export.csv")) as string).split("?")[1];
    expect(fileQuery).toBe(screenQuery);
    expect(await screen.findByText(/Saved 2 rows/)).toBeInTheDocument();
  });

  it("leaves the download button out for a member, who the server would refuse", async () => {
    server("member");
    renderWithProviders(<WithProject id="acme"><CostPlanner /></WithProject>, { route: "/planner?task=t&tasks=100" });
    await screen.findByRole("button", { name: "Copy link to this scenario" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Download scenarios/ })).not.toBeInTheDocument());
  });
});

describe("Cost analysis file", () => {
  it("offers the cost-by-feature file to an admin, for the period on screen", async () => {
    const urls = server("admin");
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderWithProviders(<WithProject id="acme"><CostAnalysis /></WithProject>);
    await userEvent.click(await screen.findByRole("button", { name: /Download \(CSV\)/ }));
    await waitFor(() => expect(urls).toContain("/v1/insights/features/export.csv?days=30"));
  });

  it("leaves it out for a viewer", async () => {
    server("viewer");
    renderWithProviders(<WithProject id="acme"><CostAnalysis /></WithProject>);
    await screen.findByRole("heading", { level: 1, name: "Cost analysis" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Download \(CSV\)/ })).not.toBeInTheDocument());
  });
});
