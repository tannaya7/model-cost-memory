import { lazy, Suspense } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { ApiError } from "../shared/api/apiFetch";
import { EmptyState } from "../shared/components/EmptyState";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { Skeleton } from "../shared/components/Skeleton";

// The chart library is loaded only when the breakdown tab is opened.
const JobBreakdown = lazy(() => import("../features/insights/components/JobBreakdown"));
import { useRecommendation } from "../features/recommendations/hooks/useRecommendation";
import { RecommendationCard } from "../features/recommendations/components/RecommendationCard";
import { JobEvidenceSection } from "../features/recommendations/components/JobEvidenceSection";
import { JobHistoryTimeline } from "../features/recommendations/components/JobHistoryTimeline";
import { JobCompareTable } from "../features/recommendations/components/JobCompareTable";

export default function JobDetailPage() {
  const { jobName } = useParams<{ jobName: string }>();
  const query = useRecommendation(jobName);
  // Hooks must run before any early return (React rules of hooks).
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "recommendation";

  // A 404 from the recommendation endpoint does not mean the job is missing (the endpoint may
  // not be deployed yet), so only the jobs list decides that.
  const jobs = useJobs();
  const jobMissing = jobs.isSuccess && !jobs.data.some((j) => j.name === jobName);
  const noRecommendation =
    !jobMissing && query.isError && query.error instanceof ApiError && query.error.status === 404;
  const noRecommendationNotice = (
    <EmptyState
      title="No recommendation yet"
      hint="The server has none for this job yet. Its runs are still recorded: see View runs."
    />
  );

  if (jobMissing) {
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


  const handleTabChange = (tabId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tabId === "recommendation") {
        next.delete("tab");
      } else {
        next.set("tab", tabId);
      }
      return next;
    });
  };

  const tabs = [
    { id: "recommendation", label: "Recommendation" },
    { id: "history", label: "History" },
    { id: "compare", label: "Compare" },
    { id: "breakdown", label: "Breakdown" },
  ];

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

      <div className="space-y-6">
        {/* Accessible Tabs */}
        <div
          role="tablist"
          aria-label="Job views"
          className="flex border-b border-rule gap-2 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={isSelected}
                aria-controls={`panel-${tab.id}`}
                tabIndex={0}
                onClick={() => handleTabChange(tab.id)}
                className={`-mb-px min-h-[40px] border-b-2 px-4 py-2 text-sm font-medium transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent ${
                  isSelected
                    ? "border-accent text-accent font-semibold"
                    : "border-transparent text-dim hover:border-rule hover:text-ink"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Panels */}
        {activeTab === "recommendation" && (
          <div
            role="tabpanel"
            id="panel-recommendation"
            aria-labelledby="tab-recommendation"
          >
            {noRecommendation ? noRecommendationNotice : (
              <QueryState
                query={query}
                emptyTitle="No recommendation available"
                emptyHint="Record more runs for this job to generate a model recommendation."
              >
                {(recommendation) => (
                  <div className="space-y-6">
                    <RecommendationCard recommendation={recommendation} />
                    {recommendation.retest_candidates.length > 0 && (
                      <div className="rounded-card border border-accent/20 bg-accent-soft p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-ink">A re-test would settle this</p>
                          {recommendation.next_step && (
                            <p className="text-xs text-dim mt-0.5">{recommendation.next_step}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          {recommendation.retest_candidates.map((model) => (
                            <Link
                              key={model}
                              to={`/retest?job=${encodeURIComponent(recommendation.job)}&model=${encodeURIComponent(model)}`}
                              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent hover:opacity-90 transition-opacity"
                            >
                              Re-test {model} →
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                    {recommendation.verdict === "INSUFFICIENT_EVIDENCE" && recommendation.retest_candidates.length === 0 && (
                      <div className="rounded-card border border-accent/20 bg-accent-soft p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-ink">
                            Need more data to evaluate models?
                          </p>
                          <p className="text-xs text-dim mt-0.5">
                            Run a safe re-test using historical prompts to collect evidence on cheaper candidate models.
                          </p>
                        </div>
                        <Link
                          to={`/retest?job=${encodeURIComponent(recommendation.job)}`}
                          className="shrink-0 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent hover:opacity-90 transition-opacity"
                        >
                          Start a re-test →
                        </Link>
                      </div>
                    )}
                    <JobEvidenceSection recommendation={recommendation} />
                  </div>
                )}
              </QueryState>
            )}
          </div>
        )}

        {activeTab === "history" && jobName && (
          <div
            role="tabpanel"
            id="panel-history"
            aria-labelledby="tab-history"
          >
            <JobHistoryTimeline jobName={jobName} />
          </div>
        )}

        {activeTab === "breakdown" && jobName && (
          <div role="tabpanel" id="panel-breakdown" aria-labelledby="tab-breakdown">
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <JobBreakdown jobName={jobName} />
            </Suspense>
          </div>
        )}

        {activeTab === "compare" && (
          <div
            role="tabpanel"
            id="panel-compare"
            aria-labelledby="tab-compare"
          >
            {noRecommendation ? noRecommendationNotice : (
              <QueryState
                query={query}
                emptyTitle="No comparison data available"
                emptyHint="Record runs across candidate models to see comparisons."
              >
                {(recommendation) => (
                  <JobCompareTable recommendation={recommendation} />
                )}
              </QueryState>
            )}
          </div>
        )}
      </div>
    </>
  );
}
