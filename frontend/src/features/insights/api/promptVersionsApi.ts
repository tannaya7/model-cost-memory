import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";

/** One prompt version of one AI task (tagged by the developer, or detected from the prompt text). */
export type PromptVersion = {
  label: string;
  kind: "tagged" | "detected" | "untagged";
  first_seen: string;
  last_seen: string;
  calls: number;
  typical_tokens_in: number;
  typical_tokens_out: number;
  cache_read_share: number | null;
  priced_calls: number;
  unpriced_calls: number;
  cost_per_call: number | null;
  checked: number;
  correct_rate: number | null;
  rate_low: number | null;
  rate_high: number | null;
  start_preview: string | null;
};

export type PromptVersions = {
  job: string;
  days: number;
  source: "tagged" | "detected" | "none";
  reason: "no_calls" | "text_not_kept" | "no_change" | "unstable" | null;
  versions: PromptVersion[];
  comparison: { older: string; newer: string; side_by_side: boolean; summary: string } | null;
};

/** GET /v1/insights/prompt-versions */
export function usePromptVersions({ job, days = 30 }: { job: string; days?: number }) {
  return useQuery({
    queryKey: ["insights", "prompt-versions", job, days],
    queryFn: () => apiFetch<PromptVersions>(`/v1/insights/prompt-versions?${new URLSearchParams({ job, days: String(days) })}`),
    staleTime: 60_000,
  });
}
