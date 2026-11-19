import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import type { PromptGroup, PromptGroups, TokenPart } from "../../features/insights/api/promptsApi";
import { TokensWent, anatomy, periodText } from "./TokensWent";
import { TokensTab } from "../job/TokensTab";
import { WithProject } from "../../app/project";
import type { Ctx, ShellProps } from "./widgets";

afterEach(() => vi.unstubAllGlobals());

const shell = { id: "tokens-went", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
const ctx = { days: 30 } as unknown as Ctx;

const part = (key: TokenPart["key"], label: string, tokens: number | null, state: TokenPart["state"] = "measured", calls: number | null = null): TokenPart =>
  ({ key, label, tokens, state, calls, note: null });

const g = (o: Partial<PromptGroup> = {}): PromptGroup => ({
  job: "invoice-extract", prompt_version: "v3", calls: 120, tokens_in: 240000, tokens_out: 12000, cache_read_tokens: 0, cache_write_tokens: 0,
  total_tokens: 252000, share: 0.62, avg_tokens_in: 2000, avg_tokens_out: 100, cache_read_share: null, text_samples: 20,
  repeated_start_share: 0.6, repeated_end_share: 0.1, repeated_start_preview: null,
  label: "invoice-extract · version v3", group_by: "task_version", agent: null, ledger_calls: 120, no_usage_calls: 0, legacy_calls: 0, text_calls: 120, text_note: null,
  breakdown: [
    part("input", "Input (not cached)", 240000), part("cached_input", "Cached input read", null, "not_reported"), part("cache_write", "Cache writes", null, "not_reported"),
    part("output", "Output", 12000), part("reasoning", "of which reasoning", null, "not_reported"), part("tool_use_input", "Tool-use input", null, "not_reported"),
  ],
  ...o,
});
const reply = (groups: PromptGroup[], total = 400000, extra: Partial<PromptGroups> = {}): PromptGroups => ({
  days: 30, total_tokens: total, groups, period_start: "2026-10-18T10:00:00Z", period_end: "2026-11-17T10:00:00Z", timezone: "UTC",
  total_calls: 1240, group_by: "task_version", grouping_note: "Grouped by AI task and the prompt version your code tagged.", ...extra,
});

describe("TokensWent", () => {
  it("shows the group, anatomy, sample statement and tips", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText("62% of your tokens")).toBeInTheDocument();
    expect(screen.getByText("version v3")).toBeInTheDocument();
    expect(screen.getByText(/^120 calls · typically/)).toHaveTextContent("2,000 tokens in and 100 out");
    expect(screen.getByRole("img")).toHaveAccessibleName("60% same every time at the start, 30% changes each call, 10% same every time at the end");
    expect(screen.getByText("Ideas, not promises")).toBeInTheDocument();
    expect(screen.getByText(/Large repeated input observed/)).toBeInTheDocument();
    expect(screen.getByText(/On average about 2,000 tokens go in for 100 out/)).toBeInTheDocument();
    expect(screen.getAllByText("estimated from a sample").length).toBeGreaterThan(0);
    expect(screen.getByText("measured")).toBeInTheDocument();
  });

  it("says exactly which period and how many calls the totals cover, and that they are not a sample", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const line = await screen.findByTestId("coverage");
    expect(line).toHaveTextContent("18 Oct to 17 Nov 2026 (UTC).");
    expect(line).toHaveTextContent("Token totals count every one of the 1,240 AI calls in this period, not a sample.");
    expect(line).toHaveTextContent("Grouped by AI task and the prompt version your code tagged.");
  });

  it("says the repeated-text split is a sample of the newest calls, never the whole period", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ text_samples: 50, text_calls: 940 })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByTestId("sample-note")).toHaveTextContent("Estimated from the newest 50 of 940 calls with stored text: a sample, not the whole 30 days.");
  });

  it("when every stored call was used, says so without claiming a sample", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ text_samples: 20, text_calls: 20 })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const note = await screen.findByTestId("sample-note");
    expect(note).toHaveTextContent("Estimated from 20 calls with stored text.");
    expect(note.textContent).not.toMatch(/sample, not/);
  });

  it("explains an empty project", async () => {
    stubApi({ "/v1/insights/prompts": reply([], 0) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText("No AI calls yet")).toBeInTheDocument();
  });

  it("says the text was removed but still shows counts", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ text_samples: 0, text_calls: 0, repeated_start_share: null, repeated_end_share: null })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText(/removed after your retention period, so we can only show the counts/)).toBeInTheDocument();
    expect(screen.getByText("62% of your tokens")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("needs at least 5 stored calls for the split", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ text_samples: 3, text_calls: 3 })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText(/We need at least 5 stored calls to show the split/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows a skeleton while loading", () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    const { container } = renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("shows an error with a retry", async () => {
    stubApi({ "/v1/insights/prompts": new Response("{}", { status: 500 }) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("computes the anatomy shares and formats the period", () => {
    expect(anatomy(g({ repeated_start_share: 0.5, repeated_end_share: 0.2 }))).toEqual({ start: 0.5, changes: expect.closeTo(0.3), end: 0.2 });
    expect(anatomy(g({ text_samples: 4 }))).toBeNull();
    expect(periodText({ period_start: "2026-12-20T00:00:00Z", period_end: "2027-01-18T00:00:00Z", timezone: "UTC" })).toBe("20 Dec to 18 Jan 2027 (UTC)");
    expect(periodText({})).toBeNull();
  });
});

describe("what each total is made of", () => {
  it("shows a part only when a provider reported it, and names the rest instead of showing 0", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const box = await screen.findByTestId("breakdown");
    expect(box).toHaveTextContent("Input (not cached) 240K · Output 12K");
    expect(box).toHaveTextContent("Not available: Cached input read (not reported by the providers used); Cache writes (not reported by the providers used); reasoning (not reported by the providers used); Tool-use input (not reported by the providers used).");
    expect(box.textContent).not.toMatch(/\b0\b/);
  });

  it("shows reasoning and tool-use input with how many calls reported them", async () => {
    const rich = g({
      breakdown: [
        part("input", "Input (not cached)", 240000), part("cached_input", "Cached input read", 90000, "measured", 100), part("cache_write", "Cache writes", 6000, "measured", 80),
        part("output", "Output", 12000), part("reasoning", "of which reasoning", 3200, "measured", 60), part("tool_use_input", "Tool-use input", 800, "measured", 20),
      ],
    });
    stubApi({ "/v1/insights/prompts": reply([rich]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const box = await screen.findByTestId("breakdown");
    expect(box).toHaveTextContent("Cached input read 90K (100 calls reported)");
    expect(box).toHaveTextContent("of which reasoning 3,200 (60 calls reported)");
    expect(box).toHaveTextContent("Tool-use input 800 (20 calls reported)");
    expect(box.textContent).not.toContain("Not available");
  });

  it("calls a part unknown, not zero, when older calls could not record it", async () => {
    const old = g({
      legacy_calls: 40, no_usage_calls: 10, ledger_calls: 70,
      breakdown: [part("input", "Input (not cached)", 1000), part("output", "Output", 500), part("reasoning", "of which reasoning", null, "unknown"), part("tool_use_input", "Tool-use input", null, "unknown")],
    });
    stubApi({ "/v1/insights/prompts": reply([old]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const box = await screen.findByTestId("breakdown");
    expect(box).toHaveTextContent("reasoning (unknown for some or all of these calls)");
    expect(screen.getByText(/10 of 120 calls came back with no token counts, so their tokens are unknown; 40 were recorded before token parts were tracked\./)).toBeInTheDocument();
  });

  it("an older server with no breakdown still renders the row", async () => {
    const { breakdown: _b, label: _l, group_by: _g, ...legacy } = g();
    stubApi({ "/v1/insights/prompts": { days: 30, total_tokens: 400000, groups: [legacy] } });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    expect(await screen.findByText("62% of your tokens")).toBeInTheDocument();
    expect(screen.queryByTestId("breakdown")).toBeNull();
    expect(screen.getByTestId("coverage")).toHaveTextContent("Last 30 days.");
  });
});

describe("grouping is chosen, and says what it is", () => {
  it("asks the server for the grouping picked, with no prompt text", async () => {
    const calls = stubApi({ "/v1/insights/prompts": reply([g()]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    await screen.findByText("62% of your tokens");
    expect(calls[0]).toBe("GET /v1/insights/prompts?days=30&limit=3");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Agent" }));
    await screen.findByTestId("coverage");
    expect(calls.some((c) => c.includes("group_by=agent"))).toBe(true);
    expect(calls.every((c) => !c.includes("show_text"))).toBe(true);
  });

  it("an agent row is named as your code named it, has no task link and no repeated-text split", async () => {
    const agent = g({
      job: "", prompt_version: null, label: "planner", group_by: "agent", agent: "planner", text_samples: 0, text_calls: 0, repeated_start_share: null, repeated_end_share: null,
      text_note: "The repeated-text split is only worked out for one task and prompt version at a time.",
    });
    stubApi({ "/v1/insights/prompts": reply([agent], 400000, { group_by: "agent", grouping_note: "Grouped by the agent name your code sent. Calls with no agent name are grouped together." }) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Agent" }));
    expect(await screen.findByText("planner")).toBeInTheDocument();
    expect(screen.getByTestId("coverage")).toHaveTextContent("Grouped by the agent name your code sent");
    expect(screen.getByText(/only worked out for one task and prompt version at a time/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Compare prompt versions/ })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("prompt text is private unless asked for", () => {
  it("shows no prompt text by default, only an offer to show it", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    await screen.findByText("62% of your tokens");
    expect(screen.queryByText(/Every sampled call starts/)).toBeNull();
    expect(screen.getByRole("button", { name: "Show the repeated start" })).toBeInTheDocument();
    expect(screen.getByText(/this shows text from your prompts, with emails, links and keys hidden/)).toBeInTheDocument();
  });

  it("asks for the text only when the button is pressed, then shows it with a Hide button", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const shown = url.includes("show_text=true");
      return new Response(JSON.stringify(reply([g({ repeated_start_preview: shown ? "You are a careful [email] reader" : null })])), { status: 200, headers: { "content-type": "application/json" } });
    }));
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show the repeated start" }));
    expect(await screen.findByText(/Every sampled call starts: "You are a careful \[email\] reader"/)).toBeInTheDocument();
    expect(calls.filter((c) => c.includes("show_text=true"))).toHaveLength(1);
    expect(screen.getByText(/emails, links and keys are hidden/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(/Every sampled call starts/)).toBeNull();
  });

  it("says so when there is no clear repeated start to show", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ repeated_start_preview: null })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Show the repeated start" }));
    expect(await screen.findByText(/No clear repeated start to show/)).toBeInTheDocument();
  });

  it("switching the grouping hides revealed text again", async () => {
    stubApi({ "/v1/insights/prompts": reply([g({ repeated_start_preview: "Secret system prompt start" })]) });
    renderWithProviders(<TokensWent ctx={ctx} shell={shell} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show the repeated start" }));
    expect(await screen.findByText(/Secret system prompt start/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Task" }));
    await screen.findByTestId("coverage");
    expect(screen.queryByText(/Secret system prompt start/)).toBeNull();
  });
});

describe("TokensTab prompts section", () => {
  it("shows this task's prompts", async () => {
    stubApi({ "/v1/insights/prompts": reply([g()]), "/v1/insights/daily": [{ day: new Date().toISOString().slice(0, 10), job: "invoice-extract", model: "m", runs: 5, passed: 5, failed: 0, spend_usd: 1, tokens_in: 5000, tokens_out: 500, cache_read_tokens: 0, cache_write_tokens: 0 }] });
    renderWithProviders(<TokensTab job="invoice-extract" />);
    expect(await screen.findByText("62% of your tokens")).toBeInTheDocument();
    expect(within(screen.getByText("62% of your tokens").closest("li")!).getByText(/^120 calls · typically/)).toBeInTheDocument();
  });
});

describe("the receipt by agent, task and version", () => {
  const priced = (o: Partial<PromptGroup> = {}) => g({ spend_usd: 12.5, cost_share: 0.4, priced_calls: 120, unpriced_calls: 0, grouping_basis: "named_by_your_code", ...o });
  const project = (billing: string) => ({ project_id: "acme", name: "Acme", billing_mode: billing });
  const mount = () => renderWithProviders(<WithProject id="acme"><TokensWent ctx={ctx} shell={shell} /></WithProject>);

  it("a per-use project sees cost, its share of the priced cost, and that it is at list prices", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([priced()]) });
    mount();
    expect(await screen.findByTestId("cost-line")).toHaveTextContent("Cost $12.50 (40% of the priced cost), at list prices.");
  });

  it("a subscription sees a list price that is not a bill, never the word cost or a share of spending", async () => {
    stubApi({ "/v1/projects/acme": project("subscription"), "/v1/insights/prompts": reply([priced()]) });
    mount();
    const line = await screen.findByTestId("cost-line", {}, { timeout: 5000 });
    await vi.waitFor(() => expect(line).toHaveTextContent("List price $12.50 (40% of the priced list price), not your bill."));
    expect(line.textContent).not.toMatch(/\bCost\b|spend|saved/i);
  });

  it("an unknown cost is said to be unknown, never shown as $0", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([priced({ spend_usd: null, cost_share: null, priced_calls: 0, unpriced_calls: 120 })]) });
    mount();
    const line = await screen.findByTestId("cost-line");
    expect(line).toHaveTextContent("Cost unknown: no call in this row has a known price.");
    expect(line.textContent).not.toContain("$0");
  });

  it("says how many calls are missing from a cost that is partly known", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([priced({ priced_calls: 119, unpriced_calls: 1 })]) });
    mount();
    expect(await screen.findByTestId("cost-line")).toHaveTextContent("1 call has no known price and is not counted.");
  });

  it("labels calls with no version as an estimated grouping, and says their text is not compared", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([priced({ prompt_version: null, grouping_basis: "untagged" })]) });
    mount();
    const note = await screen.findByTestId("estimated-grouping");
    expect(note).toHaveTextContent("estimated grouping");
    expect(note).toHaveTextContent("These calls carry no version label, so they are grouped only by the labels they do have. Their prompt text is not compared.");
  });

  it("a row named by your code is not called estimated", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([priced()]) });
    mount();
    await screen.findByTestId("cost-line");
    expect(screen.queryByTestId("estimated-grouping")).toBeNull();
  });

  it("an untagged agent row says no agent name, not no version", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([priced({ group_by: "agent", label: "(no agent named)", agent: null, grouping_basis: "untagged", job: "", prompt_version: null })], 400000, { group_by: "agent" }) });
    mount();
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Agent" }));
    expect(await screen.findByTestId("estimated-grouping")).toHaveTextContent("These calls carry no agent name");
  });

  it("the receipt option asks the server for it and says it does not promise savings", async () => {
    const calls = stubApi({
      "/v1/projects/acme": project("per_use"),
      "/v1/insights/prompts": reply([priced({ group_by: "template", label: "planner · invoice-extract · version v3", agent: "planner" })], 400000, {
        group_by: "template", grouping_note: "Grouped by the agent, the AI task and the prompt version your code sent. Only those labels are used: prompt text is never read to decide a group, and no fingerprint of it is stored.",
      }),
    });
    mount();
    await screen.findByText("62% of your tokens"); // wait for the first answer: the loading view is replaced by it
    await userEvent.setup().click(await screen.findByRole("tab", { name: "Receipt: agent, task, version" }));
    const coverage = await screen.findByTestId("coverage");
    await vi.waitFor(() => expect(coverage).toHaveTextContent("It does not say that changing a template would save money."));
    expect(coverage).toHaveTextContent("no fingerprint of it is stored");
    await vi.waitFor(() => expect(calls.some((c) => c.includes("group_by=template"))).toBe(true));
    expect(calls.every((c) => !c.includes("show_text"))).toBe(true);
  });

  it("an older server with no cost fields shows no cost line at all", async () => {
    stubApi({ "/v1/projects/acme": project("per_use"), "/v1/insights/prompts": reply([g()]) });
    mount();
    await screen.findByText("62% of your tokens");
    expect(screen.queryByTestId("cost-line")).toBeNull();
  });
});
