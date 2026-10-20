import { apiFetch } from "../../../shared/api/apiFetch";
import type {
  RetestCreateInput,
  RetestLimits,
  RetestStatus,
} from "../../../shared/api/types";

export function fetchRetestLimits(): Promise<RetestLimits> {
  return apiFetch<RetestLimits>("/v1/retest/limits");
}

export function startRetest(
  jobName: string,
  input: RetestCreateInput,
): Promise<RetestStatus> {
  return apiFetch<RetestStatus>(`/v1/jobs/${encodeURIComponent(jobName)}/retest`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function fetchRetestStatus(
  jobName: string,
  retestId: string,
): Promise<RetestStatus> {
  return apiFetch<RetestStatus>(
    `/v1/jobs/${encodeURIComponent(jobName)}/retest/${encodeURIComponent(retestId)}`,
  );
}
