import { apiFetch } from "../../../shared/api/apiFetch";
import type { UsageLimit, UsageLimitInput } from "../../../shared/api/types";

export function fetchLimits(): Promise<UsageLimit[]> {
  return apiFetch<UsageLimit[]>("/v1/limits");
}

export function createLimit(input: UsageLimitInput): Promise<UsageLimit> {
  return apiFetch<UsageLimit>("/v1/limits", { method: "POST", body: JSON.stringify(input) });
}

export function reportLimitUsed(limitId: string, usedPercent: number): Promise<UsageLimit> {
  return apiFetch<UsageLimit>(`/v1/limits/${encodeURIComponent(limitId)}/used`, {
    method: "PUT",
    body: JSON.stringify({ used_percent: usedPercent }),
  });
}

export function deleteLimit(limitId: string): Promise<void> {
  return apiFetch<void>(`/v1/limits/${encodeURIComponent(limitId)}`, { method: "DELETE" });
}
