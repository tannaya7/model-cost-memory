import { apiFetch } from "../../../shared/api/apiFetch";
import type {
  ProviderKey,
  ProviderKeyInput,
  RetestCreateInput,
  RetestLimits,
  RetestPreview,
  RetestPreviewInput,
  RetestStatus,
} from "../../../shared/api/types";

export function fetchRetestLimits(): Promise<RetestLimits> {
  return apiFetch<RetestLimits>("/v1/retest/limits");
}

/** Asks what a replay would send, where, and cost. Makes no provider call and changes nothing. */
export function previewRetest(jobName: string, input: RetestPreviewInput): Promise<RetestPreview> {
  return apiFetch<RetestPreview>(`/v1/jobs/${encodeURIComponent(jobName)}/retest/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  });
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

/** Stop a queued or running trial. A queued one never starts; a running one finishes the calls already sent and keeps them. */
export function stopRetest(jobName: string, retestId: string): Promise<RetestStatus> {
  return apiFetch<RetestStatus>(
    `/v1/jobs/${encodeURIComponent(jobName)}/retest/${encodeURIComponent(retestId)}/stop`,
    { method: "POST" },
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
