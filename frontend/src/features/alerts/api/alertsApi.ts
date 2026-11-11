import { apiFetch } from "../../../shared/api/apiFetch";
import type { Alert, Model } from "../../../shared/api/types";
import { fetchModels } from "../../models/api/modelsApi";

export function fetchJobRegressions(jobName: string): Promise<Alert[]> {
  return apiFetch<Alert[]>(
    `/v1/jobs/${encodeURIComponent(jobName)}/regressions`,
  );
}

/** Every job's alerts in the project, open and resolved; the page filters them. */
export function fetchAllRegressions(): Promise<Alert[]> {
  return apiFetch<Alert[]>("/v1/alerts?include_resolved=true");
}

export function resolveAlert(alertId: string): Promise<Alert> {
  return apiFetch<Alert>(`/v1/alerts/${encodeURIComponent(alertId)}/resolve`, { method: "POST" });
}

export async function fetchDeprecatedModels(): Promise<Model[]> {
  const page = await fetchModels({ used: true, status: "DEPRECATED" });
  return page.items;
}
