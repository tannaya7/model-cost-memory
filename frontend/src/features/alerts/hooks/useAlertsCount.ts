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

  const openRegressionsCount =
    regressionsQuery.data?.filter((a) => a.resolved_at === null).length ?? 0;
  const deprecatedCount = deprecatedQuery.data?.length ?? 0;

  const count = openRegressionsCount + deprecatedCount;

  return {
    count,
    isPending,
    isError,
  };
}
