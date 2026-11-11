import { useState } from "react";
import { PageHeader } from "../shared/components/PageHeader";
import { EmptyState } from "../shared/components/EmptyState";
import { ErrorMessage } from "../shared/components/ErrorMessage";
import { Skeleton } from "../shared/components/Skeleton";
import { useLimits } from "../features/limits/hooks/useLimits";
import { LimitCard } from "../features/limits/components/LimitCard";
import { AddLimitForm } from "../features/limits/components/AddLimitForm";

export default function LimitsPage() {
  const query = useLimits();
  const [adding, setAdding] = useState(false);
  const limits = query.data ?? [];
  // The ones that need attention first.
  const order = { EXHAUSTED: 0, AT_RISK: 1, UNKNOWN: 2, OK: 3 } as const;
  const sorted = [...limits].sort((a, b) => order[a.state] - order[b.state]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage limits"
        subtitle="Whether each limit lasts until it resets at your current pace, and if not, which proven cheaper option to move each job to."
        actions={
          <button
            type="button"
            onClick={() => setAdding((x) => !x)}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:opacity-90"
          >
            {adding ? "Close" : "Add a limit"}
          </button>
        }
      />
      {(adding || (query.isSuccess && limits.length === 0)) && <AddLimitForm onDone={() => setAdding(false)} />}
      {query.isPending && <Skeleton className="h-48 w-full" />}
      {query.isError && <ErrorMessage error={query.error} onRetry={() => query.refetch()} />}
      {query.isSuccess && limits.length === 0 && (
        <EmptyState
          title="No limits yet"
          hint="Add the limits you work under, such as a plan's weekly limit or an API budget, to be warned before one runs out."
        />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {sorted.map((limit) => (
          <LimitCard key={limit.limit_id} limit={limit} />
        ))}
      </div>
    </div>
  );
}
