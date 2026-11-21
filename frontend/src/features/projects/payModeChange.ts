import { BILLING_OPTIONS } from "./components/BillingChoice";
import type { BillingMode } from "./hooks/useBillingMode";

export const billingTitle = (m: BillingMode) => BILLING_OPTIONS.find((o) => o.value === m)?.title ?? m;

const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** What really changes when the pay mode changes, in plain words (what the screens and alerts do today:
 * a subscription turns the dollar limit's alerts off but keeps the saved limit; "both" keeps them on). */
export function payModeChange(from: BillingMode, to: BillingMode, limit: number | null): string {
  const kept = limit === null ? "" : ` Your saved limit of ${money(limit)} is kept and returns if you switch back.`;
  const returns = limit === null ? "" : ` Your saved limit of ${money(limit)} starts warning again.`;
  const estimate = "Spend figures are still estimates from recorded calls at list prices, not your bill.";
  if (to === "subscription") {
    return `Switching to ${billingTitle(to)} turns off dollar limits and projected-over alerts. Screens will show allowance windows instead. ${estimate}${kept}`;
  }
  if (to === "both") {
    return from === "subscription"
      ? `Switching to ${billingTitle(to)} brings dollar figures back, labelled as list prices rather than your bill, next to your allowance. We cannot tell which calls were paid which way, so we show both.${returns}`
      : `Switching to ${billingTitle(to)} keeps dollar figures but labels them as list prices rather than your bill, and also shows your allowance. We cannot tell which calls were paid which way, so we show both. Your limit warnings stay on.`;
  }
  return from === "subscription"
    ? `Switching to ${billingTitle(to)} turns dollar figures, the spending limit and projected-over alerts back on. Screens will show dollars instead of allowance windows. ${estimate}${returns}`
    : `Switching to ${billingTitle(to)} shows dollar figures as what you pay and stops showing your allowance next to them. ${estimate} Your limit warnings stay on.`;
}
