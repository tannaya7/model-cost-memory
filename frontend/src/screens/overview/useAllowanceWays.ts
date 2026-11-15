import { useAgentInsights } from "../../features/insights/api/agentsApi";
import { usePromptGroups } from "../../features/insights/api/promptsApi";
import type { Recommendation } from "../../shared/api/types";
import { MIN_CALLS } from "./agentView";
import { allowanceWays, type Way } from "./allowanceWays";
import type { DayPoint } from "./metrics";

/** The measured ways to make an allowance last longer, for one period. A failed lookup just means fewer ways. */
export function useAllowanceWays(days: number, cur: DayPoint[], byJob: Map<string, Recommendation | null>): { pending: boolean; ways: Way[]; calls: number } {
  const prompts = usePromptGroups({ days, limit: 5 });
  const agents = useAgentInsights(days);
  const calls = cur.reduce((s, p) => s + p.runs, 0);
  const cheaperTasks = [...byJob.values()].filter((r) => r && (r.verdict === "DOWNGRADE" || r.verdict === "SWITCH")).length;
  const ways = allowanceWays({
    groups: Array.isArray(prompts.data?.groups) ? prompts.data.groups : [],
    agents: agents.data ? { tools: Array.isArray(agents.data.tools) ? agents.data.tools : [], traces: Array.isArray(agents.data.traces) ? agents.data.traces : [] } : null,
    cur,
    cheaperTasks: calls >= MIN_CALLS ? cheaperTasks : 0,
  });
  return { pending: prompts.isPending || agents.isPending, ways: calls >= MIN_CALLS ? ways : [], calls };
}
