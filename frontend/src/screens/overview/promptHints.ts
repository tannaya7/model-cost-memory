/**
 * Short, evidence-based observations about how a prompt's tokens are spent. They say what was seen and, where it
 * matters, how it was seen (measured over every call, or estimated from a sample of stored prompts). They never
 * promise a saving, a number of tokens or an amount of money: whether a change helps depends on the provider, the
 * model and the settings. Thresholds are our choices, not provider rules.
 */
import type { PromptGroup } from "../../features/insights/api/promptsApi";
import type { BillingMode } from "../../features/projects/hooks/useBillingMode";

export type Hint = {
  id: string;
  title: string;
  text: string;
  /** "measured": counted over every call. "estimated": inferred from a sample of the stored prompt text. */
  basis: "measured" | "estimated";
};

export const MIN_SHARE_FOR_TIPS = 0.1; // only rows using at least 10% of the tokens get observations
export const REPEATED_SHARE = 0.3; // "large": at least this share of a sampled prompt is the same in every call
export const REPEATED_START_MAX_FOR_END_TIP = 0.1;
export const CACHE_MIN_INPUT_TOKENS = 1000; // many providers only cache prompts of about this size or more
export const HEAVY_INPUT_RATIO = 20; // input tokens per output token
export const GOOD_CACHE_SHARE = 0.3;
export const MAX_TIPS = 2;

const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const tokens = (n: number) => Math.round(n).toLocaleString("en");

/** Subscription projects get allowance-neutral wording: how a plan counts cached text has not been verified. */
export function promptHints(g: PromptGroup, mode: BillingMode = "per_use"): Hint[] {
  const sub = mode === "subscription";
  if (g.share < MIN_SHARE_FOR_TIPS) return [];
  const tips: Hint[] = [];
  const start = g.repeated_start_share;
  const end = g.repeated_end_share;
  const sample = g.text_samples > 0 ? ` (the newest ${g.text_samples} calls with stored text)` : "";

  if (start !== null && start >= REPEATED_SHARE && g.avg_tokens_in >= CACHE_MIN_INPUT_TOKENS) {
    tips.push({
      id: "repeated-start",
      title: "Large repeated input observed",
      basis: "estimated",
      text: sub
        ? `About ${pctOf(start)} of the sampled prompts${sample} starts the same way in every call. Some providers count text they have already seen differently. We have not verified how your plan counts it.`
        : `About ${pctOf(start)} of the sampled prompts${sample} starts the same way in every call. Providers that cache repeated input may charge less for it. Whether that applies depends on your provider, model and settings.`,
    });
  }
  if (end !== null && end >= REPEATED_SHARE && (start ?? 0) < REPEATED_START_MAX_FOR_END_TIP) {
    tips.push({
      id: "repeated-end",
      title: "Repeated text sits at the end",
      basis: "estimated",
      text: `About ${pctOf(end)} of the sampled prompts${sample} ends the same way in every call, while the start changes. Caching of repeated input usually matches from the start, so the order of the parts may matter.`,
    });
  }
  if (g.avg_tokens_out > 0 && g.avg_tokens_in >= HEAVY_INPUT_RATIO * g.avg_tokens_out) {
    tips.push({
      id: "heavy-input",
      title: "Much more goes in than comes out",
      basis: "measured",
      text: `On average about ${tokens(g.avg_tokens_in)} tokens go in for ${tokens(g.avg_tokens_out)} out. It may be worth checking that every part you send is needed.`,
    });
  }
  if (g.avg_tokens_out > 0 && g.avg_tokens_out >= g.avg_tokens_in) {
    tips.push({
      id: "long-answers",
      title: "Answers as long as the input",
      basis: "measured",
      text: `On average about ${tokens(g.avg_tokens_out)} tokens come out for ${tokens(g.avg_tokens_in)} in. ${sub ? "A maximum length, or a request for shorter answers, makes each call smaller." : "A maximum length, or a request for shorter answers, can make each call smaller."}`,
    });
  }

  const out = tips.slice(0, MAX_TIPS);
  if (g.cache_read_share !== null && g.cache_read_share >= GOOD_CACHE_SHARE) {
    out.push({
      id: "cache-helping",
      title: "Cached input observed",
      basis: "measured",
      text: `About ${pctOf(g.cache_read_share)} of the input was read from the provider's cache.`,
    });
  }
  return out;
}
