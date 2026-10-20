import { apiFetch } from "../../../shared/api/apiFetch";
import type { SpendInsight } from "../../../shared/api/types";

export function fetchSpendInsights(): Promise<SpendInsight[]> {
  return apiFetch<SpendInsight[]>("/v1/insights/spend");
}
