import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchNews, refreshNews, type NewsFilters } from "../api/newsApi";

export const newsKey = ["news"] as const;

export function useNews(filters: NewsFilters) {
  return useQuery({
    queryKey: [...newsKey, filters],
    queryFn: () => fetchNews(filters),
    placeholderData: keepPreviousData, // switching a filter keeps the old cards until the new ones arrive
    staleTime: 60_000,
  });
}

export function useRefreshNews() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshNews,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: newsKey });
    },
  });
}
