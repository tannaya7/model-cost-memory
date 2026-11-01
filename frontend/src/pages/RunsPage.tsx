import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { RunsFilters } from "../features/runs/components/RunsFilters";
import { RunsTable } from "../features/runs/components/RunsTable";
import { RunDetailPanel } from "../features/runs/components/RunDetailPanel";
import { useRuns } from "../features/runs/hooks/useRuns";

export default function RunsPage() {
  const [searchParams] = useSearchParams();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const filters = {
    job: searchParams.get("job") || undefined,
    model: searchParams.get("model") || undefined,
    outcome: searchParams.get("outcome") || undefined,
    recommendation: searchParams.get("recommendation") || undefined,
  };

  const query = useRuns(filters);

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Individual calls your app recorded to AI models."
      />

      {filters.recommendation ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-accent/30 bg-accent-soft p-3 text-xs text-ink">
          <span>Showing only the runs one recommendation rests on.</span>
          <Link to="/runs" className="font-semibold text-accent hover:underline">
            Show all runs
          </Link>
        </div>
      ) : (
        <RunsFilters />
      )}

      <QueryState
        query={query}
        emptyTitle="No runs yet."
        emptyHint="Send one with the SDK"
        isEmpty={(data) => !data || data.pages.length === 0 || data.pages.every((p) => p.items.length === 0)}
      >
        {(data) => {
          const allRuns = data.pages.flatMap((p) => p.items);
          return (
            <RunsTable
              runs={allRuns}
              hasNextPage={Boolean(query.hasNextPage)}
              isFetchingNextPage={query.isFetchingNextPage}
              fetchNextPage={query.fetchNextPage}
              onSelectRun={(runId) => setSelectedRunId(runId)}
            />
          );
        }}
      </QueryState>

      <RunDetailPanel
        runId={selectedRunId}
        onClose={() => setSelectedRunId(null)}
      />
    </>
  );
}
