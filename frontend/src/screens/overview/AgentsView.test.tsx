import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import type { AgentInsights, AgentUsage, ToolsUsage, TraceUsage } from "../../features/insights/api/agentsApi";
import { AgentsView, ToolListBody } from "./AgentsView";
import { agentBadges, agentName, loopText, toolListTip, usedText } from "./agentView";
import type { Ctx, ShellProps } from "./widgets";

afterEach(() => vi.unstubAllGlobals());

const shell = { id: "agents", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
const ctx = { days: 30 } as unknown as Ctx;

const agent = (o: Partial<AgentUsage> = {}): AgentUsage => ({
  agent: "researcher", runs: 30, tokens_in: 1000, tokens_out: 100, cache_read_tokens: 0, spend_usd: 2.5, share: 0.7, models: ["acme-large"],
  uses_tools: true, works_like_agent: "yes", tool_source: "tool_list", tool_servers: [], top_tools: [{ name: "search_docs", calls: 12 }], steps_per_task: 4.2, ...o,
});
const trace = (o: Partial<TraceUsage> = {}): TraceUsage => ({
  trace_id: "task-1", calls: 9, tokens: 5000, spend_usd: 1.2, agents: 1, repeated_prompts: false, agent_names: ["researcher"], multi_agent: false, possible_loop: null, ...o,
});
const tool = (o: Partial<ToolsUsage> = {}): ToolsUsage => ({ job: "invoice-extract", runs: 50, avg_tools_tokens: 12000, share_of_tokens_in: 0.4, ...o });
const reply = (o: Partial<AgentInsights> = {}): AgentInsights => ({
  agents: [agent()], traces: [trace()], tools: [tool()],
  kinds: { calls: 30, uses_tools: true, works_like_agent: "yes", tool_source: "tool_list", tool_servers: [], multi_agent: false }, ...o,
});

describe("agent wording", () => {
  it("names unlabelled calls Unnamed agent", () => {
    expect(agentName("unlabelled")).toBe("Unnamed agent");
    expect(agentName("code-writer")).toBe("Code writer");
  });

  it("says probably when not certain and never claims MCP for a plain tool list", () => {
    expect(agentBadges(agent({ works_like_agent: "probably" })).map((b) => b.text)).toContain("Might look like an agent");
    const plain = agentBadges(agent()).map((b) => b.text).join(" ");
    expect(plain).toContain("Has a tool list");
    expect(plain).not.toMatch(/MCP|server/i);
    expect(agentBadges(agent({ tool_source: "mcp", tool_servers: ["github"] })).map((b) => b.text)).toContain("Tool names look like tool servers (MCP): github");
  });

  it("only gives the tool-list tip from 10,000 tokens", () => {
    expect(toolListTip(tool({ avg_tools_tokens: 9999 }))).toBeNull();
    expect(toolListTip(tool({ avg_tools_tokens: 10000 }))).toMatch(/may be large/);
  });

  it("marks the agent and tool-server badges as not sure", () => {
    expect(agentBadges(agent({ works_like_agent: "yes" })).find((b) => b.id === "agent")).toMatchObject({ text: "Looks like an agent", sure: false });
    expect(agentBadges(agent({ tool_source: "mcp", tool_servers: [] })).find((b) => b.id === "mcp")).toMatchObject({ text: "Tool names look like tool servers (MCP)", sure: false });
  });

  it("words money by billing mode: dollars per use, tokens for a subscription, both labelled", () => {
    expect(usedText(1.2, 5000, "per_use")).toBe("$1.20");
    expect(usedText(1.2, 5000, "subscription")).toBe("5,000 tokens");
    expect(usedText(1.2, 5000, "both")).toBe("5,000 tokens · $1.20 at list prices");
    const t = trace({ possible_loop: { step: "the search tool", repeats: 6, cost_usd: 1.9, uses_arguments: false } });
    expect(loopText(t, "per_use")).toMatch(/costing about \$1\.90\./);
    expect(loopText(t, "subscription")).not.toMatch(/\$|cost/);
    expect(loopText(t, "both")).toMatch(/at list prices/);
    expect(toolListTip(tool(), "subscription")).toMatch(/use fewer tokens/);
    expect(toolListTip(tool(), "per_use")).toMatch(/lower the cost/);
  });

  it("describes a possible loop softly", () => {
    const t = trace({ possible_loop: { step: "the search tool", repeats: 6, cost_usd: 1.9, uses_arguments: false } });
    expect(loopText(t)).toMatch(/^Possible loop: the search tool ran 6 times/);
    expect(loopText(trace())).toBeNull();
  });
});

describe("AgentsView", () => {
  it("shows share, tools, steps, models and the heaviest task", async () => {
    stubApi({ "/v1/insights/agents": reply() });
    renderWithProviders(<AgentsView ctx={ctx} shell={shell} />);
    expect(await screen.findByText("70% of your tokens")).toBeInTheDocument();
    expect(screen.getByText("Researcher")).toBeInTheDocument();
    expect(screen.getByText(/about 4.2 steps per task/)).toBeInTheDocument();
    expect(screen.getByText(/Models: acme-large/)).toBeInTheDocument();
    expect(screen.getByText(/Tools used most: search_docs \(12\)/)).toBeInTheDocument();
    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(screen.getByText(/about 12K tokens of tool list/)).toBeInTheDocument();
    expect(screen.getByText(/Estimate: size guessed/)).toBeInTheDocument();
    expect(screen.getByText(/may be large/)).toBeInTheDocument();
  });

  it("flags a possible loop as beta", async () => {
    stubApi({ "/v1/insights/agents": reply({ traces: [trace({ possible_loop: { step: "the search tool", repeats: 5, cost_usd: 0.4, uses_arguments: true } })] }) });
    renderWithProviders(<AgentsView ctx={ctx} shell={shell} />);
    expect(await screen.findByText(/Possible loop: the search tool ran 5 times/)).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("explains an empty project", async () => {
    stubApi({ "/v1/insights/agents": reply({ agents: [], traces: [], tools: [] }) });
    renderWithProviders(<AgentsView ctx={ctx} shell={shell} />);
    expect(await screen.findByText("No AI calls yet")).toBeInTheDocument();
  });

  it("asks for 25 calls before showing shares", async () => {
    stubApi({ "/v1/insights/agents": reply({ agents: [agent({ runs: 10 })] }) });
    renderWithProviders(<AgentsView ctx={ctx} shell={shell} />);
    expect(await screen.findByText("Not enough AI calls yet")).toBeInTheDocument();
    expect(screen.getByText(/at least 25/)).toBeInTheDocument();
    expect(screen.queryByText(/of your tokens/)).toBeNull();
  });

  it("explains when no call names an agent", async () => {
    stubApi({ "/v1/insights/agents": reply({ agents: [agent({ agent: "unlabelled", works_like_agent: null, uses_tools: false, tool_source: null, top_tools: [], steps_per_task: null })] }) });
    renderWithProviders(<AgentsView ctx={ctx} shell={shell} />);
    expect(await screen.findByText("Unnamed agent")).toBeInTheDocument();
    expect(screen.getByText(/None of your calls name an agent/)).toBeInTheDocument();
  });

  it("has a Help button explaining agents", async () => {
    stubApi({ "/v1/insights/agents": reply() });
    renderWithProviders(<AgentsView ctx={ctx} shell={shell} />);
    expect((await screen.findAllByRole("button", { name: "What does this mean?" })).length).toBeGreaterThan(0);
  });
});

describe("ToolListBody", () => {
  it("shows the size for one task, labelled as an estimate", async () => {
    stubApi({ "/v1/insights/agents": reply() });
    renderWithProviders(<ToolListBody job="invoice-extract" days={30} />);
    expect(await screen.findByText(/about 12K tokens of tool list/)).toBeInTheDocument();
    expect(screen.getByText(/Estimate: size guessed/)).toBeInTheDocument();
  });

  it("says so when the task sends no tool list", async () => {
    stubApi({ "/v1/insights/agents": reply() });
    renderWithProviders(<ToolListBody job="other" days={30} />);
    expect(await screen.findByText(/does not send a tool list/)).toBeInTheDocument();
  });
});
