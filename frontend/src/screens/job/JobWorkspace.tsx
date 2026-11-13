/** One job: its verdict first, then the views that explain it. The tab lives in the address
 * (?tab=quality), so every view can be linked to. */
import { useP } from "../../app/project";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useJobs } from "../../features/jobs/hooks/useJobs";
import { useRecommendation } from "../../features/recommendations/hooks/useRecommendation";
import { count, type Verdict } from "../../ui/format";
import { IconArrowRight } from "../../ui/icons";
import { ButtonLink, EmptyState, ErrorState, Pill, Segmented, Skeleton } from "../../ui/primitives";
import { VerdictPill } from "../shared";
import { EvidenceTab, HistoryTab, QualityTab, RetestsTab, RunsTab, SpendTab } from "./Tabs";
import { VerdictTab } from "./VerdictTab";

const TABS = [
  { value: "verdict", label: "Verdict" },
  { value: "quality", label: "Quality" },
  { value: "spend", label: "Spend" },
  { value: "evidence", label: "Evidence" },
  { value: "runs", label: "Runs" },
  { value: "history", label: "History" },
  { value: "retests", label: "Re-tests" },
] as const;
type Tab = (typeof TABS)[number]["value"];

export default function JobWorkspace() {
  const p = useP();
  const { jobName = "" } = useParams<{ jobName: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get("tab")) ? params.get("tab") : "verdict") as Tab;
  const jobs = useJobs();
  const job = jobs.data?.find((j) => j.name === jobName);
  const rec = useRecommendation(jobName);

  if (jobs.data && !job) {
    return (
      <EmptyState
        title={`There is no job called “${jobName}”`}
        hint="It may have been renamed, or it belongs to another project."
        action={<ButtonLink to={p("/jobs")}>All jobs</ButtonLink>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
          <Link to={p("/jobs")} className="hover:text-ink">Jobs</Link>
          <IconArrowRight size={13} />
          <span className="truncate font-mono text-dim">{jobName}</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate font-mono text-[28px] font-semibold tracking-tight md:text-[34px]">{jobName}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-dim">
              {rec.data ? <VerdictPill verdict={rec.data.verdict as Verdict} /> : rec.isPending ? <Skeleton className="h-6 w-28" /> : <Pill>No verdict yet</Pill>}
              {job && <span>{count(job.run_count)} runs</span>}
              {job && <span className="text-muted">· checked by {job.check_kind.toLowerCase().replace("_", " ")}</span>}
            </div>
            {job?.description && <p className="mt-2 max-w-2xl text-sm text-dim">{job.description}</p>}
          </div>
        </div>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <Segmented<Tab>
            label="Job views"
            value={tab}
            onChange={(t) => setParams(t === "verdict" ? {} : { tab: t }, { replace: true })}
            options={TABS.map((t) => ({ value: t.value, label: t.label }))}
          />
        </div>
      </header>

      {tab === "verdict" &&
        (rec.isPending ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-80" />
          </div>
        ) : rec.isError ? (
          <ErrorState error={rec.error} onRetry={() => rec.refetch()} />
        ) : rec.data ? (
          <VerdictTab rec={rec.data} />
        ) : null)}
      {tab === "quality" && <QualityTab job={jobName} rec={rec.data ?? null} />}
      {tab === "spend" && <SpendTab job={jobName} />}
      {tab === "evidence" && <EvidenceTab job={jobName} rec={rec.data ?? null} />}
      {tab === "runs" && <RunsTab job={jobName} rec={rec.data ?? null} />}
      {tab === "history" && <HistoryTab job={jobName} />}
      {tab === "retests" && <RetestsTab job={jobName} rec={rec.data ?? null} />}
    </div>
  );
}
