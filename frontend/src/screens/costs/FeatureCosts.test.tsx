/** The feature-label cost table: the customer's own labels, shown as their own words, with every unknown kept visible. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { WithProject } from "../../app/project";
import type { FeatureBreakdown } from "../../features/insights/api/featuresApi";
import { FeatureCostsBody } from "./FeatureCosts";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const success = (over: Record<string, unknown> = {}) => ({
  value_usd: 0.0125, formula: "f", spend_usd: 0.1, passed: 8, checked_priced_runs: 10, checked_unpriced_runs: 0, unchecked_runs: 0, reason: null,
  success_definition: "Each task's own definition of a correct answer (see each task)", ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  feature: "support_summary", label: "support_summary", folded_labels: null, runs: 10, passed: 8, failed: 2, unchecked: 0, excluded: 0, tokens: 1100,
  no_usage_runs: 0, spend_usd: 0.1, unpriced_runs: 0, share_of_spend: 0.5, cost_per_success: success(), ...over,
});
const data = (over: Partial<FeatureBreakdown> = {}): FeatureBreakdown => ({
  currency: "USD", timezone: "UTC", period_start: "2026-10-22T00:00:00Z", period_end: "2026-11-21T00:00:00Z", period_days: 30,
  rows: [row()], total_runs: 10, labelled_runs: 10, labelled_share: 1, truncated: false,
  notes: ["Labels come from your own app. They are not verified identities and not invoice-grade chargeback records: anyone with a project key can send any label."],
  ...over,
}) as FeatureBreakdown;

function mount(reply: unknown, status = 200) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return json(reply, status); }));
  renderWithProviders(<WithProject id="acme"><FeatureCostsBody days={30} /></WithProject>);
  return urls;
}

describe("cost by your own feature labels", () => {
  it("shows each label with its calls, tokens, cost, share and checked answers, and says the labels are the customer's own", async () => {
    const urls = mount(data());
    expect(await screen.findByText("support_summary")).toBeInTheDocument();
    expect(urls).toContain("/v1/insights/features?days=30");
    const r = within(screen.getByTestId("feature-row"));
    expect(r.getByText("your label")).toBeInTheDocument();
    expect(r.getByText("10")).toBeInTheDocument();
    expect(r.getByText("8 / 2 / 0")).toBeInTheDocument();
    expect(screen.getByTestId("labelled-share")).toHaveTextContent("100% of the 10 calls carried a feature label");
    expect(screen.getByTestId("labelled-share")).toHaveTextContent("not verified and not a chargeback record");
    expect(screen.getByTestId("feature-notes")).toHaveTextContent("not verified identities");
  });

  it("names the table for screen readers and keeps the scrolling box reachable by keyboard", async () => {
    mount(data());
    const table = await screen.findByRole("table", { name: /Calls, tokens, list-price cost and checked answers for each feature label/ });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Cost by feature label" })).toHaveAttribute("tabindex", "0");
  });

  it("shows unlabelled calls as their own row, and never marks them as a label", async () => {
    mount(data({ rows: [row(), row({ feature: null, label: "Unlabelled", runs: 4, share_of_spend: 0.5 })], total_runs: 14, labelled_runs: 10, labelled_share: 10 / 14 }));
    const rows = await screen.findAllByTestId("feature-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText("Unlabelled")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("your label")).toBeNull();
    expect(screen.getByTestId("labelled-share")).toHaveTextContent("71% of the 14 calls");
  });

  it("keeps unknowns visible: unpriced calls are left out and said so, unknown tokens are not shown as zero", async () => {
    mount(data({ rows: [row({ feature: null, label: "Unlabelled", unpriced_runs: 2, no_usage_runs: 3 })] }));
    const r = within(await screen.findByTestId("feature-row"));
    expect(r.getByText("2 unpriced, left out")).toBeInTheDocument();
    expect(r.getByText("unknown for 3 calls")).toBeInTheDocument();
  });

  it("says why a cost per correct answer does not exist instead of showing a number", async () => {
    mount(data({ rows: [row({ cost_per_success: success({ value_usd: null, reason: "No call has been checked and priced yet", passed: 0, checked_priced_runs: 0 }) })] }));
    expect(await screen.findByText(/Not enough data: No call has been checked and priced yet/)).toBeInTheDocument();
  });

  it("explains how to send a label when none were sent, and says the customer chooses and the code is never changed", async () => {
    mount(data({ rows: [row({ feature: null, label: "Unlabelled" })], labelled_runs: 0, labelled_share: 0 }));
    expect(await screen.findByText(/None of the 10 calls in this period carried a feature label/)).toBeInTheDocument();
    const how = screen.getByTestId("how-to-label");
    expect(how).toHaveTextContent("It is optional, and you choose whether to add it. We never change your code.");
    expect(how).toHaveTextContent('feature="support_summary"');
  });

  it("says plainly when there are no calls at all, with no invented rows", async () => {
    mount(data({ rows: [], total_runs: 0, labelled_runs: 0, labelled_share: null }));
    expect(await screen.findByText("No calls in this period")).toBeInTheDocument();
    expect(screen.queryByTestId("feature-row")).toBeNull();
  });

  it("says when smaller labels are added together, and when more labels exist than were read", async () => {
    mount(data({ rows: [row(), row({ feature: null, label: "Other labels", folded_labels: 5 })], truncated: true }));
    expect(await screen.findByText("5 smaller labels added together")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("more distinct labels than we read");
  });

  it("shows an error with a way to retry when the server cannot answer", async () => {
    mount({ detail: "boom" }, 500);
    expect(await screen.findByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
  });
});
