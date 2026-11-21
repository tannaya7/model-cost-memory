import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

/** What changed between two equal periods, with coverage and what else was recorded at the same time. Never a cause. */
export type Changes = components["schemas"]["ChangesOut"];
export type ChangeObservation = components["schemas"]["ObservationOut"];

export const CHANGE_DAYS = [7, 14, 30] as const;

/** True for a real answer (and not an empty list from a stubbed or older server). */
export function isChanges(value: unknown): value is Changes {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as Changes).observations) && typeof (value as Changes).current === "object";
}

/** GET /v1/insights/changes: deterministic arithmetic on this project's own calls. */
export function useChanges(days: number) {
  return useQuery({
    queryKey: ["insights", "changes", days],
    queryFn: () => apiFetch<Changes>(`/v1/insights/changes?days=${days}`),
    staleTime: 60_000,
  });
}
