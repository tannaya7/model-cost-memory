/** Cost planner and Data coverage: assumptions are validated before anything is requested, the unknowns stay visible, and the pages say what
 *  they cannot do. They read our own server only. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import CostPlanner, { parseDraft } from "./CostPlanner";
import DataCoverage from "./DataCoverage";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const draft = { job: "t", days: "30", calls: ["1000", "10000", ""], retry: "", input: "", output: "", farOut: false, period: "month" as const };
const noSuccess = { value_usd: null, spend_usd: 0, passed: 0, checked_priced_runs: 0, checked_unpriced_runs: 0, unchecked_runs: 15, reason: "No call has been checked and priced yet", formula: "f" };

describe("parseDraft", () => {
  it("turns percentages into rates and drops empty scenario boxes", () => {
    const r = parseDraft({ ...draft, retry: "20", input: "10", output: "-5" });
    expect(r).toEqual({ input: expect.objectContaining({ calls: [1000, 10000], retryRate: 0.2, inputChangePct: 10, outputChangePct: -5 }) });
  });
  it("refuses malformed, zero, negative and extreme assumptions in words", () => {
    const bads = [{ calls: ["0", "", ""] }, { calls: ["1.5", "", ""] }, { calls: ["abc", "", ""] }, { calls: ["2000000000", "", ""] }, { calls: ["", "", ""] },
      { retry: "-1" }, { retry: "5000" }, { input: "-100" }, { output: "9999" }, { retry: "x" }, { job: "" }];
    for (const bad of bads) {
      const r = parseDraft({ ...draft, ...bad });
      expect("error" in r && r.error.length > 5).toBe(true);
    }
  });
});

function planner() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.startsWith("/v1/jobs")) return json([{ name: "t", description: null }, { name: "u", description: null }]);
    if (url.startsWith("/v1/insights/planner")) {
      return json({
        job: "t", check_kind: "ANSWER_KEY", success_definition: "The answer matches your answer key", currency: "USD", period_label: "month", period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z",
        period_days: 30, timezone: "UTC", truncated: false, assumptions: [{ name: "Retry rate", value: "0.2", source: "You entered this" }], observed_retry_rate: null,
        models: [
          { model: "m1", provider: "acme", observed_calls: 50, used_calls: 40, left_out: { "No dated list price matched, so the cost is unknown": 10 }, filtered_out: 0, first_call: "2026-10-02T00:00:00Z", last_call: "2026-10-30T00:00:00Z",
            mean_call_usd: 0.002, mean_call_unfiltered_usd: 0.002, median_call_usd: 0.002, p90_call_usd: 0.003, max_call_usd: 0.004, mean_input_side_usd: 0.001, mean_output_side_usd: 0.001, mean_tokens_in: 100, mean_tokens_out: 50, uneven: true,
            status: "ESTIMATE", status_text: "40 usable calls: an estimate with a range.", scenarios: [{ tasks_per_period: 1000, attempts: 1200, estimate_usd: 2.4, low_usd: 2, high_usd: 2.8, per_task_usd: 0.0024, range_note: null }],
            passed: 30, failed: 5, unchecked: 15, excluded: 10, cost_per_success: noSuccess, versions_used: [], flagged_included: 0 },
          { model: "m2", provider: null, observed_calls: 3, used_calls: 3, left_out: {}, filtered_out: 0, first_call: null, last_call: null, mean_call_usd: null, mean_call_unfiltered_usd: null, median_call_usd: null, p90_call_usd: null, max_call_usd: null,
            mean_input_side_usd: null, mean_output_side_usd: null, mean_tokens_in: null, mean_tokens_out: null, uneven: false, status: "NOT_ENOUGH_DATA", status_text: "Not enough comparable data: 3 usable call(s); at least 5 are needed for an estimate.",
            scenarios: [{ tasks_per_period: 1000, attempts: 1000, estimate_usd: null, low_usd: null, high_usd: null, per_task_usd: null, range_note: null }], passed: 0, failed: 0, unchecked: 3, excluded: 0,
            cost_per_success: noSuccess, versions_used: [], flagged_included: 0 },
        ],
        not_tested: ["other-model"], notes: ["n"], disclaimer: "This is a scenario worked out from your own recorded calls. It is not a bill, a promise or a guaranteed forecast.",
      });
    }
    return json({ detail: "x" }, 404);
  }));
  return urls;
}

describe("Cost planner", () => {
  it("asks nothing of the server until the user calculates, and refuses a bad assumption in words", async () => {
    const urls = planner();
    renderWithProviders(<WithProject id="acme"><CostPlanner /></WithProject>);
    expect(await screen.findByLabelText("Task")).toBeInTheDocument();
    expect(urls.some((u) => u.startsWith("/v1/insights/planner"))).toBe(false);
    await userEvent.clear(screen.getByLabelText("Scenario 1"));
    await userEvent.type(screen.getByLabelText("Scenario 1"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Calculate" }));
    expect(screen.getByTestId("planner-error")).toHaveTextContent("whole numbers");
    expect(urls.some((u) => u.startsWith("/v1/insights/planner"))).toBe(false);
  });

  it("sends the typed assumptions, shows a range, marks too-little-data, and keeps unknowns and quality visible", async () => {
    const urls = planner();
    renderWithProviders(<WithProject id="acme"><CostPlanner /></WithProject>);
    await screen.findByLabelText("Task");
    await userEvent.type(screen.getByLabelText(/Retries/), "20");
    await userEvent.click(screen.getByRole("button", { name: "Calculate" }));
    const cards = await screen.findAllByTestId("planner-model");
    const sent = urls.find((u) => u.startsWith("/v1/insights/planner")) as string;
    expect(sent).toContain("job=t");
    expect(sent).toContain("retry_rate=0.2");
    expect(sent.match(/calls=/g)).toHaveLength(3);
    expect(cards[0]).toHaveTextContent("likely between $2.00 and $2.80");
    expect(cards[0]).toHaveTextContent("Some usage is unpriced or left out of this estimate (10 calls)");
    expect(cards[0]).toHaveTextContent("very uneven");
    expect(cards[0]).toHaveTextContent("Cost per correct answer: not enough data");
    expect(cards[1]).toHaveTextContent("Not enough comparable data");
    expect(screen.getByTestId("not-tested")).toHaveTextContent("Not tested on this workload");
    expect(screen.getByTestId("not-tested")).toHaveTextContent("other-model");
    expect(screen.getByTestId("planner-disclaimer")).toHaveTextContent("not a bill, a promise or a guaranteed forecast");
    expect(screen.getByTestId("planner-assumptions")).toHaveTextContent("You entered this");
    expect(screen.getByTestId("planner-assumptions")).toHaveTextContent("Measured retry rate: unknown");
  });
});

const share = (runs: number, of = 100) => ({ runs, share: of ? runs / of : null });

describe("Data coverage", () => {
  it("says what it measures, shows denominators and unknowns, and never claims completeness", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/v1/jobs")) return json([{ name: "t", description: null }]);
      if (url.startsWith("/v1/insights/coverage")) {
        return json({
          period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z", period_days: 30, timezone: "UTC", filters: {}, scope: "Coverage of the records Model & Cost Memory received. It does not measure calls that never reached it.",
          logical_tasks: 100, attempts: 100, tasks_with_several_attempts: 0, extra_attempts: 0, excluded_attempts: 0, usage_reported: share(90), no_usage_block: share(10), usage_layout_unknown: share(0), model_known: share(100), model_unknown: share(0),
          priced: share(80), caller_cost: share(0), unpriced: share(20), checked: share(50), unchecked: share(50), passed: 40, failed: 10, flagged: share(2), duplicates_ignored: null, duplicates_note: "Not available with a provider, model or task filter: duplicates are counted for the whole project.",
          basis: [], causes: [{ code: "TOTAL_MISMATCH", label: "The provider's own total differs from the sum of its parts", runs: 2, examples: [{ run_id: "abc", model: "m", provider: "p", created_at: "2026-10-05T00:00:00Z" }] }],
          providers: [], cannot_measure: ["Calls that never reached Model & Cost Memory."], notes: ["n"],
        });
      }
      return json({ detail: "x" }, 404);
    }));
    renderWithProviders(<WithProject id="acme"><DataCoverage /></WithProject>);
    expect(await screen.findByTestId("coverage-counts")).toHaveTextContent("100 tasks and 100 attempts");
    expect(screen.getAllByText("of attempts received").length).toBeGreaterThan(3);
    expect(screen.getAllByText("of attempts not archived or invalid")).toHaveLength(2);
    expect(screen.getByText(/It does not measure calls that never reached it/)).toBeInTheDocument();
    expect(screen.getByTestId("causes")).toHaveTextContent("2 call(s): The provider's own total differs");
    expect(screen.getByTestId("duplicates")).toHaveTextContent("not available with a filter");
    expect(screen.getByTestId("cannot-measure")).toHaveTextContent("never reached");
    expect(screen.queryByText(/100% complete/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Data coverage" })).toBeInTheDocument();
  });

  it("shows an honest empty state, with no figures, when nothing was received", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/v1/jobs")) return json([]);
      const zero = { runs: 0, share: null };
      return json({ period_start: "2026-10-01T00:00:00Z", period_end: "2026-11-01T00:00:00Z", period_days: 30, timezone: "UTC", filters: {}, scope: "s", logical_tasks: 0, attempts: 0,
        tasks_with_several_attempts: 0, extra_attempts: 0, excluded_attempts: 0, usage_reported: zero, no_usage_block: zero, usage_layout_unknown: zero, model_known: zero, model_unknown: zero, priced: zero, caller_cost: zero,
        unpriced: zero, checked: zero, unchecked: zero, passed: 0, failed: 0, flagged: zero, duplicates_ignored: 0, duplicates_note: "", basis: [], causes: [], providers: [], cannot_measure: [], notes: [] });
    }));
    renderWithProviders(<WithProject id="acme"><DataCoverage /></WithProject>);
    await waitFor(() => expect(screen.getByText("No calls received in this period")).toBeInTheDocument());
    expect(screen.queryByTestId("coverage-row")).not.toBeInTheDocument();
  });
});
