import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

export type Coverage = components["schemas"]["CoverageOut"];
export type CoverageShare = components["schemas"]["Share"];
export type CoverageCause = components["schemas"]["Cause"];

export interface CoverageFilters {
  days: number;
  provider: string;
  model: string;
  job: string;
}

/** How complete and reliable the records we received are (GET /v1/insights/coverage). Read-only; it cannot see calls that never reached us. */
export function useCoverage(f: CoverageFilters) {
  return useQuery({
    queryKey: ["insights", "coverage", f],
    queryFn: () => {
      const q = new URLSearchParams({ days: String(f.days) });
      if (f.provider) q.set("provider", f.provider);
      if (f.model) q.set("model", f.model);
      if (f.job) q.set("job", f.job);
      return apiFetch<Coverage>(`/v1/insights/coverage?${q.toString()}`);
    },
    staleTime: 30_000,
  });
}
