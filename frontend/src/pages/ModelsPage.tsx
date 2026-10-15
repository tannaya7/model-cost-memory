import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { ModelsFilters } from "../features/models/components/ModelsFilters";
import { ModelsTable } from "../features/models/components/ModelsTable";
import { useModels } from "../features/models/hooks/useModels";

export default function ModelsPage() {
  const [searchParams] = useSearchParams();
  const statusParam = searchParams.get("status");
  const status = statusParam && statusParam.toUpperCase() !== "ALL" ? statusParam.toUpperCase() : undefined;

  const query = useModels({ status });

  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Every model your projects can use, with prices and status."
      />

      <ModelsFilters />

      <QueryState
        query={query}
        emptyTitle="No models match this filter."
        isEmpty={(data) => !data || data.pages.length === 0 || data.pages.every((p) => p.items.length === 0)}
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
