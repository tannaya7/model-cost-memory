/** MCP and tool servers: provider-reported versus likely, exact counts, usage labelled as the whole request's, unsupported cases
 * shown as unknown, and never a claim about tokens per tool. Analysis only: there is nothing to click that changes anything. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithProject } from "../../app/project";
import { renderWithProviders } from "../../test/render";
import type { McpServer, McpSupport, ToolServersAnswer } from "../../features/insights/api/toolServersApi";
import { CERTAINTY, NATIVE, ToolServers, ToolServersBody } from "./ToolServers";
import type { ShellProps } from "./widgets";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const server = (o: Partial<McpServer> = {}): McpServer => ({
  server: "github", certainty: "provider_reported", calls: 412, failed_calls: 9, failure_known_calls: 380, requests: 260, task_runs: 118,
  first_seen: "2026-10-20T10:00:00Z", last_seen: "2026-11-17T09:00:00Z", request_time_ms: 4200, request_tokens_in: 1_240_000,
  request_tokens_out: 96_000, request_cache_read_tokens: 410_000, request_cost_usd: 18.42, unpriced_requests: 0,
  tools: [{ name: "search_issues", calls: 240 }, { name: "create_issue", calls: 120 }], tasks: [{ name: "invoice-extract", calls: 300 }], providers: ["anthropic"], ...o,
});
const support = (o: Partial<McpSupport> = {}): McpSupport => ({
  key: "anthropic", label: "Anthropic", native: "supported", seen_as: "anthropic", checked_on: "2026-11-18", we_read: ["`mcp_tool_use` blocks"],
  we_do_not_read: ["`mcp_tool_listing` blocks: not recorded yet"], not_reported_by_provider: ["tokens per tool or per server: the response has one `usage` object for the whole request"],
  limits: ["The token-counting endpoint returns an error for requests that use the MCP connector."], sources: ["https://platform.claude.com/docs/en/agents-and-tools/mcp-connector"], ...o,
});
const answer = (o: Partial<ToolServersAnswer> = {}): ToolServersAnswer => ({
  days: 30, since: "2026-10-19T00:00:00Z", until: "2026-11-18T00:00:00Z", job: null, mode: "per_use", servers: [server()],
  own_tools: { calls: 0, requests: 0, tools: [] },
  totals: { requests: 260, requests_with_several_servers: 0, tokens_in: 1_240_000, tokens_out: 96_000, cache_read_tokens: 410_000, cost_usd: 18.42, unpriced_requests: 0 },
  support: [support()], unreadable_calls: 0, truncated: false, notes: [],
  method: ["Counts are exact: every tool call the recorder read from a response, once each."], tool_list_size: "unknown", ...o,
} as ToolServersAnswer);

function mount(body: unknown, status = 200, days = 30) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return url.startsWith("/v1/insights/tool-servers") ? json(body, status) : json([]);
  }));
  renderWithProviders(<WithProject id="acme"><ToolServersBody days={days} /></WithProject>);
  return urls;
}

describe("how sure we are that it is MCP", () => {
  it("says provider-reported, likely and both in different words and marks, not colour alone", () => {
    expect(CERTAINTY.provider_reported.label).toBe("Reported by the provider");
    expect(CERTAINTY.likely.label).toBe("Likely MCP: guessed from the tool name");
    expect(CERTAINTY.mixed.label).toContain("also guessed from names");
    expect(new Set(Object.values(CERTAINTY).map((c) => c.mark)).size).toBe(3);
  });

  it("a name-only server is labelled likely on the card, never as certain", async () => {
    mount(answer({ servers: [server({ server: "slack", certainty: "likely", failure_known_calls: 0, failed_calls: 0 })] }));
    const card = await screen.findByTestId("server-card");
    expect(card).toHaveTextContent("slack");
    expect(card).toHaveTextContent("? Likely MCP: guessed from the tool name");
    expect(card).not.toHaveTextContent("Reported by the provider");
  });
});

describe("what a server card says", () => {
  it("shows exact counts, the tasks it came from, its tools and when it was last seen", async () => {
    mount(answer());
    const card = await screen.findByTestId("server-card");
    expect(card).toHaveTextContent("✓ Reported by the provider");
    expect(card).toHaveTextContent("412 calls in 260 requests, over 118 task runs. Last seen 17 Nov 2026.");
    expect(card).toHaveTextContent("9 of the 380 calls whose result said so failed.");
    expect(card).toHaveTextContent("search_issues ×240");
    expect(within(card).getByRole("link", { name: "invoice-extract" }).getAttribute("href")).toContain("/jobs/invoice-extract");
  });

  it("says when failures are not recorded instead of showing zero", async () => {
    mount(answer({ servers: [server({ failure_known_calls: 0, failed_calls: 0 })] }));
    expect(await screen.findByText(/Whether calls failed is not recorded\./)).toBeInTheDocument();
  });

  it("labels time and usage as the whole request's and never as the tool's", async () => {
    mount(answer());
    const card = await screen.findByTestId("server-card");
    expect(card).toHaveTextContent("4.2 s in the middle. This is the whole request, not the tool.");
    expect(card).toHaveTextContent("1.2M tokens in, 96K out, 410K read from the cache, $18.42");
    expect(card).toHaveTextContent("Shared with everything else in them. Not what the tool used.");
  });

  it("a time that was not reported says so", async () => {
    mount(answer({ servers: [server({ request_time_ms: null })] }));
    expect(await screen.findByTestId("server-card")).toHaveTextContent("Time of those requests: not reported");
  });

  it("an unknown cost says so and unpriced requests are counted, not treated as free", async () => {
    mount(answer({ servers: [server({ request_cost_usd: null })] }));
    expect(await screen.findByTestId("server-card")).toHaveTextContent("cost not known");
    mount(answer({ servers: [server({ unpriced_requests: 4 })] }));
    await waitFor(() => expect(screen.getAllByTestId("server-card").some((c) => /4 requests have no known price/.test(c.textContent ?? ""))).toBe(true));
  });
});

describe("totals and double counting", () => {
  it("counts each request once and says the rows add up to more when requests were shared", async () => {
    mount(answer({ totals: { requests: 280, requests_with_several_servers: 11, tokens_in: 1_300_000, tokens_out: 101_000, cache_read_tokens: 0, cost_usd: 19.3, unpriced_requests: 0 } }));
    const t = await screen.findByTestId("totals");
    expect(t).toHaveTextContent("Across all servers: 280 requests, each counted once.");
    expect(t).toHaveTextContent("11 of them used more than one server, so the rows above add up to more than this");
  });

  it("says nothing about sharing when no request was shared", async () => {
    mount(answer());
    expect(await screen.findByTestId("totals")).not.toHaveTextContent("add up to more");
  });
});

describe("what is not attributed or not known", () => {
  it("always says the tool list size is unknown, not estimated", async () => {
    mount(answer());
    expect(await screen.findByTestId("tool-list-unknown")).toHaveTextContent("providers load it themselves and report one usage total, so it cannot be split by server. It is unknown, not estimated.");
  });

  it("never claims tokens per tool, a per-tool cost or a saving", async () => {
    mount(answer({ own_tools: { calls: 96, requests: 70, tools: [{ name: "lookup_customer", calls: 60 }] } }));
    await screen.findByTestId("server-card");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/tokens (this|the) tool (used|cost)|cost per tool|per-tool cost|you could save|wasted/i);
    expect(screen.queryByRole("button", { name: /block|disable|remove|turn off|switch|apply|fix/i })).toBeNull();
  });

  it("lists each provider's support, what is not read, what the provider does not report and the check date, with safe source links", async () => {
    const user = userEvent.setup();
    mount(answer({ support: [support(), support({ key: "google", label: "Google (Gemini)", native: "unknown", seen_as: "gemini", sources: ["https://ai.google.dev/gemini-api/docs/function-calling"],
      we_do_not_read: ["Interactions API steps: not recorded yet"], not_reported_by_provider: ["On the pages checked, a response shape for MCP calls is not documented, so it is unknown, not assumed"], limits: [] })] }));
    await user.click(await screen.findByText("What each provider tells us, and what stays unknown"));
    const s = screen.getByTestId("support");
    expect(s).toHaveTextContent("Anthropic: Reports MCP calls in its own response. Checked 18 Nov 2026.");
    expect(s).toHaveTextContent("We do not read: `mcp_tool_listing` blocks: not recorded yet.");
    expect(s).toHaveTextContent("Not reported by the provider: tokens per tool or per server");
    expect(s).toHaveTextContent("Limits: The token-counting endpoint returns an error for requests that use the MCP connector.");
    expect(s).toHaveTextContent("Google (Gemini): Unknown: not documented or not recorded.");
    expect(s).toHaveTextContent("is not documented, so it is unknown, not assumed");
    for (const a of within(s).getAllByRole("link")) {
      expect(a).toHaveAttribute("target", "_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
      expect(new URL(a.getAttribute("href")!).protocol).toBe("https:");
    }
    expect(NATIVE.unknown).toContain("Unknown");
  });

  it("explains how every number is worked out", async () => {
    const user = userEvent.setup();
    mount(answer());
    await user.click(await screen.findByText("How these numbers are worked out"));
    expect(screen.getByText("Counts are exact: every tool call the recorder read from a response, once each.")).toBeInTheDocument();
  });
});

describe("other tools, empty, missing and broken", () => {
  it("separates the app's own tools from MCP", async () => {
    mount(answer({ own_tools: { calls: 96, requests: 70, tools: [{ name: "lookup_customer", calls: 60 }, { name: "calculate_total", calls: 36 }] } }));
    expect(await screen.findByTestId("own-tools")).toHaveTextContent("Other tools your app calls, not an MCP server we can recognise: 96 calls in 70 requests (lookup_customer ×60, calculate_total ×36).");
  });

  it("with no tool calls it says so, never a blank card", async () => {
    mount(answer({ servers: [], notes: ["No tool calls were recorded in this period."], totals: { requests: 0, requests_with_several_servers: 0, tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cost_usd: null, unpriced_requests: 0 } }));
    expect(await screen.findByTestId("no-servers")).toHaveTextContent("No tool calls were recorded in this period.");
  });

  it("with tool calls but no recognisable MCP server it explains why none is shown", async () => {
    mount(answer({ servers: [], own_tools: { calls: 5, requests: 3, tools: [{ name: "lookup", calls: 5 }] }, notes: ["Tool calls were recorded, but none came from an MCP server we can recognise: none was named by the provider and no tool name looks like mcp__server__tool. A tool-server call under another name cannot be seen."] }));
    expect(await screen.findByTestId("no-servers")).toHaveTextContent("none came from an MCP server we can recognise");
  });

  it("malformed records and truncation are said out loud when the server reports them", async () => {
    mount(answer({ notes: ["8 tool-call records could not be read (not a list, or without a name) and are left out.", "Only the newest 50,000 tool calls were read."] }));
    const notes = await screen.findByTestId("notes");
    expect(notes).toHaveTextContent("8 tool-call records could not be read");
    expect(notes).toHaveTextContent("Only the newest 50,000 tool calls were read.");
  });

  it("a failed request or a non-answer is an error with a retry, never an empty card", async () => {
    mount({ detail: "boom" }, 500);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("an answer that is not a tool-servers object is an error", async () => {
    mount([]);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("a flat-fee plan has no dollars", () => {
  it("shows usage in tokens and no dollar figure when the server sends none", async () => {
    mount(answer({ mode: "subscription", servers: [server({ request_cost_usd: null })], totals: { requests: 260, requests_with_several_servers: 0, tokens_in: 1_240_000, tokens_out: 96_000, cache_read_tokens: 0, cost_usd: null, unpriced_requests: 0 } }));
    await screen.findByTestId("server-card");
    expect(document.body.textContent).not.toMatch(/\$|cost not known|no known price/);
    expect(screen.getByTestId("server-card")).toHaveTextContent("1.2M tokens in");
  });
});

describe("the widget", () => {
  it("asks for the chosen period", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return url.startsWith("/v1/insights/tool-servers") ? json(answer()) : json([]);
    }));
    const shell = { id: "tool-servers", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><ToolServers shell={shell} /></WithProject>);
    await user.click(await screen.findByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(urls.some((u) => u.includes("days=7"))).toBe(true));
    expect(urls[0]).toContain("days=30");
    expect(screen.getByText(/Analysis only: nothing is called, blocked or changed\./)).toBeInTheDocument();
  });
});
