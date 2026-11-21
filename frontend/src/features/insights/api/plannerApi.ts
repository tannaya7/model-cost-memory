import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

export type Planner = components["schemas"]["PlannerOut"];
export type ModelPlan = components["schemas"]["ModelPlan"];
export type PlannerScenario = components["schemas"]["ScenarioOut"];

export interface PlannerInput {
  job: string;
  days: number;
  calls: number[];
  retryRate: number;
  inputChangePct: number;
  outputChangePct: number;
  excludeFarOut: boolean;
  period: "day" | "week" | "month";
}

/** The planner's typed assumptions as a query string. The screen and its CSV file both use it, so they can never disagree. */
export function plannerQuery(i: PlannerInput): string {
  const q = new URLSearchParams({
    job: i.job,
    days: String(i.days),
    retry_rate: String(i.retryRate),
    input_change_pct: String(i.inputChangePct),
    output_change_pct: String(i.outputChangePct),
    exclude_far_out: String(i.excludeFarOut),
    period: i.period,
  });
  i.calls.forEach((c) => q.append("calls", String(c)));
  return q.toString();
}

/** Scenario costs for one task from its own recorded calls and the numbers the user typed (GET /v1/insights/planner).
 *  A read of our own server: no provider is called and nothing is changed. */
export function usePlanner(input: PlannerInput | null) {
  return useQuery({
    queryKey: ["insights", "planner", input],
    enabled: input !== null,
    queryFn: () => apiFetch<Planner>(`/v1/insights/planner?${plannerQuery(input as PlannerInput)}`),
    staleTime: 30_000,
  });
}
