import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";

/** What a row is: a task and its prompt version (the default), a task, an agent, or a prompt version across tasks. */
export type GroupBy = "task_version" | "task" | "agent" | "prompt_version" | "template";

/** One part of a total. "not_reported": no provider layout in the group reports it. "unknown": older or incomplete calls. Never a silent 0. */
export type TokenPart = {
  key: "input" | "cached_input" | "cache_write" | "output" | "reasoning" | "tool_use_input";
  label: string;
  tokens: number | null;
  state: "measured" | "not_reported" | "unknown";
  calls: number | null;
  note: string | null;
};

/** One row of "where your tokens went". The newer fields are optional so an older server still renders. */
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
  /** Masked text from the prompts. Only present when it was asked for (show_text). */
  repeated_start_preview: string | null;
  label?: string;
  group_by?: GroupBy;
  agent?: string | null;
  breakdown?: TokenPart[];
  ledger_calls?: number;
  no_usage_calls?: number;
  legacy_calls?: number;
  text_calls?: number;
  text_note?: string | null;
  /** List-price cost of the priced calls in the row. Null when none is priced: an unknown, never 0. Not an invoice. */
  spend_usd?: number | null;
  priced_calls?: number;
  /** Calls with no known cost: in no sum. */
  unpriced_calls?: number;
  cost_share?: number | null;
  /** "untagged": no version or agent label, so this grouping is an estimate. */
  grouping_basis?: "named_by_your_code" | "untagged";
};

export type PromptGroups = {
  days: number;
  total_tokens: number;
  groups: PromptGroup[];
  period_start?: string | null;
  period_end?: string | null;
  timezone?: string;
  total_calls?: number;
  group_by?: GroupBy;
  grouping_note?: string;
};

export type PromptFilters = { days?: number; job?: string; limit?: number; group_by?: GroupBy; show_text?: boolean };

/** Where the tokens went (GET /v1/insights/prompts). Prompt text is returned only with show_text. */
export function fetchPromptGroups({ days = 30, job, limit = 3, group_by, show_text }: PromptFilters = {}): Promise<PromptGroups> {
  const params = new URLSearchParams({ days: String(days), limit: String(limit) });
  if (job) params.set("job", job);
  if (group_by && group_by !== "task_version") params.set("group_by", group_by);
  if (show_text) params.set("show_text", "true");
  return apiFetch<PromptGroups>(`/v1/insights/prompts?${params}`);
}

export function usePromptGroups(filters: PromptFilters = {}) {
  return useQuery({
    queryKey: ["insights", "prompts", filters],
    queryFn: () => fetchPromptGroups(filters),
    staleTime: 60_000,
  });
}
