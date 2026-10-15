import { useParams, Link } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { ApiError } from "../shared/api/apiFetch";
import { useRecommendation } from "../features/recommendations/hooks/useRecommendation";
import { RecommendationCard } from "../features/recommendations/components/RecommendationCard";

export default function JobDetailPage() {
  const { jobName } = useParams<{ jobName: string }>();
  const query = useRecommendation(jobName);

  if (query.isError && query.error instanceof ApiError && query.error.status === 404) {
    return (
      <>
        <PageHeader
          title={jobName ? decodeURIComponent(jobName) : "Job"}
          subtitle="Model recommendation and performance analysis."
          actions={
            <Link
              to="/jobs"
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-dim hover:bg-bg hover:text-ink"
            >
              ← Back to Jobs
            </Link>
          }
        />
        <div
          role="alert"
          className="rounded-card border border-bad bg-bad-soft p-8 text-center text-sm text-bad"
        >
          <p className="font-semibold text-base">We couldn't find that job.</p>
          <p className="mt-1 text-xs">There is no job named "{jobName}".</p>
          <div className="mt-4">
            <Link
              to="/jobs"
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-bg"
            >
              Back to Jobs
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={jobName ? decodeURIComponent(jobName) : "Job"}
        subtitle="Cheapest model that passes, evaluated across recorded runs."
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/jobs"
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-dim hover:bg-bg hover:text-ink"
            >
              ← Jobs
            </Link>
            {jobName && (
              <Link
                to={`/runs?job=${encodeURIComponent(jobName)}`}
                className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-accent hover:bg-bg"
              >
                View runs →
              </Link>
            )}
          </div>
        }
      />

      <QueryState
        query={query}
        emptyTitle="No recommendation available"
        emptyHint="Record more runs for this job to generate a model recommendation."
      >
        {(recommendation) => (
          <div className="space-y-6">
            <RecommendationCard recommendation={recommendation} />
          </div>
        )}
      </QueryState>
    </>
  );
}
