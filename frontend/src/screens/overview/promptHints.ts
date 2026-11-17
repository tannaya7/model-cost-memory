/** Plain tips for writing cheaper prompts, from how a prompt's tokens are spent. Rules are our choices, not promises. */
import type { PromptGroup } from "../../features/insights/api/promptsApi";
import type { BillingMode } from "../../features/projects/hooks/useBillingMode";

export type Hint = { id: string; title: string; text: string };

// Our choices, not provider rules.
export const MIN_SHARE_FOR_TIPS = 0.1; // only prompts using at least 10% of the tokens get tips
export const REPEATED_SHARE = 0.3; // "a lot" of the prompt is the same every call
export const REPEATED_START_MAX_FOR_END_TIP = 0.1;
export const CACHE_MIN_INPUT_TOKENS = 1000; // many providers only cache prompts of about this size or more
export const HEAVY_INPUT_RATIO = 20; // input tokens per output token
export const GOOD_CACHE_SHARE = 0.3;
export const MAX_TIPS = 2;

const pctOf = (x: number) => `${Math.round(x * 100)}%`;

/** Subscription projects get allowance-neutral wording: we have not verified how a plan counts cached text. */
export function promptHints(g: PromptGroup, mode: BillingMode = "per_use"): Hint[] {
  const sub = mode === "subscription";
  if (g.share < MIN_SHARE_FOR_TIPS) return [];
  const tips: Hint[] = [];
  const start = g.repeated_start_share;
  const end = g.repeated_end_share;

  if (start !== null && start >= REPEATED_SHARE && g.avg_tokens_in >= CACHE_MIN_INPUT_TOKENS) {
    tips.push({
      id: "repeated-start",
      title: "Much of the prompt repeats",
      text: sub
        ? `${pctOf(start)} of this prompt is the same in every call. Some providers count text they have already seen differently, so keeping the start of the prompt the same may help. We have not verified how your plan counts it.`
        : `${pctOf(start)} of this prompt is the same in every call. Many providers charge much less for text they have already seen. Keep it at the very start and turn on prompt caching with your provider.`,
    });
  }
  if (end !== null && end >= REPEATED_SHARE && (start ?? 0) < REPEATED_START_MAX_FOR_END_TIP) {
    tips.push({
      id: "repeated-end",
      title: "Repeated text is at the end",
      text: "The repeated instructions are at the END of the prompt. Caching only works on the start, so try moving them to the beginning.",
    });
  }
  if (g.avg_tokens_out > 0 && g.avg_tokens_in >= HEAVY_INPUT_RATIO * g.avg_tokens_out) {
    tips.push({ id: "heavy-input", title: "A lot goes in, little comes out", text: "You send a lot to get a little back. Check that every part you send is needed." });
  }
  if (g.avg_tokens_out > 0 && g.avg_tokens_out >= g.avg_tokens_in) {
    tips.push({ id: "long-answers", title: "Long answers", text: sub ? "The AI writes a lot in each answer. Asking for shorter answers, or setting a maximum length, can make each call smaller." : "The AI writes a lot in each answer. Asking for shorter answers, or setting a maximum length, can cut the cost." });
  }

  const out = tips.slice(0, MAX_TIPS);
  if (g.cache_read_share !== null && g.cache_read_share >= GOOD_CACHE_SHARE) {
    out.push({ id: "cache-helping", title: "Caching is helping", text: `Good: about ${pctOf(g.cache_read_share)} of what you send is already read from cache.` });
  }
  return out;
}
