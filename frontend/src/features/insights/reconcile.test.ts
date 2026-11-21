import { describe, expect, it } from "vitest";
import { compare, parseInvoice, type CostReceipt } from "./reconcile";

const receipt = (over: Partial<CostReceipt> = {}): CostReceipt => ({
  currency: "USD", timezone: "UTC", period_start: "2026-10-18T00:00:00Z", period_end: "2026-11-17T00:00:00Z", period_days: 30,
  runs: 100, passed: 80, failed: 10, unchecked: 10, excluded: 0, spend_usd: 100, spend_on_failed_checks_usd: 12,
  unpriced_runs: 0, unpriced_note: null, partly_priced_runs: 0, basis: [], price_versions: [],
  price_versions_checked_at: null, price_versions_oldest_effective: null, cost_per_success: null, jobs: [], notes: [],
  ...over,
});

describe("parseInvoice", () => {
  it.each([["1240.50", 1240.5], ["$1,240.50", 1240.5], [" $ 12 ", 12], ["0", 0], [".5", 0.5], ["1,000", 1000], ["7.1", 7.1]])(
    "reads %s as US dollars", (text, value) => expect(parseInvoice(text)).toBe(value));

  it.each(["", "  ", "$", "-5", "abc", "1e9", "12 USD", "€5", "1.234", "1,2,3", "1,20", "5.", "NaN", "Infinity", "1 000", "$-3", "1000000001"])(
    "does not accept %j", (text) => expect(parseInvoice(text)).toBeNull());
});

describe("compare", () => {
  it("calls amounts within $1 or 3% close, and says close is not a match", () => {
    expect(compare(100.5, receipt()).verdict).toBe("close");
    expect(compare(103, receipt()).verdict).toBe("close");
    expect(compare(97, receipt()).verdict).toBe("close");
    expect(compare(104, receipt()).verdict).toBe("invoice_higher");
    expect(compare(90, receipt()).verdict).toBe("recorded_higher");
  });

  it("reports the signed difference in cents", () => {
    expect(compare(125.26, receipt()).difference).toBe(25.26);
    expect(compare(80, receipt()).difference).toBe(-20);
  });

  it("handles zero on either side", () => {
    expect(compare(0, receipt({ spend_usd: 0 })).verdict).toBe("close");
    expect(compare(10, receipt({ spend_usd: 0 })).verdict).toBe("invoice_higher");
    expect(compare(0, receipt({ spend_usd: 5 })).verdict).toBe("recorded_higher");
  });

  it("puts what the data shows ahead of the general possibilities", () => {
    const c = compare(200, receipt({ unpriced_runs: 3, basis: [{ status: "NO_USAGE", label: "x", runs: 2, spend_usd: null }], partly_priced_runs: 1 }));
    const ids = c.causes.map((x) => x.id);
    expect(ids.slice(0, 3).sort()).toEqual(["missing-usage", "unpriced", "unsupported-modifier"]);
    expect(c.causes.slice(0, 3).every((x) => x.applies === "yes")).toBe(true);
    expect(c.causes.slice(3).every((x) => x.applies === "maybe")).toBe(true);
  });

  it("always lists billing lag, time zone, provider tiers, outside calls and list-vs-invoice prices", () => {
    const ids = compare(100, receipt()).causes.map((x) => x.id);
    for (const id of ["modifiers", "outside", "lag", "timezone", "price"]) expect(ids).toContain(id);
    expect(ids).not.toContain("unpriced");
  });

  it("puts the reasons that push the same way as the gap first", () => {
    const higher = compare(300, receipt()).causes.filter((x) => x.applies === "maybe").map((x) => x.id);
    expect(higher.indexOf("outside")).toBeLessThan(higher.indexOf("lag"));
    const lower = compare(50, receipt()).causes.filter((x) => x.applies === "maybe").map((x) => x.id);
    expect(lower.indexOf("lag")).toBeLessThan(lower.indexOf("outside"));
  });

  it("uses singular wording for one call", () => {
    const text = compare(100, receipt({ unpriced_runs: 1 })).causes.find((x) => x.id === "unpriced")!.text;
    expect(text).toMatch(/^1 call has no known price/);
    expect(text).toContain("its cost");
  });

  it("never claims the figures reconcile", () => {
    const all = JSON.stringify(compare(100, receipt()));
    expect(all).not.toMatch(/reconcil|match(es)? exactly|exact/i);
  });
});
