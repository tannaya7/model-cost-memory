import { useEffect } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { ApiError } from "../shared/api/apiFetch";
import { EmptyState } from "../shared/components/EmptyState";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { useRecommendation } from "../features/recommendations/hooks/useRecommendation";
import { RecommendationSection } from "../features/recommendations/components/engineer/RecommendationSection";
import {
  AlertsSection,
  BreakdownSection,
  CatalogSection,
  CompareSection,
  HistorySection,
  RunsSection,
  SpendSection,
} from "../features/recommendations/components/engineer/Sections";

export default function JobDetailPage() {
  const { jobName } = useParams<{ jobName: string }>();
  const query = useRecommendation(jobName);
  // Hooks must run before any early return (React rules of hooks).
  const [searchParams] = useSearchParams();
  // Old links (?tab=history) still land on that part of the page.
  const tab = searchParams.get("tab");
  useEffect(() => {
    if (!tab) return;
    const id = tab === "breakdown" ? "breakdowns" : tab;
    const t = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start" }), 600);
    return () => window.clearTimeout(t);
  }, [tab]);

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


  const job = jobs.data?.find((j) => j.name === jobName);
  const sections = [
    { id: "recommendation", label: "Which model" },
    { id: "compare", label: "Compare" },
    { id: "alerts", label: "Alerts" },
    { id: "history", label: "History" },
    { id: "breakdowns", label: "Breakdowns" },
    { id: "spend", label: "Spend" },
    { id: "catalog", label: "Catalog" },
    { id: "runs", label: "Latest runs" },
  ];

  return (
    <>
      <PageHeader
        title={jobName ? decodeURIComponent(jobName) : "Job"}
        subtitle="What the engineer gets back: which model to use, the evidence, alerts, history, breakdowns, spend, catalog and the runs behind it."
        actions={
          <div className="flex items-center gap-2">
            {job && (
              <span className="rounded-full bg-accent px-3 py-1.5 font-mono text-xs font-semibold text-on-accent">
                {job.name} · {job.run_count.toLocaleString()} runs
              </span>
            )}
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

      <nav
        aria-label="Sections of this job"
        className="sticky top-0 z-10 -mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-rule bg-bg/90 px-1 py-2 backdrop-blur"
      >
        {sections.map((x) => (
          <a
            key={x.id}
            href={`#${x.id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(x.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold text-dim hover:bg-surface hover:text-accent"
          >
            {x.label}
          </a>
        ))}
      </nav>

      <div className="space-y-6">
        {noRecommendation ? (
          noRecommendationNotice
        ) : (
          <QueryState
            query={query}
            emptyTitle="No recommendation available"
            emptyHint="Record more runs for this job to generate a model recommendation."
          >
            {(recommendation) => (
              <div className="space-y-6">
                <RecommendationSection recommendation={recommendation} />
                {recommendation.retest_candidates.length > 0 && (
                  <div className="flex flex-col items-start justify-between gap-3 rounded-card border border-accent/20 bg-accent-soft p-4 sm:flex-row sm:items-center">
                    <div>
                      <p className="text-sm font-semibold text-ink">A re-test would settle this</p>
                      {recommendation.next_step && <p className="mt-0.5 text-xs text-dim">{recommendation.next_step}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {recommendation.retest_candidates.map((model) => (
                        <Link
                          key={model}
                          to={`/retest?job=${encodeURIComponent(recommendation.job)}&model=${encodeURIComponent(model)}`}
                          className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
                        >
                          Re-test {model} →
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                {recommendation.verdict === "INSUFFICIENT_EVIDENCE" && recommendation.retest_candidates.length === 0 && (
                  <div className="flex flex-col items-start justify-between gap-3 rounded-card border border-accent/20 bg-accent-soft p-4 sm:flex-row sm:items-center">
                    <div>
                      <p className="text-sm font-semibold text-ink">Need more data to evaluate models?</p>
                      <p className="mt-0.5 text-xs text-dim">
                        Run a safe re-test using historical prompts to collect evidence on cheaper candidate models.
                      </p>
                    </div>
                    <Link
                      to={`/retest?job=${encodeURIComponent(recommendation.job)}`}
                      className="shrink-0 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
                    >
                      Start a re-test →
                    </Link>
                  </div>
                )}
                <CompareSection recommendation={recommendation} />
              </div>
            )}
          </QueryState>
        )}
        {jobName && (
          <>
            <AlertsSection jobName={jobName} />
            <HistorySection jobName={jobName} />
            <BreakdownSection jobName={jobName} />
            <SpendSection jobName={jobName} />
            <CatalogSection jobName={jobName} />
            <RunsSection jobName={jobName} />
          </>
        )}
      </div>
    </>
  );
}
