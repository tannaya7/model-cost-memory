import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

/** MCP and tool-server calls recorded in the project: counts are exact, usage is the whole request's, never the tool's. */
export type ToolServersAnswer = components["schemas"]["ToolServersOut"];
export type McpServer = components["schemas"]["McpServerOut"];
export type McpSupport = components["schemas"]["McpSupportOut"];

export const TOOL_DAYS = [7, 30, 90] as const;

/** True for a real answer (and not an empty list from a stubbed or older server). */
export function isToolServers(value: unknown): value is ToolServersAnswer {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as ToolServersAnswer).servers) && typeof (value as ToolServersAnswer).totals === "object";
}

/** GET /v1/insights/tool-servers: analysis only; nothing is called, blocked or changed. */
export function useToolServers(days: number, job?: string) {
  return useQuery({
    queryKey: ["insights", "tool-servers", days, job ?? null],
    queryFn: () => apiFetch<ToolServersAnswer>(`/v1/insights/tool-servers?days=${days}${job ? `&job=${encodeURIComponent(job)}` : ""}`),
    staleTime: 60_000,
  });
}
