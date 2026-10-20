import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchRuns } from "../api/runsApi";

export interface RunsFiltersState {
  job?: string;
  model?: string;
  outcome?: string;
}

export function useRuns(filters: RunsFiltersState) {
  return useInfiniteQuery({
    queryKey: ["runs", filters],
    queryFn: ({ pageParam }) =>
      fetchRuns({
        job: filters.job || undefined,
        model: filters.model || undefined,
        outcome: filters.outcome && filters.outcome !== "ALL" ? filters.outcome : undefined,
        limit: 50,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}
