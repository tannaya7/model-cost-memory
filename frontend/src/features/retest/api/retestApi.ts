import { apiFetch } from "../../../shared/api/apiFetch";
import type {
  ProviderKey,
  ProviderKeyInput,
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

export function fetchJobRetests(jobName: string): Promise<RetestStatus[]> {
  return apiFetch<RetestStatus[]>(`/v1/jobs/${encodeURIComponent(jobName)}/retests`);
}

export function saveProviderKey(input: ProviderKeyInput): Promise<ProviderKey> {
  return apiFetch<ProviderKey>("/v1/provider-key", { method: "PUT", body: JSON.stringify(input) });
}

export function deleteProviderKey(): Promise<void> {
  return apiFetch<void>("/v1/provider-key", { method: "DELETE" });
}
