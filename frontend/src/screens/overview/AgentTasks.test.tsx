/** Agent tasks: a collapsible tree of parents and children, unlinked and unstructured calls shown apart, a possible repeated call
 * with the calls as evidence and never a verdict, the viewer's own threshold, equivalent cohorts and no multiplier. Analysis only:
 * there is no control that stops, cancels or changes anything. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithProject } from "../../app/project";
import { renderWithProviders } from "../../test/render";
import type { AgentTask, AgentTasks as AgentTasksAnswer, AgentTaskSummary, Cohort, RepeatedCall, TaskNode } from "../../features/insights/api/agentTasksApi";
import { AgentTasks, AgentTasksBody, CohortList, structureText, TaskDetail, visibleNodes } from "./AgentTasks";
import type { ShellProps } from "./widgets";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const uid = (n: number) => `00000000-0000-0000-0000-0000000${String(n).padStart(5, "0")}`;
const tot = (calls: number, tokens: number, cost: number | null = 0.1, unpriced = 0) => ({ calls, tokens, cost_usd: cost, unpriced_calls: unpriced });

const node = (n: number, over: Partial<TaskNode> = {}): TaskNode => ({
  run_id: uid(n), parent_run_id: null, depth: 0, section: "tree", link: "root", reason: null, missing_parent: null, duplicate_span: false, child_count: 0,
  agent: "orchestrator", model: "acme-large", job: "invoice-extract", span_id: `s${n}`, parent_span_id: null, started_at: "2026-11-18T09:00:00Z", latency_ms: 100,
  tools: [], own: tot(1, 1000), subtree: tot(1, 1000), ...over,
});

const TREE: TaskNode[] = [
  node(1, { child_count: 2, subtree: tot(4, 5000, 0.4) }),
  node(2, { depth: 1, link: "child", parent_run_id: uid(1), child_count: 1, agent: "planner", subtree: tot(2, 3000, 0.2) }),
  node(3, { depth: 2, link: "child", parent_run_id: uid(2), agent: "coder", tools: ["write_file"] }),
  node(4, { depth: 1, link: "child", parent_run_id: uid(1), agent: "tester" }),
  node(5, { section: "unlinked", link: "unlinked", reason: "parent not recorded", missing_parent: "s-missing", agent: "summariser" }),
  node(6, { section: "no_structure", link: "no_structure", span_id: null, agent: null }),
];

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  trace_id: "task-1", jobs: ["invoice-extract"], agents: ["orchestrator", "planner"], models: ["acme-large"], first_at: "2026-11-18T09:00:00Z", last_at: "2026-11-18T09:05:00Z",
  totals: tot(6, 6000, 0.6), structure: { roots: 1, linked_children: 3, unlinked: 1, no_structure: 1 }, nodes: TREE, repeated: null, notes: ["1 calls name a parent that was not recorded (or point at themselves, or form a cycle), so they are shown apart."],
  truncated: false, method: [], ...over,
});

const repeated = (over: Partial<RepeatedCall> = {}): RepeatedCall => ({
  label: "possible_repeated_call", step: "the get_status tool", basis: "arguments", repeats: 6, in_window: 5, threshold: 5, window: 7,
  calls: Array.from({ length: 6 }, (_, i) => ({ run_id: uid(100 + i), at: `2026-11-18T09:00:0${i}Z`, gap_seconds: i === 0 ? null : 30, cost_usd: 0.002, tokens: 300, agent: "worker", model: "acme-mini", failed: null, in_window: i > 0 })),
  median_gap_seconds: 30, results_stored: true, distinct_results: 1, failed_calls: 0, cost_usd: 0.012,
  hints: ["This can be valid: polling and retries repeat on purpose. Check the calls before deciding anything.", "The calls are about 30 seconds apart, which is how polling often looks."], ...over,
});

const summary = (over: Partial<AgentTaskSummary> = {}): AgentTaskSummary => ({
  trace_id: "task-1", jobs: ["invoice-extract"], agents: ["orchestrator", "planner"], models: ["acme-large"], first_at: "2026-11-18T09:00:00Z", last_at: "2026-11-18T09:05:00Z",
  totals: tot(6, 6000, 0.6), structure: { roots: 1, linked_children: 3, unlinked: 1, no_structure: 1 }, repeated_step: null, repeated_times: null, notes: [], ...over,
});

const cohort = (): Cohort => ({
  job: "invoice-extract", models: ["acme-large"],
  single_agent: { tokens: { tasks: 41, median: 4200, p25: 3100, p75: 5600 }, cost_usd: { tasks: 41, median: 0.14, p25: 0.1, p75: 0.19 } },
  multi_agent: { tokens: { tasks: 18, median: 13800, p25: 9900, p75: 17400 }, cost_usd: { tasks: 18, median: 0.46, p25: 0.33, p75: 0.58 } },
});

const list = (over: Partial<AgentTasksAnswer> = {}): AgentTasksAnswer => ({
  days: 30, repeats: 5, window: 7, mode: "per_use", repeat_choices: [3, 4, 5, 6, 8, 10], window_choices: [5, 7, 10, 15], min_cohort: 10,
  tasks: [summary()], cohorts: [], notes: [], method: ["Each recorded call is counted once."], ...over,
});

function stub(listBody: unknown, detail: unknown = task(), status = 200) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith("/v1/insights/agent-tasks")) return json(listBody, status);
    if (url.startsWith("/v1/insights/agent-task?")) return json(detail, status);
    if (url.startsWith("/v1/runs/")) return json({ detail: "no" }, 404);
    return json([]);
  }));
  return urls;
}
const body = (listBody: unknown, detail?: unknown, status = 200) => {
  const urls = stub(listBody, detail, status);
  renderWithProviders(<WithProject id="acme"><AgentTasksBody days={30} repeats={5} window={7} /></WithProject>);
  return urls;
};

describe("pure helpers", () => {
  it("says how much of a task's structure is known, in words", () => {
    expect(structureText({ roots: 1, linked_children: 3, unlinked: 1, no_structure: 2 })).toBe("1 starting call with 3 calls under it · 1 call names a parent that was not recorded · 2 calls sent no structure");
    expect(structureText({ roots: 2, linked_children: 1, unlinked: 0, no_structure: 0 })).toBe("2 starting calls with 1 call under them");
    expect(structureText({ roots: 0, linked_children: 0, unlinked: 0, no_structure: 0 })).toBe("No calls.");
  });

  it("folding a branch hides everything under it and nothing beside it", () => {
    expect(visibleNodes(TREE, new Set()).map((n) => n.run_id)).toEqual(TREE.map((n) => n.run_id));
    const planFolded = visibleNodes(TREE, new Set([uid(2)])).map((n) => n.run_id);
    expect(planFolded).toEqual([uid(1), uid(2), uid(4), uid(5), uid(6)]); // coder hidden, tester and the rest stay
    expect(visibleNodes(TREE, new Set([uid(1)])).map((n) => n.run_id)).toEqual([uid(1), uid(5), uid(6)]); // everything under the first call
  });
});

describe("the task list", () => {
  it("shows each task's totals, who worked on it, how much structure is known and no verdict", async () => {
    body(list());
    const row = await screen.findByTestId("task-row");
    expect(row).toHaveTextContent("task-1");
    expect(row).toHaveTextContent("6,000 tokens");
    expect(row).toHaveTextContent("6 calls · $0.60");
    expect(screen.getByTestId("structure")).toHaveTextContent("1 starting call with 3 calls under it · 1 call names a parent that was not recorded · 1 call sent no structure");
    expect(screen.queryByTestId("repeat-flag")).toBeNull();
  });

  it("a possible repeated call is worded as a possibility that can be valid, never as waste or a loop", async () => {
    body(list({ tasks: [summary({ repeated_step: "the get_status tool", repeated_times: 6 })] }));
    const flag = await screen.findByTestId("repeat-flag");
    expect(flag).toHaveTextContent("Possible repeated call: the get_status tool 6 times. This can be valid, such as polling or retries.");
    expect(document.body.textContent).not.toMatch(/waste|wasted|\bloop|stuck|runaway|certain|you should stop|fix this/i);
  });

  it("with no task id recorded it explains how to get one, never a blank card", async () => {
    body(list({ tasks: [], notes: ["No task with a trace id was recorded in this period. Send a trace_id with each call to see a task as a whole."] }));
    expect(await screen.findByTestId("no-tasks")).toHaveTextContent("Send a trace_id with each call");
  });

  it("an unpriced call is counted, not shown as free", async () => {
    body(list({ tasks: [summary({ totals: tot(6, 6000, 0.5, 2) })] }));
    expect(await screen.findByTestId("task-row")).toHaveTextContent("$0.50 (2 calls have no known price)");
  });

  it("a flat-fee plan sees tokens and no dollars", async () => {
    body(list({ mode: "subscription", tasks: [summary({ totals: tot(6, 6000, null, 0) })] }));
    const row = await screen.findByTestId("task-row");
    expect(row).toHaveTextContent("6,000 tokens");
    expect(row.textContent).not.toMatch(/\$/);
  });

  it("a failed request or a non-answer is an error with a retry", async () => {
    body({ detail: "boom" }, undefined, 500);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("a task as a tree", () => {
  it("opens from the row, shows the total once, and groups calls under starting calls, unrecorded parents and no structure", async () => {
    const user = userEvent.setup();
    body(list());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    expect(await screen.findByTestId("task-total")).toHaveTextContent("Task total, each call counted once: 6 calls, 6,000 tokens, $0.60.");
    const titles = screen.getAllByRole("heading", { name: /^Calls/ }).map((h) => h.textContent);
    expect(titles).toEqual(["Calls, starting from the first", "Calls whose parent was not recorded", "Calls that sent no structure"]);
    const depths = screen.getAllByTestId("tree-node").map((n) => n.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "1", "2", "1", "0", "0"]);
  });

  it("an unlinked call says its parent was not recorded and names the missing id", async () => {
    const user = userEvent.setup();
    body(list());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    expect(await screen.findByText(/Parent not recorded: s-missing/)).toBeInTheDocument();
    expect(screen.getByText(/1 calls name a parent that was not recorded/)).toBeInTheDocument();
    expect(screen.getAllByText("Unnamed agent").length).toBeGreaterThan(0); // the call that sent no structure and no agent label
  });

  it("each branch can be folded and unfolded with the keyboard, and the label says how many calls it hides", async () => {
    const user = userEvent.setup();
    body(list());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    const fold = await screen.findByRole("button", { name: "Hide the 1 call under Planner" });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    fold.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Show the 1 call under Planner" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByTestId("tree-node").map((n) => n.getAttribute("data-depth"))).toEqual(["0", "1", "1", "0", "0"]); // the coder is folded away
    await user.click(screen.getAllByRole("button", { name: "Fold all" })[0]);
    expect(screen.getAllByTestId("tree-node")).toHaveLength(3); // the first call folded over everything under it, plus the unlinked and unstructured calls
    await user.click(screen.getAllByRole("button", { name: "Unfold all" })[0]);
    expect(screen.getAllByTestId("tree-node")).toHaveLength(6);
  });

  it("each call shows its own usage and, for a parent, the total with the calls under it", async () => {
    const user = userEvent.setup();
    body(list());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    const rows = await screen.findAllByTestId("tree-node");
    expect(rows[0]).toHaveTextContent("1,000 tokens, $0.10; 5,000 with the calls under it");
    expect(rows[2]).not.toHaveTextContent("with the calls under it"); // a leaf has no subtree line
    expect(rows[2]).toHaveTextContent("uses write_file");
  });

  it("a call can be inspected from the tree, which opens the call's own detail", async () => {
    const user = userEvent.setup();
    body(list());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    await screen.findByTestId("task-detail");
    await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole("button", { name: /Inspect this call by Orchestrator/ })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("calls that share a span id are flagged, and duplicates of one call are never shown twice", async () => {
    const user = userEvent.setup();
    body(list({ tasks: [summary({ notes: ["1 span ids are used by more than one call; each call is still counted once."] })] }), task({ nodes: [node(1, { duplicate_span: true }), node(2, { duplicate_span: true, span_id: "s1" })], notes: ["1 duplicate records of the same call were counted once."] }));
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    expect(await screen.findAllByText("shares a span id")).toHaveLength(2);
    expect(screen.getByTestId("task-notes")).toHaveTextContent("1 duplicate records of the same call were counted once.");
  });

  it("a task that failed to load says so", async () => {
    const user = userEvent.setup();
    body(list(), { detail: "boom" }, 200);
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("the whole detail has no control that stops, cancels or changes an agent", async () => {
    const user = userEvent.setup();
    body(list());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    await screen.findByTestId("task-detail");
    expect(screen.queryByRole("button", { name: /stop|cancel|kill|disable|pause|block|limit|apply|fix|turn off/i })).toBeNull();
  });
});

describe("possible repeated call evidence", () => {
  const withRepeat = (r: RepeatedCall = repeated()) => task({ nodes: [node(1)], repeated: r, structure: { roots: 1, linked_children: 0, unlinked: 0, no_structure: 0 } });

  it("shows the threshold it used, what was compared, the calls with their spacing and a caveat that it can be valid", async () => {
    const user = userEvent.setup();
    body(list({ tasks: [summary({ repeated_step: "the get_status tool", repeated_times: 6 })] }), withRepeat());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    const panel = await screen.findByTestId("repeated");
    expect(panel).toHaveTextContent("the get_status tool ran 6 times in this task, and at least 5 within 7 calls. Compared on the same tool and the same details.");
    expect(panel).toHaveTextContent("The recorded cost of these calls was $0.01. That is a measurement, not a verdict.");
    expect(within(panel).getAllByTestId("repeat-row")).toHaveLength(6);
    expect(within(panel).getAllByRole("columnheader").map((h) => h.textContent)).toContain("Since the one before");
    expect(within(panel).getByText("first")).toBeInTheDocument();
    expect(screen.getByTestId("repeated-hints")).toHaveTextContent("polling and retries repeat on purpose");
    expect(screen.getByTestId("repeated-hints")).toHaveTextContent("about 30 seconds apart, which is how polling often looks");
    expect(panel).toHaveTextContent("Shaded rows are the stretch that reached your threshold. This can be valid");
  });

  it("when details were not stored it says the comparison was the tool and the prompt", async () => {
    const user = userEvent.setup();
    body(list({ tasks: [summary({ repeated_step: "x", repeated_times: 5 })] }), withRepeat(repeated({ basis: "prompt" })));
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    expect(await screen.findByTestId("repeated")).toHaveTextContent("the same tool and the same prompt (details were not stored)");
  });

  it("shows retries as failed results, and unknown results as not recorded", async () => {
    const user = userEvent.setup();
    const calls = repeated().calls.map((c, i) => ({ ...c, failed: i < 2 ? true : i === 2 ? false : null }));
    body(list({ tasks: [summary({ repeated_step: "x", repeated_times: 6 })] }), withRepeat(repeated({ calls, failed_calls: 2, hints: ["This can be valid: polling and retries repeat on purpose. Check the calls before deciding anything.", "2 of these calls are recorded as failed, which is how retries often look."] })));
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    const rows = await screen.findAllByTestId("repeat-row");
    expect(rows[0]).toHaveTextContent("Failed");
    expect(rows[2]).toHaveTextContent("Succeeded");
    expect(rows[5]).toHaveTextContent("Not recorded");
    expect(screen.getByTestId("repeated-hints")).toHaveTextContent("how retries often look");
  });

  it("every repeated call can be inspected", async () => {
    const user = userEvent.setup();
    body(list({ tasks: [summary({ repeated_step: "x", repeated_times: 6 })] }), withRepeat());
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    await screen.findByTestId("repeated");
    await user.click(screen.getAllByRole("button", { name: /Inspect call 3/ })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("a subscription project sees no dollars in the evidence", async () => {
    const user = userEvent.setup();
    const flat = withRepeat(repeated({ cost_usd: null }));
    flat.totals = tot(1, 1000, null, 0);
    flat.nodes = [node(1, { own: tot(1, 1000, null), subtree: tot(1, 1000, null) })];
    body(list({ mode: "subscription", tasks: [summary({ totals: tot(6, 6000, null), repeated_step: "x", repeated_times: 6 })] }), flat);
    await user.click(await screen.findByRole("button", { name: /task-1/ }));
    await screen.findByTestId("repeated");
    expect(document.body.textContent).not.toMatch(/\$/);
  });
});

describe("the viewer chooses the threshold", () => {
  const shell = { id: "agent-tasks", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;

  it("asks for the chosen repeats and window, and says they are the viewer's choice, not a measured limit", async () => {
    const urls = stub(list());
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><AgentTasks shell={shell} /></WithProject>);
    expect(await screen.findByTestId("threshold")).toHaveTextContent("Your choice, not a measured limit.");
    expect(urls[0]).toContain("repeats=5&window=7");
    await user.selectOptions(screen.getByLabelText("Number of repeats"), "8");
    await user.selectOptions(screen.getByLabelText("Window of calls"), "10");
    await waitFor(() => expect(urls.some((u) => u.includes("repeats=8&window=10"))).toBe(true));
  });

  it("a window smaller than the repeats cannot be chosen, and raising the repeats lifts the window", async () => {
    stub(list());
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><AgentTasks shell={shell} /></WithProject>);
    const repeats = await screen.findByLabelText("Number of repeats");
    await user.selectOptions(repeats, "10");
    expect(screen.getByLabelText("Window of calls")).toHaveValue("10");
    expect(within(screen.getByLabelText("Window of calls")).getByRole("option", { name: "5 calls" })).toBeDisabled();
    expect(within(screen.getByLabelText("Window of calls")).getByRole("option", { name: "7 calls" })).toBeDisabled();
  });

  it("choosing a period asks for it, and the widget says nothing is stopped or changed", async () => {
    const urls = stub(list());
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><AgentTasks shell={shell} /></WithProject>);
    await user.click(await screen.findByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(urls.some((u) => u.includes("days=7"))).toBe(true));
    expect(screen.getByText(/nothing is stopped, cancelled or changed/)).toBeInTheDocument();
  });
});

describe("comparing equivalent tasks", () => {
  it("shows measured medians and counts for the same AI task on the same models, with the limits spelled out and no multiplier", () => {
    renderWithProviders(<CohortList cohorts={[cohort()]} minCohort={10} showMoney />);
    const c = screen.getByTestId("cohort");
    expect(c).toHaveTextContent("invoice-extract on acme-large. One agent: 41 tasks, median 4,200 tokens (middle half 3,100 to 5,600), median $0.14.");
    expect(c).toHaveTextContent("Several agents: 18 tasks, median 13.8K tokens (middle half 9,900 to 17.4K), median $0.46.");
    const t = document.body.textContent ?? "";
    expect(t).toContain("this does not show that using several agents causes the difference. No multiplier is claimed.");
    expect(t).not.toMatch(/\b\d+(\.\d+)?\s?(x|×|times)\b\s+(more|as|the)/i);
  });

  it("with too few equivalent tasks it says what is needed instead of comparing", () => {
    renderWithProviders(<CohortList cohorts={[]} minCohort={10} showMoney />);
    expect(screen.getByTestId("no-cohorts")).toHaveTextContent("It takes at least 10 single-agent and 10 multi-agent tasks of the same AI task on the same models.");
  });

  it("a flat-fee plan sees tokens and no cost", () => {
    renderWithProviders(<CohortList cohorts={[cohort()]} minCohort={10} showMoney={false} />);
    expect(screen.getByTestId("cohort").textContent).not.toMatch(/\$/);
  });

  it("is part of the answer and its method is one tap away", async () => {
    const user = userEvent.setup();
    body(list({ cohorts: [cohort()] }));
    expect(await screen.findByTestId("cohorts")).toBeInTheDocument();
    await user.click(screen.getByText("How these numbers are worked out"));
    expect(screen.getByText("Each recorded call is counted once.")).toBeInTheDocument();
  });
});

describe("TaskDetail on its own", () => {
  it("asks for the task with the chosen threshold", async () => {
    const urls = stub(list(), task());
    renderWithProviders(<WithProject id="acme"><TaskDetail traceId="task-1" repeats={8} window={10} /></WithProject>);
    await screen.findByTestId("task-detail");
    expect(urls.some((u) => u.includes("trace_id=task-1&repeats=8&window=10"))).toBe(true);
  });
});
