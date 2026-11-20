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

/** Scenario costs for one task from its own recorded calls and the numbers the user typed (GET /v1/insights/planner).
 *  A read of our own server: no provider is called and nothing is changed. */
export function usePlanner(input: PlannerInput | null) {
  return useQuery({
    queryKey: ["insights", "planner", input],
    enabled: input !== null,
    queryFn: () => {
      const i = input as PlannerInput;
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
      return apiFetch<Planner>(`/v1/insights/planner?${q.toString()}`);
    },
    staleTime: 30_000,
  });
}
