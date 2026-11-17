import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";

/** One prompt (an AI task and its prompt version) and where its tokens went. */
export type PromptGroup = {
  job: string;
  prompt_version: string | null;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  share: number;
  avg_tokens_in: number;
  avg_tokens_out: number;
  cache_read_share: number | null;
  text_samples: number;
  repeated_start_share: number | null;
  repeated_end_share: number | null;
  repeated_start_preview: string | null;
};

export type PromptGroups = { days: number; total_tokens: number; groups: PromptGroup[] };

/** Which prompts use the most tokens (GET /v1/insights/prompts). */
export function fetchPromptGroups({ days = 30, job, limit = 3 }: { days?: number; job?: string; limit?: number } = {}): Promise<PromptGroups> {
  const params = new URLSearchParams({ days: String(days), limit: String(limit) });
  if (job) params.set("job", job);
  return apiFetch<PromptGroups>(`/v1/insights/prompts?${params}`);
}

export function usePromptGroups(filters: { days?: number; job?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["insights", "prompts", filters],
    queryFn: () => fetchPromptGroups(filters),
    staleTime: 60_000,
  });
}
