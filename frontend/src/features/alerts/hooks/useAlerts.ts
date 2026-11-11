import { useQuery } from "@tanstack/react-query";
import { fetchAllRegressions, fetchDeprecatedModels } from "../api/alertsApi";

export const regressionsKey = ["alerts", "regressions"] as const;
export const deprecatedModelsKey = ["alerts", "deprecated"] as const;

export function useAllRegressions() {
  return useQuery({
    queryKey: regressionsKey,
    queryFn: fetchAllRegressions,
  });
}

export function useDeprecatedModels() {
  return useQuery({
    queryKey: deprecatedModelsKey,
    queryFn: fetchDeprecatedModels,
  });
}
