import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJobInsights, fetchSpendInsights } from "../api/insightsApi";

export const spendInsightsKey = ["insights", "spend"] as const;

export function useSpendInsights(days = 30) {
  return useQuery({
    queryKey: [...spendInsightsKey, days],
    queryFn: () => fetchSpendInsights(days),
    placeholderData: keepPreviousData,
  });
}

export function useJobInsights(jobName: string | undefined, days = 30) {
  return useQuery({
    queryKey: ["insights", "job", jobName, days],
    queryFn: () => fetchJobInsights(jobName!, days),
    enabled: Boolean(jobName),
    placeholderData: keepPreviousData,
  });
}
