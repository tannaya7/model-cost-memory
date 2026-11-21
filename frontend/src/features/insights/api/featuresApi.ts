import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

export type FeatureBreakdown = components["schemas"]["FeatureBreakdownOut"];
export type FeatureRow = components["schemas"]["FeatureRowOut"];

/** Cost, calls and quality by the label the customer's own app sent as `feature` (GET /v1/insights/features). Analysis only. */
export function useFeatureBreakdown(days: number) {
  return useQuery({
    queryKey: ["insights", "features", days],
    queryFn: () => apiFetch<FeatureBreakdown>(`/v1/insights/features?days=${days}`),
    staleTime: 60_000,
  });
}
