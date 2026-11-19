import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import { WithProject } from "../../app/project";
import { SavingsBody, amount, observedSentence } from "./SavingsTracker";
import type { SavingsEntry } from "../../features/insights/api/savingsApi";

afterEach(() => vi.unstubAllGlobals());

const realized = (over: Record<string, unknown> = {}) => ({
  metric: "cost per correct answer", unit: "usd", unit_words: "US dollars at list price (not an invoice)", before: 0.0111, after: 0.0067, change: 0.0044,
  range_low: 0.0031, range_high: 0.0057, range_note: "90% range", pass_rate_before: 0.9, pass_rate_after: 0.9, pass_rate_change_low: -0.03, pass_rate_change_high: 0.03,
  checked_before: 560, checked_after: 560, correct_before: 504, correct_after: 504, price_basis: "billed cost", mix_compared: "100% of the later calls were compared like for like by prompt size", ...over,
});
const estimated = (over: Record<string, unknown> = {}) => ({
  label: "ESTIMATED (a counterfactual, not money you can count)", unit: "usd", correct_answers: 522, point: 2.3, low: 1.6, high: 3.0,
  what: "What the correct answers given since the change would have cost more or less on the old model, at the per-answer difference measured above.",
  assumptions: ["Both periods are priced with the same price table; a price change is not counted as a saving."], ...over,
});
const entry = (over: Record<string, unknown> = {}): SavingsEntry => ({
  job: "read-invoices", from_model: "big", to_model: "small", switch_date: "2026-10-20", status: "saving", reason: null, reasons: [], window: { days: 28 },
  realized: realized(), estimated_avoided: estimated(), data_notes: [], progress: null, coverage: null, ...over,
} as unknown as SavingsEntry);

const payload = (entries: SavingsEntry[], over: Record<string, unknown> = {}) => ({
  mode: "per_use", unit: "usd", as_of: "2026-11-19", jobs_checked: 2, entries, counts: {}, estimated_avoided_total: null,
  notes: ["Recommendations, 'promising' labels and trials are never counted."], method: ["Each task's own cost per correct answer, before and after."], ...over,
});

function show(body: unknown) {
  stubApi({ "/v1/insights/savings": body });
  renderWithProviders(<WithProject id="acme"><SavingsBody /></WithProject>);
}

