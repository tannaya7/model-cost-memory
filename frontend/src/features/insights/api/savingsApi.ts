import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

/** What changed in cost per correct answer after a task's model was changed, and a separate counterfactual. Never a cause. */
export type Savings = components["schemas"]["SavingsOut"];
export type SavingsEntry = components["schemas"]["SavingsEntry"];

/** True for a real answer (not an empty list from a stubbed or older server). */
export function isSavings(value: unknown): value is Savings {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as Savings).entries) && Array.isArray((value as Savings).notes);
}

/** GET /v1/insights/savings: deterministic, built only from completed days, so it does not change as the day goes on. */
export function useSavings() {
  return useQuery({
    queryKey: ["insights", "savings"],
    queryFn: () => apiFetch<Savings>("/v1/insights/savings"),
    staleTime: 5 * 60_000,
  });
}
