import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

export type AgentInsights = components["schemas"]["AgentInsightsOut"];
export type AgentUsage = components["schemas"]["AgentUsageOut"];
export type TraceUsage = components["schemas"]["TraceUsageOut"];
export type ToolsUsage = components["schemas"]["ToolsUsageOut"];

/** Who uses the tokens: per agent, heaviest runs, tool-list size (GET /v1/insights/agents). */
export function fetchAgentInsights(days = 30): Promise<AgentInsights> {
  return apiFetch<AgentInsights>(`/v1/insights/agents?days=${days}`);
}

export function useAgentInsights(days = 30) {
  return useQuery({ queryKey: ["insights", "agents", days], queryFn: () => fetchAgentInsights(days), staleTime: 60_000 });
}
