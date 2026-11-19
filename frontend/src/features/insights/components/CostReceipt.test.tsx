import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import type { CostReceipt as Receipt } from "../reconcile";
import { CostReceipt } from "./CostReceipt";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

const base: Receipt = {
  currency: "USD", timezone: "UTC", period_start: "2026-10-18T00:00:00Z", period_end: "2026-11-17T00:00:00Z", period_days: 30,
  runs: 120, passed: 70, failed: 20, unchecked: 25, excluded: 5, spend_usd: 42.5, spend_on_failed_checks_usd: 8.25,
  unpriced_runs: 4, unpriced_note: "4 unpriced runs excluded from this total", partly_priced_runs: 2,
  basis: [
    { status: "PRICED", label: "Calculated from the usage the provider reported and a dated list price", runs: 100, spend_usd: 40 },
    { status: "PARTLY_PRICED", label: "Calculated the same way, but a label this app cannot price", runs: 2, spend_usd: 2.5 },
    { status: "UNPRICED_UNKNOWN_MODEL", label: "Not priced: no list price is known for this model name", runs: 4, spend_usd: null },
  ],
  price_versions: [{
    version_id: "v1", model: "acme-mini", provider: "acme", input_per_mtok: 0.25, output_per_mtok: 1.25,
    effective_from: "2026-07-01T00:00:00Z", effective_to: null, source_kind: "SYNC", source_url: "https://example.com/prices.json",
    checked_at: "2026-11-17T08:00:00Z", applicability: "Public list price", runs: 100, spend_usd: 40,
  }, {
    version_id: "v0", model: "acme-mini", provider: "acme", input_per_mtok: 0.5, output_per_mtok: 2, effective_from: "2026-05-01T00:00:00Z",
    effective_to: "2026-07-01T00:00:00Z", source_kind: "MANUAL", source_url: null, checked_at: null, applicability: "Entered by hand", runs: 2, spend_usd: 2.5,
  }],
  price_versions_checked_at: "2026-11-17T08:00:00Z", price_versions_oldest_effective: "2026-05-01T00:00:00Z",
  cost_per_success: {
    value_usd: 0.55, formula: "…", spend_usd: 38.5, passed: 70, checked_priced_runs: 88, checked_unpriced_runs: 2, unchecked_runs: 25,
    reason: null, success_definition: "The answer matches your answer key (total)",
  },
  jobs: [], notes: [],
};

function serve(body: Receipt) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

async function open(body: Receipt = base) {
  const calls = serve(body);
  renderWithProviders(<CostReceipt days={30} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "How this is worked out" }));
  await screen.findByRole("region", { name: "How this cost is worked out" });
  return calls;
}

