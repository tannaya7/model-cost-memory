import type { BillingMode } from "./hooks/useBillingMode";

/**
 * Text written by the server (an AI-written summary, an alert) can talk about dollars, savings or a bill.
 * On a flat-fee subscription that wording is wrong, so the screens do not show it there. This is a plain
 * word check, not a promise to catch every phrasing: the server wording itself is unchanged.
 */
const MONEY = /\$|\b(sav(?:e|es|ed|ing|ings)|cost|costs|costly|bill|bills|billed|billing|spend|spent|spending|budget|pay|paid)\b/i;

export function hasMoneyWording(text: string | null | undefined): boolean {
  return Boolean(text) && MONEY.test(text as string);
}

/** The server's text, or `fallback` when this is a subscription and the text talks about money. */
export function serverText<T extends string | null | undefined>(text: string | null | undefined, mode: BillingMode, fallback: T): string | T {
  if (!text) return fallback;
  return mode === "subscription" && hasMoneyWording(text) ? fallback : text;
}

export const MONEY_ALERT_FALLBACK = "This alert is about a dollar amount, which does not apply to a flat-fee plan.";

/** "Tokens are the small pieces of text AI models are billed by": a bill is wrong wording on a flat-fee plan, so a subscription reads "read and write". */
export const tokensAre = (mode: BillingMode) =>
  mode === "per_use" ? "Tokens are the small pieces of text AI models are billed by." : "Tokens are the small pieces of text AI models read and write.";
