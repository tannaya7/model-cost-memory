import { useQuery } from "@tanstack/react-query";
import { fetchJobInsights, fetchSpendInsights } from "../api/insightsApi";

export const spendInsightsKey = ["insights", "spend"] as const;

export function useSpendInsights() {
  return useQuery({
    queryKey: spendInsightsKey,
    queryFn: fetchSpendInsights,
  });
}

export function useJobInsights(jobName: string | undefined) {
  return useQuery({
    queryKey: ["insights", "job", jobName],
    queryFn: () => fetchJobInsights(jobName!),
    enabled: Boolean(jobName),
  });
}
