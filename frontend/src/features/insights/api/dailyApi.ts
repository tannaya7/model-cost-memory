import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { DayPoint } from "../../../shared/api/types";

/** Production runs, outcomes and spend per day, job and model (GET /v1/insights/daily). */
export function fetchDaily({ days = 60, job }: { days?: number; job?: string } = {}): Promise<DayPoint[]> {
  const params = new URLSearchParams({ days: String(days) });
  if (job) params.set("job", job);
  return apiFetch<DayPoint[]>(`/v1/insights/daily?${params}`);
}

export function useDaily(filters: { days?: number; job?: string } = {}) {
  return useQuery({
    queryKey: ["insights", "daily", filters],
    queryFn: () => fetchDaily(filters),
    staleTime: 60_000,
  });
}
