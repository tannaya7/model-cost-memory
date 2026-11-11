import { Link, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { useRetestStatus } from "../features/retest/hooks/useRetest";
import { RetestProgress } from "../features/retest/components/RetestProgress";

export default function RetestRunPage() {
  const { retestId } = useParams<{ retestId: string }>();
  const [searchParams] = useSearchParams();
  const job = searchParams.get("job") || "";

  const query = useRetestStatus(job, retestId || "");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Re-test Run"
        subtitle={
          job
            ? `Live evaluation progress for ${job}`
            : "Live re-test evaluation progress and spend tracking."
        }
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/retest"
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-dim hover:bg-bg hover:text-ink"
            >
              ← All Re-tests
            </Link>
            {job && (
              <Link
                to={`/jobs/${encodeURIComponent(job)}`}
                className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-dim hover:bg-bg hover:text-ink"
              >
                View Job
              </Link>
            )}
          </div>
        }
      />

      {!job || !retestId ? (
        <div className="rounded-card border border-bad/30 bg-bad-soft p-6 text-center text-sm text-bad">
          <p className="font-semibold">Missing Job or Re-test ID</p>
          <p className="mt-1 text-xs">
            Please navigate to this page from a valid re-test session.
          </p>
          <div className="mt-4">
            <Link
              to="/retest"
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent"
            >
              Go to Re-test Form
            </Link>
          </div>
        </div>
      ) : (
        <QueryState
          query={query}
          emptyTitle="Re-test run not found"
          emptyHint="The requested re-test run could not be found."
        >
          {(retest) => <RetestProgress retest={retest} />}
        </QueryState>
      )}
    </div>
  );
}
