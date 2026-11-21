/**
 * A rough, local comparison of an invoice total the person types in with what this app recorded.
 *
 * Nothing here talks to a server or a provider, and nothing is stored: the number lives in the page until it is
 * closed. It can say "close" or "far apart" and list reasons the two can differ; it can never say the figures
 * reconcile, because invoices include things this app cannot see (other users of the same account, taxes,
 * credits, discounts, billing lag).
 */
import type { components } from "../../shared/api/generated";

export type CostReceipt = components["schemas"]["CostReceiptOut"];

/** Largest invoice the box accepts (a typo guard, not a real limit). */
export const MAX_INVOICE = 1_000_000_000;

/** "1,200.50", "$1,200.5" and "1200" are US dollar amounts. Anything else (a minus sign, text, a currency
 * code, "1e9", an empty box) is not accepted: null. Zero is allowed, since an invoice can be $0. */
export function parseInvoice(text: string): number | null {
  const t = text.trim().replace(/^\$\s*/, "");
  // Digits with optional correct thousands commas and up to two decimals.
  if (!/\d/.test(t) || !/^(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= MAX_INVOICE ? n : null;
}

export type Cause = {
  id: string;
  text: string;
  /** "yes" when the recorded data shows it applies here, "maybe" when it is only a possibility. */
  applies: "yes" | "maybe";
  /** Which way it pushes the invoice against the recorded total. */
  pushes: "invoice_higher" | "invoice_lower" | "either";
};

export type Comparison = {
  invoice: number;
  recorded: number;
  /** invoice - recorded; positive = the invoice is larger. */
  difference: number;
  /** "close" is within the larger of $1 or 3% of the bigger of the two amounts. It is a hint, not a match. */
  verdict: "close" | "invoice_higher" | "recorded_higher";
  causes: Cause[];
};

const CLOSE_FLOOR_USD = 1;
const CLOSE_SHARE = 0.03;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

export function compare(invoice: number, receipt: CostReceipt): Comparison {
  const recorded = receipt.spend_usd;
  const difference = Math.round((invoice - recorded) * 100) / 100;
  const tolerance = Math.max(CLOSE_FLOOR_USD, Math.max(invoice, recorded) * CLOSE_SHARE);
  const verdict = Math.abs(difference) <= tolerance ? "close" : difference > 0 ? "invoice_higher" : "recorded_higher";

  const basis = (status: string) => receipt.basis.find((b) => b.status === status)?.runs ?? 0;
  const noUsage = basis("NO_USAGE");
  const causes: Cause[] = [];

  if (receipt.unpriced_runs > 0) {
    causes.push({
      id: "unpriced",
      applies: "yes",
      pushes: "invoice_higher",
      text: `${plural(receipt.unpriced_runs, "call has", "calls have")} no known price, so ${receipt.unpriced_runs === 1 ? "its" : "their"} cost is not in the recorded total.`,
    });
  }
  if (noUsage > 0) {
    causes.push({
      id: "missing-usage",
      applies: "yes",
      pushes: "invoice_higher",
      text: `${plural(noUsage, "response carried", "responses carried")} no usage numbers, so ${noUsage === 1 ? "its" : "their"} tokens (and cost) are unknown.`,
    });
  }
  if (receipt.partly_priced_runs > 0) {
    causes.push({
      id: "unsupported-modifier",
      applies: "yes",
      pushes: "either",
      text: `${plural(receipt.partly_priced_runs, "call was", "calls were")} priced at the standard rate although the provider named a price-changing label this app cannot price (for example a priority tier or a fast mode).`,
    });
  }
  causes.push(
    { id: "modifiers", applies: "maybe", pushes: "either", text: "Provider tiers and options (batch, priority, region, long prompts) can change a price in ways this app does not model." },
    { id: "outside", applies: "maybe", pushes: "invoice_higher", text: "Calls made outside this app (other tools, other projects, a provider playground) are not in the recorded total. Trial runs started here are not counted in it either." },
    { id: "lag", applies: "maybe", pushes: "invoice_lower", text: "Providers can take hours or days to bill usage, so the newest calls may not be on the invoice yet." },
    { id: "timezone", applies: "maybe", pushes: "either", text: "This app counts days in UTC. Your provider may cut its billing days in another time zone, so the first and last day can differ." },
    { id: "price", applies: "maybe", pushes: "either", text: "Recorded costs use public list prices. An invoice can include discounts, credits, committed-use pricing, taxes and fees." },
  );
  // What the data shows first; then the reasons that push the same way as the gap.
  // Which way a cause has to push to explain this gap: a larger invoice needs "invoice_higher" causes, a smaller one "invoice_lower".
  const way = verdict === "close" ? null : verdict === "invoice_higher" ? "invoice_higher" : "invoice_lower";
  causes.sort((a, b) => {
    if (a.applies !== b.applies) return a.applies === "yes" ? -1 : 1;
    const fit = (c: Cause) => (way === null || c.pushes === "either" || c.pushes === way ? 0 : 1);
    return fit(a) - fit(b);
  });
  return { invoice, recorded, difference, verdict, causes };
}
