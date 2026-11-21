import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

/** Tasks (calls sharing a trace id) as trees of parents and children, possible repeated calls with their evidence, and cohorts of
 * equivalent tasks. Analysis only: nothing is stopped, cancelled or reconfigured. */
export type AgentTasks = components["schemas"]["AgentTasksOut"];
export type AgentTaskSummary = components["schemas"]["AgentTaskSummaryOut"];
export type AgentTask = components["schemas"]["AgentTaskOut"];
export type TaskNode = components["schemas"]["TaskNodeOut"];
export type RepeatedCall = components["schemas"]["RepeatedCallOut"];
export type Cohort = components["schemas"]["CohortOut"];

export const TASK_DAYS = [7, 30, 90] as const;

export function isAgentTasks(value: unknown): value is AgentTasks {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as AgentTasks).tasks) && Array.isArray((value as AgentTasks).cohorts);
}
export function isAgentTask(value: unknown): value is AgentTask {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as AgentTask).nodes) && typeof (value as AgentTask).totals === "object";
}

export function useAgentTasks(days: number, repeats: number, window: number) {
  return useQuery({
    queryKey: ["insights", "agent-tasks", days, repeats, window],
    queryFn: () => apiFetch<AgentTasks>(`/v1/insights/agent-tasks?days=${days}&repeats=${repeats}&window=${window}`),
    staleTime: 60_000,
  });
}

export function useAgentTask(traceId: string | null, repeats: number, window: number) {
  return useQuery({
    queryKey: ["insights", "agent-task", traceId, repeats, window],
    queryFn: () => apiFetch<AgentTask>(`/v1/insights/agent-task?trace_id=${encodeURIComponent(traceId as string)}&repeats=${repeats}&window=${window}`),
    enabled: traceId !== null,
    staleTime: 60_000,
  });
}
