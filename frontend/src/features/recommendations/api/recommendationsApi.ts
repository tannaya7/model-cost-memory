import { apiFetch } from "../../../shared/api/apiFetch";
import type { History, Recommendation, RegressionAlert } from "../../../shared/api/types";

/**
 * Builds the URL path for a job's recommendation endpoint.
 * Kept in one helper function so it is easy to update later.
 */
export function recommendationPath(jobName: string): string {
  return `/v1/jobs/${encodeURIComponent(jobName)}/recommendation`;
}

/**
 * Builds the URL path for a job's history endpoint.
 * Kept in one helper function so it is easy to update later.
 */
export function historyPath(jobName: string): string {
  return `/v1/jobs/${encodeURIComponent(jobName)}/history`;
}

export function fetchRecommendation(jobName: string): Promise<Recommendation> {
  return apiFetch<Recommendation>(recommendationPath(jobName));
}

export function fetchJobHistory(jobName: string): Promise<History> {
  return apiFetch<History>(historyPath(jobName));
}

export function fetchJobRegressions(jobName: string): Promise<RegressionAlert[]> {
  return apiFetch<RegressionAlert[]>(`/v1/jobs/${encodeURIComponent(jobName)}/regressions`);
}
