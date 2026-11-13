import { apiFetch } from "../../../shared/api/apiFetch";
import type { JobInsights, SpendInsight } from "../../../shared/api/types";

/** Spend per job over the last `days` days (1 to 365). */
export function fetchSpendInsights(days = 30): Promise<SpendInsight[]> {
  return apiFetch<SpendInsight[]>(`/v1/insights/spend?days=${days}`);
}

/** Pass rate and cost per model, overall and broken down, over the last `days` days. */
export function fetchJobInsights(jobName: string, days = 30): Promise<JobInsights> {
  return apiFetch<JobInsights>(`/v1/jobs/${encodeURIComponent(jobName)}/insights?days=${days}`);
}
