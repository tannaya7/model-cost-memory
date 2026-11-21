import { useAllRegressions, useDeprecatedModels } from "./useAlerts";

export function useAlertsCount(): {
  count: number;
  isPending: boolean;
  isError: boolean;
} {
  const regressionsQuery = useAllRegressions();
  const deprecatedQuery = useDeprecatedModels();

  const isPending = regressionsQuery.isPending || deprecatedQuery.isPending;
  const isError = regressionsQuery.isError || deprecatedQuery.isError;

  // A "model is being shut down" alert and the deprecated-models list are the same news: count it once.
  const deprecatedModels = new Set((deprecatedQuery.data ?? []).map((m) => m.model));
  const openRegressionsCount =
    regressionsQuery.data?.filter(
      (a) => a.resolved_at === null && !(a.kind === "MODEL_RETIRING" && deprecatedModels.has(String(a.detail?.model))),
    ).length ?? 0;
  const deprecatedCount = deprecatedQuery.data?.length ?? 0;

  const count = openRegressionsCount + deprecatedCount;

  return {
    count,
    isPending,
    isError,
  };
}
