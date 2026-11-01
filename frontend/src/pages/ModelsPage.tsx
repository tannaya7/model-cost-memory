import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { Card } from "../shared/components/Card";
import { ModelsFilters } from "../features/models/components/ModelsFilters";
import {
  ModelsTable,
  formatShutdownDate,
  formatShutdownCountdown,
} from "../features/models/components/ModelsTable";
import { useModels } from "../features/models/hooks/useModels";
import { fetchModels } from "../features/models/api/modelsApi";

export default function ModelsPage() {
  const [searchParams] = useSearchParams();

  const statusParam = searchParams.get("status");
  const status =
    statusParam && statusParam.toUpperCase() !== "ALL"
      ? statusParam.toUpperCase()
      : undefined;

  const used = searchParams.get("used") === "true" ? true : undefined;
  const q = searchParams.get("q") || undefined;

  const query = useModels({ status, used, q });

  // Dedicated query to identify all in-use deprecated models regardless of active table filters
  const { data: deprecatedData } = useQuery({
    queryKey: ["models", "deprecated-in-use"],
    queryFn: () => fetchModels({ used: true, status: "DEPRECATED", limit: 100 }),
  });

  const deprecatedUsedModels = deprecatedData?.items ?? [];

  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Every model your projects can use, with prices and status."
      />

      {/* Warning Card if any models in use by the project are deprecated */}
      {deprecatedUsedModels.length > 0 && (
        <Card className="mb-4 border-warn bg-warn-soft">
          <div className="space-y-2">
            <p className="font-semibold text-sm text-warn">
              {deprecatedUsedModels.length}{" "}
              {deprecatedUsedModels.length === 1
                ? "of the models you use is being shut down"
                : "of the models you use are being shut down"}
            </p>
            <ul className="space-y-1.5 text-xs">
              {deprecatedUsedModels.map((m) => {
                const countdown = m.shutdown_date
                  ? formatShutdownCountdown(m.shutdown_date)
                  : null;
                return (
                  <li
                    key={`${m.provider}_${m.model}_${m.model_version}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="font-mono font-medium text-ink">{m.model}</span>
                    <span className="text-dim">
                      — Shutdown date: {formatShutdownDate(m.shutdown_date)}
                      {countdown && ` (${countdown.text})`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      )}

      <ModelsFilters />

      <QueryState
        query={query}
        emptyTitle="No models match this filter."
        isEmpty={(data) =>
          !data || data.pages.length === 0 || data.pages.every((p) => p.items.length === 0)
        }
      >
        {(data) => {
          const allModels = data.pages.flatMap((p) => p.items);
          return (
            <ModelsTable
              models={allModels}
              hasNextPage={Boolean(query.hasNextPage)}
              isFetchingNextPage={query.isFetchingNextPage}
              fetchNextPage={query.fetchNextPage}
            />
          );
        }}
      </QueryState>
    </>
  );
}
