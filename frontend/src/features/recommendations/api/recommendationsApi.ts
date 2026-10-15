import { apiFetch } from "../../../shared/api/apiFetch";
import type { Recommendation, RegressionAlert } from "../../../shared/api/types";

/**
 * Builds the URL path for a job's recommendation endpoint.
 * Kept in one helper function so it is easy to update later.
 */
export function recommendationPath(jobName: string): string {
  return `/v1/jobs/${encodeURIComponent(jobName)}/recommendation`;
}

export function fetchRecommendation(jobName: string): Promise<Recommendation> {
  return apiFetch<Recommendation>(recommendationPath(jobName));
}

export function fetchJobRegressions(jobName: string): Promise<RegressionAlert[]> {
  return apiFetch<RegressionAlert[]>(`/v1/jobs/${encodeURIComponent(jobName)}/regressions`);
}
