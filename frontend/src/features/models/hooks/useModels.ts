import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchModels } from "../api/modelsApi";

export interface ModelsFiltersState {
  status?: string;
  used?: boolean;
  q?: string;
}

export function useModels(filters: ModelsFiltersState) {
  return useInfiniteQuery({
    queryKey: ["models", filters],
    queryFn: ({ pageParam }) =>
      fetchModels({
        status: filters.status,
        used: filters.used,
        q: filters.q,
        limit: 100,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}
