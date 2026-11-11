import { apiFetch } from "../../../shared/api/apiFetch";
import type { JobInsights, SpendInsight } from "../../../shared/api/types";

export function fetchSpendInsights(): Promise<SpendInsight[]> {
  return apiFetch<SpendInsight[]>("/v1/insights/spend");
}

export function fetchJobInsights(jobName: string): Promise<JobInsights> {
  return apiFetch<JobInsights>(`/v1/jobs/${encodeURIComponent(jobName)}/insights`);
}
