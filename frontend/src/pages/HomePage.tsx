import { Link } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { Card } from "../shared/components/Card";
import { Skeleton } from "../shared/components/Skeleton";
import { EmptyState } from "../shared/components/EmptyState";
import { ErrorMessage } from "../shared/components/ErrorMessage";
import { StaleDataNotice } from "../shared/components/StaleDataNotice";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { useSpendInsights } from "../features/insights/hooks/useSpendInsights";
import { JobOverviewCard } from "../features/jobs/components/JobOverviewCard";
import { LimitBanner } from "../features/limits/components/LimitBanner";

export default function HomePage() {
  const jobsQuery = useJobs();
  const spendQuery = useSpendInsights();

  const spendMap = new Map((spendQuery.data ?? []).map((s) => [s.job, s]));

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Model recommendations, spend and open alerts across registered jobs."
        actions={
          <Link
            to="/jobs"
            className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-bg"
          >
            All jobs →
          </Link>
        }
      />

      <LimitBanner />

      {jobsQuery.isPending && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-5 w-24" />
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="space-y-1">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                  <div className="space-y-1">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-rule pt-3">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-20" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {jobsQuery.isError && !jobsQuery.data && (
        <ErrorMessage
          error={jobsQuery.error}
          onRetry={() => {
            jobsQuery.refetch();
            spendQuery.refetch();
          }}
        />
      )}

      {jobsQuery.isError && jobsQuery.data && (
        <StaleDataNotice
          onRetry={() => {
            jobsQuery.refetch();
            spendQuery.refetch();
          }}
        />
      )}

      {jobsQuery.data && jobsQuery.data.length === 0 && (
        <EmptyState
          title="No jobs recorded yet"
          hint={
            <span>
              <Link to="/jobs" className="text-accent underline">
                Create a job
              </Link>{" "}
              to start tracking model costs and recommendations.
            </span>
          }
        />
      )}

      {jobsQuery.data && jobsQuery.data.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {jobsQuery.data.map((job, idx) => (
            <JobOverviewCard
              key={job.job_id}
              job={job}
              spend={spendMap.get(job.name)}
              index={idx}
            />
          ))}
        </div>
      )}
    </>
  );
}