describe("CostReceipt", () => {
  it("is closed by default and asks the server for nothing until it is opened", async () => {
    const calls = serve(base);
    renderWithProviders(<CostReceipt days={30} />);
    expect(screen.getByRole("button", { name: "How this is worked out" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region")).toBeNull();
    expect(calls).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "How this is worked out" }));
    expect(await screen.findByText(/Last 30 days, counted in UTC/)).toBeInTheDocument();
    expect(calls).toEqual(["/v1/insights/cost-receipt?days=30"]);
  });

  it("states currency, period, basis and that it is not an invoice", async () => {
    await open();
    expect(screen.getByText(/US dollars, at public list prices: an estimate from your recorded calls, not your invoice/)).toBeInTheDocument();
  });

  it("keeps passed, failed, unchecked and left-out calls separate", async () => {
    await open();
    const region = screen.getByRole("region", { name: "How this cost is worked out" });
    for (const [label, value] of [["Passed their check", "70"], ["Failed their check", "20"], ["Not checked yet", "25"], ["Left out of the checks", "5"]]) {
      expect(within(region).getByText(label).closest("div")).toHaveTextContent(value);
    }
  });

  it("says how many calls were excluded for having no price, and that their cost is unknown, not zero", async () => {
    await open();
    expect(screen.getByText(/4 unpriced runs excluded from this total\. Their cost is unknown, not zero\./)).toBeInTheDocument();
    expect(screen.getByText(/4 · cost unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/4 · \$0/)).toBeNull();
  });

  it("shows the formula with the counts that went into it and what was left out", async () => {
    await open();
    const text = screen.getByText(/= \$38\.50 ÷ 70 that passed/);
    expect(text).toHaveTextContent("from 88 checked, priced calls");
    expect(text).toHaveTextContent("Left out: 25 not checked, 2 checked without a price");
    expect(text).toHaveTextContent("A correct answer means: the answer matches your answer key (total)");
  });

  it("keeps four decimals for a sub-dollar cost per correct answer", async () => {
    await open({ ...base, cost_per_success: { ...base.cost_per_success!, value_usd: 0.0144, spend_usd: 72.67, passed: 5057 } });
    expect(screen.getByText("$0.0144")).toBeInTheDocument();
  });

  it("gives the reason instead of a number when there is no valid denominator", async () => {
    await open({ ...base, cost_per_success: { ...base.cost_per_success!, value_usd: null, passed: 0, reason: "None of the checked calls passed, so a cost per correct answer does not exist yet" } });
    expect(screen.getByText(/None of the checked calls passed/)).toBeInTheDocument();
    expect(screen.queryByText(/÷/)).toBeNull();
  });

  it("does not call failed checks wasted", async () => {
    await open();
    expect(screen.getByText("Spend on answers that failed their check")).toBeInTheDocument();
    expect(screen.getByText(/A failed check can be a deliberate test, so this is not called wasted/)).toBeInTheDocument();
  });

  it("lists the dated prices used, old and new, with where each came from", async () => {
    await open();
    expect(screen.getByText(/2 prices, per million tokens, last checked/)).toBeInTheDocument();
    expect(screen.getAllByText("acme-mini")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "source" })).toHaveAttribute("href", "https://example.com/prices.json");
    expect(screen.getByText(/entered by hand/)).toBeInTheDocument();
    expect(screen.getByText(/to 1 Jul 2026/)).toBeInTheDocument();
  });

  it("says so when no dated price is recorded", async () => {
    await open({ ...base, price_versions: [], price_versions_checked_at: null });
    expect(screen.getByText(/priced before price history existed/)).toBeInTheDocument();
  });

  it("tells the person when it could not load, never an empty box", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    renderWithProviders(<CostReceipt days={30} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "How this is worked out" }));
    expect(await screen.findByText("Could not load the details. Try again in a moment.")).toBeInTheDocument();
  });
});

describe("Compare with an invoice", () => {
  it("compares in the browser: nothing is sent, and nothing is stored", async () => {
    const calls = await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Invoice total in US dollars"), "$1,240.50");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText(/is \$1,198\.00 higher than the recorded total \(\$42\.50\)/)).toBeInTheDocument();
    expect(calls).toHaveLength(1); // only the receipt itself was fetched
    expect(JSON.stringify({ ...localStorage })).not.toContain("1240");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("1240");
  });

  it("rejects anything that is not a plain US dollar amount and says why", async () => {
    await open();
    const user = userEvent.setup();
    for (const bad of ["abc", "-20", "€50", "10 USD"]) {
      await user.clear(screen.getByLabelText("Invoice total in US dollars"));
      await user.type(screen.getByLabelText("Invoice total in US dollars"), bad);
      await user.click(screen.getByRole("button", { name: "Compare" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Enter a plain US dollar amount");
      expect(screen.getByLabelText("Invoice total in US dollars")).toHaveAttribute("aria-invalid", "true");
    }
  });

  it("lists causes from the person's own data first, then the general ones", async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Invoice total in US dollars"), "100");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    const items = await screen.findAllByRole("listitem");
    const text = items.map((i) => i.textContent ?? "");
    const mine = text.findIndex((t) => /In your data.*4 calls have no known price/.test(t));
    const general = text.findIndex((t) => /Possible.*hours or days to bill/.test(t));
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(general).toBeGreaterThan(mine);
    expect(text.some((t) => /Possible.*counts days in UTC/.test(t))).toBe(true);
  });

  it("calls a near amount close but never a match", async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Invoice total in US dollars"), "43");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText(/is close to the recorded total/)).toHaveTextContent("Close is not a match: this check cannot prove the figures agree.");
  });

  it("handles an invoice lower than the recorded total and a zero invoice", async () => {
    await open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Invoice total in US dollars"), "0");
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(await screen.findByText(/\$42\.50 lower than the recorded total/)).toBeInTheDocument();
  });
});
