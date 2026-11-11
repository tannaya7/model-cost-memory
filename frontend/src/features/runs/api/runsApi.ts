import { apiFetch } from "../../../shared/api/apiFetch";
import type { LabelCreate, Run, RunDetail, RunPage } from "../../../shared/api/types";

export interface FetchRunsParams {
  job?: string;
  model?: string;
  outcome?: string;
  recommendation?: string;
  limit?: number;
  cursor?: string;
}

export async function fetchRuns(params: FetchRunsParams = {}): Promise<RunPage> {
  const search = new URLSearchParams();
  if (params.limit) search.set("limit", String(params.limit));
  if (params.job) search.set("job", params.job);
  if (params.model) search.set("model", params.model);
  if (params.outcome && params.outcome !== "ALL") search.set("outcome", params.outcome);
  if (params.recommendation) search.set("recommendation", params.recommendation);
  if (params.cursor) search.set("cursor", params.cursor);

  const query = search.toString();
  return apiFetch<RunPage>(query ? `/v1/runs?${query}` : "/v1/runs");
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  return apiFetch<RunDetail>(`/v1/runs/${encodeURIComponent(runId)}`);
}

/** Late label: gives an UNKNOWN run its outcome. 409 if it already has one. */
export async function labelRun(runId: string, label: LabelCreate): Promise<Run> {
  return apiFetch<Run>(`/v1/runs/${encodeURIComponent(runId)}/label`, {
    method: "POST",
    body: JSON.stringify(label),
  });
}
