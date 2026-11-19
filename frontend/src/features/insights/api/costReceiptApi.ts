import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { CostReceipt } from "../reconcile";

/** How a spend figure was worked out (GET /v1/insights/cost-receipt). Fetched only when the person opens it. */
export function useCostReceipt({ days, enabled }: { days: number; enabled: boolean }) {
  return useQuery({
    queryKey: ["insights", "cost-receipt", days],
    queryFn: () => apiFetch<CostReceipt>(`/v1/insights/cost-receipt?days=${days}`),
    enabled,
    staleTime: 60_000,
  });
}
