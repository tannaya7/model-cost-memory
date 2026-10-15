import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { Card } from "../shared/components/Card";
import { Skeleton } from "../shared/components/Skeleton";
import { ErrorMessage } from "../shared/components/ErrorMessage";
import { EmptyState } from "../shared/components/EmptyState";
import { useAllRegressions, useDeprecatedModels } from "../features/alerts/hooks/useAlerts";
import { AlertsFilters } from "../features/alerts/components/AlertsFilters";
import { AlertItemCard, type AlertListItem } from "../features/alerts/components/AlertItemCard";

export default function AlertsPage() {
  const [searchParams] = useSearchParams();
  const stateFilter = (searchParams.get("state") || "open").toLowerCase();

  const regressionsQuery = useAllRegressions();
  const deprecatedQuery = useDeprecatedModels();

  const isPending = regressionsQuery.isPending || deprecatedQuery.isPending;
  const isError = regressionsQuery.isError || deprecatedQuery.isError;
  const error = regressionsQuery.error || deprecatedQuery.error;

  const regressions = regressionsQuery.data || [];
  const deprecated = deprecatedQuery.data || [];

  const openCount =
    regressions.filter((r) => r.resolved_at === null).length + deprecated.length;
  const resolvedCount = regressions.filter((r) => r.resolved_at !== null).length;
  const allCount = regressions.length + deprecated.length;

  let items: AlertListItem[] = [];

  if (stateFilter === "open") {
    const openRegressions: AlertListItem[] = regressions
      .filter((r) => r.resolved_at === null)
      .map((r) => ({ kind: "regression", alert: r, timestamp: r.created_at }));
    const deprecationWarnings: AlertListItem[] = deprecated.map((m) => ({
      kind: "deprecation",
      model: m,
      timestamp: m.shutdown_date
        ? `${m.shutdown_date}T00:00:00Z`
        : m.first_seen_at || "",
    }));
    items = [...openRegressions, ...deprecationWarnings];
  } else if (stateFilter === "resolved") {
    items = regressions
      .filter((r) => r.resolved_at !== null)
      .map((r) => ({ kind: "regression", alert: r, timestamp: r.created_at }));
  } else {
    // "all"
    const allRegressions: AlertListItem[] = regressions.map((r) => ({
      kind: "regression",
      alert: r,
      timestamp: r.created_at,
    }));
    const deprecationWarnings: AlertListItem[] = deprecated.map((m) => ({
      kind: "deprecation",
      model: m,
      timestamp: m.shutdown_date
        ? `${m.shutdown_date}T00:00:00Z`
        : m.first_seen_at || "",
    }));
    items = [...allRegressions, ...deprecationWarnings];
  }

  // Sort newest first
  items.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Quality drops and models being shut down."
      />

      <AlertsFilters
        counts={
          isPending
            ? undefined
            : { open: openCount, resolved: resolvedCount, all: allCount }
        }
      />

      {isPending && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-9 w-3/4" />
              <div className="flex justify-between pt-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-4 w-24" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {!isPending && isError && (
        <ErrorMessage
          error={error}
          onRetry={() => {
            regressionsQuery.refetch();
            deprecatedQuery.refetch();
          }}
        />
      )}

      {!isPending && !isError && items.length === 0 && (
        <>
          {stateFilter === "open" && (
            <EmptyState
              title="No open alerts. Everything looks healthy."
              hint="Quality drops and model deprecations will appear here."
            />
          )}
          {stateFilter === "resolved" && (
            <EmptyState
              title="No resolved alerts."
              hint="Resolved regression alerts will be stored here."
            />
          )}
          {stateFilter === "all" && (
            <EmptyState
              title="No alerts recorded."
              hint="No quality regressions or model deprecation warnings found."
            />
          )}
        </>
      )}

      {!isPending && !isError && items.length > 0 && (
        <div className="space-y-4">
          {items.map((item) => (
            <AlertItemCard
              key={
                item.kind === "regression"
                  ? item.alert.alert_id
                  : `dep-${item.model.model}`
              }
              item={item}
            />
          ))}
        </div>
      )}
    </>
  );
}
