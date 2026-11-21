/** The two new top-level pages, MCP & Agents and Cost analysis: they assemble parts that already exist, say they are analysis only, ask for the same
 *  period, and never claim to change or stop anything. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import CostAnalysis from "./CostAnalysis";
import McpAgents from "./McpAgents";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function server() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return json({ detail: "not under test" }, 404);
  }));
  return urls;
}

describe("MCP & Agents", () => {
  it("has its own heading, says it is analysis only, and explains exact, inferred and estimated", async () => {
    server();
    renderWithProviders(<WithProject id="acme"><McpAgents /></WithProject>);
    expect(screen.getByRole("heading", { level: 1, name: "MCP & Agents" })).toBeInTheDocument();
    expect(screen.getByText(/never connects to, stops or changes your agents, your MCP servers, your app or your models/)).toBeInTheDocument();
    const legend = screen.getByText("Inferred").closest("dl") as HTMLElement;
    expect(legend).toHaveAttribute("aria-label", "How to read the labels on this page");
    expect(screen.getByText("Exact")).toBeInTheDocument();
    expect(screen.getByText("Estimated")).toBeInTheDocument();
    expect(legend).toHaveTextContent("Shown as \"Likely\", never as certain");
    expect(legend).toHaveTextContent("a tool's own tokens are unknown unless said otherwise");
  });

  it("shows the three parts, each under its own heading", async () => {
    server();
    renderWithProviders(<WithProject id="acme"><McpAgents /></WithProject>);
    for (const name of ["What is using your tokens", "Agent tasks", "MCP and tool servers"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
  });

  it("lets the reader set their own repeat rule, calls it their choice, and never calls a repeat waste", async () => {
    server();
    renderWithProviders(<WithProject id="acme"><McpAgents /></WithProject>);
    expect(screen.getByText("Your choice, not a measured limit.")).toBeInTheDocument();
    expect(screen.getByLabelText("Number of repeats")).toHaveValue("5");
    expect(screen.getByText(/Possible repeats are not waste/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bwasted\b|\bwaste of\b/i);
  });

  it("asks every part for the period the reader chose", async () => {
    const urls = server();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><McpAgents /></WithProject>);
    await waitFor(() => expect(urls.some((u) => u.includes("days=30"))).toBe(true));
    urls.length = 0;
    await user.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(urls.some((u) => u.includes("days=7"))).toBe(true));
    expect(urls.every((u) => !u.includes("days=30"))).toBe(true);
  });
});

describe("Cost analysis", () => {
  it("has its own heading and says every figure is an estimate that changes nothing", async () => {
    server();
    renderWithProviders(<WithProject id="acme"><CostAnalysis /></WithProject>);
    expect(screen.getByRole("heading", { level: 1, name: "Cost analysis" })).toBeInTheDocument();
    expect(screen.getByText(/Estimates from recorded calls at list prices, not your invoice. Nothing here changes your app or your models/)).toBeInTheDocument();
    expect(screen.getByText("No dollar figure is a promise")).toBeInTheDocument();
  });

  it("shows how the spend was worked out, where the tokens went, and cost by feature label", async () => {
    server();
    renderWithProviders(<WithProject id="acme"><CostAnalysis /></WithProject>);
    for (const name of ["How the spend was worked out", "Where your tokens went", "Cost by your own feature labels"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
  });

  it("asks the feature costs for the chosen period", async () => {
    const urls = server();
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><CostAnalysis /></WithProject>);
    await waitFor(() => expect(urls).toContain("/v1/insights/features?days=30"));
    await user.click(screen.getByRole("tab", { name: "90 days" }));
    await waitFor(() => expect(urls).toContain("/v1/insights/features?days=90"));
  });
});
