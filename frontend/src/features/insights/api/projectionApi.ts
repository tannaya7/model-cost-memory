import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

/** The month so far (a fact about recorded calls) and a month-end forecast (an estimate), kept apart. */
export type Projection = components["schemas"]["ProjectionOut"];

/** True for a real projection answer (and not an empty list from a stubbed or older server). */
export function isProjection(value: unknown): value is Projection {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Projection).state === "string";
}

/** GET /v1/insights/projection: the same figures the budget alerts use. */
export function useProjection() {
  return useQuery({
    queryKey: ["insights", "projection"],
    queryFn: () => apiFetch<Projection>("/v1/insights/projection"),
    staleTime: 60_000,
  });
}
