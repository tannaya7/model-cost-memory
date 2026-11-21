/**
 * "Ways to make your allowance last longer", for people who pay a flat subscription.
 * Built ONLY from facts we measure (shares and token counts). No dollar figure is ever a saving here,
 * and the cheaper-model idea carries no number: providers do not publish exact rates and we have not
 * verified how each one counts cached text. Pure, so it is easy to test.
 */
import type { AgentInsights } from "../../features/insights/api/agentsApi";
import type { PromptGroup } from "../../features/insights/api/promptsApi";
import { jobTitle } from "../../features/jobs/jobTitle";
import { count, pct } from "../../ui/format";
import { TOOL_LIST_TIP_TOKENS } from "./agentView";
import type { DayPoint } from "./metrics";
import { CACHE_MIN_INPUT_TOKENS, MIN_SHARE_FOR_TIPS, REPEATED_SHARE } from "./promptHints";

export const MIN_TEXT_SAMPLES_FOR_SHARE = 5;
export const MIN_FAILED_CALLS = 5;
export const MIN_FAILED_SHARE = 0.05;
export const MAX_WAYS = 6;

export type Way = { id: string; title: string; text: string; measured: boolean };

export const SMALLER_MODEL_TEXT =
  "A smaller model may use less of your allowance. We cannot say how much: providers do not publish exact rates, and we have not verified how each one counts cached text.";

export function allowanceWays(input: {
  groups: PromptGroup[];
  agents: Pick<AgentInsights, "tools" | "traces"> | null;
  cur: DayPoint[];
  cheaperTasks: number;
}): Way[] {
  const out: Way[] = [];
  for (const g of input.groups) {
    const start = g.repeated_start_share;
    if (g.share < MIN_SHARE_FOR_TIPS || g.text_samples < MIN_TEXT_SAMPLES_FOR_SHARE) continue;
    if (start !== null && start >= REPEATED_SHARE && g.avg_tokens_in >= CACHE_MIN_INPUT_TOKENS) {
      out.push({
        id: `start:${g.job}:${g.prompt_version ?? ""}`,
        title: `${jobTitle(g.job)}: the same start in every call`,
        text: `${pct(start, 0)} of this prompt (about ${count(Math.round(start * g.avg_tokens_in))} tokens per call) is identical every time. Keeping it at the very start and turning on prompt caching may help your allowance last longer, if your plan counts cached text for less.`,
        measured: true,
      });
    }
  }
  for (const t of input.agents?.tools ?? []) {
    if (t.avg_tools_tokens >= TOOL_LIST_TIP_TOKENS) {
      out.push({
        id: `tools:${t.job}`,
        title: `${jobTitle(t.job)}: a large tool list`,
        text: `Its list of tools adds about ${count(Math.round(t.avg_tools_tokens))} tokens to every call, ${pct(t.share_of_tokens_in, 0)} of what it sends. Sending only the tools each step needs may use less of your allowance.`,
        measured: true,
      });
    }
  }
  for (const t of input.agents?.traces ?? []) {
    const l = t.possible_loop;
    if (l) {
      out.push({
        id: `loop:${t.trace_id}`,
        title: "A possible repeated call",
        text: `${l.step} ran ${l.repeats} times in a short stretch ${l.uses_arguments ? "with the same details" : "with the same question"}. Each repeat uses allowance. This can be valid, such as polling or retries, so check the calls before changing anything.`,
        measured: true,
      });
    }
  }
  const failed = input.cur.reduce((s, p) => s + p.failed, 0);
  const runs = input.cur.reduce((s, p) => s + p.runs, 0);
  if (failed >= MIN_FAILED_CALLS && runs > 0 && failed / runs >= MIN_FAILED_SHARE) {
    out.push({
      id: "failed",
      title: "Calls whose answer was wrong",
      text: `${count(failed)} of your ${count(runs)} AI calls (${pct(failed / runs, 0)}) were checked and found wrong. Every wrong answer that gets retried uses your allowance a second time.`,
      measured: true,
    });
  }
  const ways = out.slice(0, MAX_WAYS - (input.cheaperTasks > 0 ? 1 : 0));
  if (input.cheaperTasks > 0) {
    ways.push({
      id: "smaller-model",
      title: input.cheaperTasks === 1 ? "One AI task can run on a smaller model" : `${input.cheaperTasks} AI tasks can run on a smaller model`,
      text: SMALLER_MODEL_TEXT,
      measured: false,
    });
  }
  return ways;
}