describe("savings since you switched", () => {
  it("says what was observed, with a range, and keeps the estimate apart and labelled", async () => {
    show(payload([entry()]));
    const card = await screen.findByTestId("savings-entry");
    const observed = within(card).getByTestId("observed");
    expect(observed).toHaveTextContent("Observed: cost per correct answer went from $0.011 to $0.0067 after you switched on 20 Oct 2026.");
    expect(observed).toHaveTextContent("$0.0031 to $0.0057 less for each correct answer (90% range)");
    const est = within(card).getByTestId("estimated");
    expect(est).toHaveTextContent("ESTIMATED (a counterfactual, not money you can count)");
    expect(est).toHaveTextContent("$1.60 to $3.00");
    expect(within(est).getByText("Assumptions")).toBeInTheDocument();
    expect(observed).not.toHaveTextContent(/ESTIMATED|\$1\.60/); // nothing estimated inside the observed part
  });

  it("never says you saved, or that we saved you", async () => {
    show(payload([entry(), entry({ job: "b", status: "cost_up", realized: realized({ change: -0.003, range_low: -0.004, range_high: -0.002 }) })]));
    await screen.findAllByTestId("savings-entry");
    expect(document.body.textContent ?? "").not.toMatch(/you saved|we saved|saved you|guarantee/i);
  });

  it("shows a cost increase plainly as the valid negative result it is", async () => {
    show(payload([entry({ status: "cost_up", realized: realized({ before: 0.007, after: 0.011, change: -0.004, range_low: -0.005, range_high: -0.003 }), estimated_avoided: estimated({ point: -2, low: -2.7, high: -1.4 }) })]));
    const card = await screen.findByTestId("savings-entry");
    expect(within(card).getByText("Costs more per correct answer")).toBeInTheDocument();
    expect(within(card).getByTestId("observed")).toHaveTextContent("$0.003 to $0.005 more for each correct answer");
    expect(within(card).getByTestId("estimated")).toHaveTextContent("−$2.70 to −$1.40");
  });

  it("does not count a cheaper but less correct change as a saving, and offers no estimate for it", async () => {
    show(payload([entry({ status: "less_correct", realized: realized({ pass_rate_before: 0.9, pass_rate_after: 0.6 }), estimated_avoided: null })]));
    const card = await screen.findByTestId("savings-entry");
    expect(within(card).getByText("Cheaper, but less correct")).toBeInTheDocument();
    expect(within(card).getByTestId("observed")).toHaveTextContent("Fewer answers were correct, so this is not counted as a saving.");
    expect(within(card).queryByTestId("estimated")).toBeNull();
  });

  it("with not enough comparable data shows no figure at all, only the reasons", async () => {
    show(payload([entry({ status: "not_enough_data", realized: null, estimated_avoided: null, reasons: ["fewer than 100 checked calls with a cost in each period"], reason: "fewer than 100 checked calls with a cost in each period" })]));
    const card = await screen.findByTestId("savings-entry");
    expect(card).toHaveTextContent("Not enough comparable data, so no figure is shown.");
    expect(card).toHaveTextContent("fewer than 100 checked calls");
    expect(card.textContent ?? "").not.toMatch(/\$\d/);
  });

  it("while waiting for days it says how far along it is and shows no number", async () => {
    show(payload([entry({ status: "waiting", realized: null, estimated_avoided: null, reason: "Waiting for 14 comparable days on each side of the change: 28 before, 11 after so far." })]));
    const card = await screen.findByTestId("savings-entry");
    expect(card).toHaveTextContent("11 after so far");
    expect(card.textContent ?? "").not.toMatch(/\$\d/);
  });

  it("shows a change that could be chance as no clear change, with its range either side of zero", async () => {
    show(payload([entry({ status: "no_clear_change", realized: realized({ change: 0.0002, range_low: -0.0011, range_high: 0.0015 }) })]));
    expect(await screen.findByTestId("observed")).toHaveTextContent("between −$0.0011 and +$0.0015 per correct answer");
  });

  it("lists data notes such as a price change or a cache change", async () => {
    show(payload([entry({ data_notes: ["A list price changed during these periods, so both periods are priced with the same price table."] })]));
    expect(await screen.findByTestId("data-notes")).toHaveTextContent("list price changed");
  });

  it("adds up only the estimates, under its own label", async () => {
    show(payload([entry(), entry({ job: "b" })], { estimated_avoided_total: { label: "ESTIMATED counterfactuals added up. Not money you can count, and separate from the realized changes above", unit: "usd", point: 4.6, low: 3.2, high: 6, entries: 2 } }));
    const total = await screen.findByTestId("estimated-total");
    expect(total).toHaveTextContent("Estimated, all changes together");
    expect(total).toHaveTextContent("$3.20 to $6.00 across 2 changes");
    expect(total).toHaveTextContent("separate from the realized changes");
  });

  it("explains an empty tracker instead of showing zeros or a blank card", async () => {
    show(payload([]));
    expect(await screen.findByTestId("savings-empty")).toHaveTextContent("No model change found yet.");
    expect(screen.queryByTestId("estimated-total")).toBeNull();
  });

  it("on a flat plan speaks in tokens, never dollars", async () => {
    show(payload([entry({ realized: realized({ unit: "tokens", unit_words: "billed tokens (approximate: models count tokens differently)", before: 2444, after: 1222, change: 1222, range_low: 1000, range_high: 1400 }), estimated_avoided: estimated({ unit: "tokens", point: 600000, low: 500000, high: 700000 }) })], { unit: "tokens", mode: "subscription" }));
    const card = await screen.findByTestId("savings-entry");
    expect(card.textContent ?? "").not.toMatch(/\$\d/);
    expect(card).toHaveTextContent("2,444 tokens");
    expect(card).toHaveTextContent("approximate");
  });

  it("states what it never counts", async () => {
    show(payload([]));
    await screen.findByTestId("savings-tracker");
    expect(screen.getByText(/never counts our recommendations/)).toBeInTheDocument();
  });
});

describe("the wording helpers", () => {
  it("formats dollars and tokens, with the sign when asked", () => {
    expect(amount("usd", 0.0044)).toBe("$0.0044");
    expect(amount("usd", -2, { signed: true })).toBe("−$2.00");
    expect(amount("tokens", 1500)).toBe("1,500 tokens");
    expect(amount("usd", null)).toBe("not known");
  });
  it("gives no sentence when nothing was measured", () => {
    expect(observedSentence({ ...entry(), realized: null } as SavingsEntry)).toBeNull();
  });
});
