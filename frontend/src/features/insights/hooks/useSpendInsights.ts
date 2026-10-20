import { useQuery } from "@tanstack/react-query";
import { fetchSpendInsights } from "../api/insightsApi";

export const spendInsightsKey = ["insights", "spend"] as const;

export function useSpendInsights() {
  return useQuery({
    queryKey: spendInsightsKey,
    queryFn: fetchSpendInsights,
  });
}
