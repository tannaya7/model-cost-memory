/** One AI task: our recommendation first, then the views that explain it. The tab lives in the address
 * (?tab=quality), so every view can be linked to. */
import { useP } from "../../app/project";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CHECK_KIND_LABELS } from "../../features/jobs/checkKinds";
import { useJobs } from "../../features/jobs/hooks/useJobs";
import { jobTitle } from "../../features/jobs/jobTitle";
import { useRecommendation } from "../../features/recommendations/hooks/useRecommendation";
import { count, type Verdict } from "../../ui/format";
import { IconArrowRight } from "../../ui/icons";
import { ButtonLink, EmptyState, ErrorState, Pill, Segmented, Skeleton } from "../../ui/primitives";
import { VerdictPill } from "../shared";
import { AboutTask } from "./AboutTask";
import { ExamplesCard } from "./ExamplesCard";
import { EvidenceTab, HistoryTab, QualityTab, RetestsTab, RunsTab, SpendTab } from "./Tabs";
import { TokensTab } from "./TokensTab";
import { VerdictTab } from "./VerdictTab";
import { useBillingMode } from "../../features/projects/hooks/useBillingMode";

const TABS = [
  { value: "verdict", label: "Recommendation" },
  { value: "quality", label: "Correct answers" },
  { value: "spend", label: "Spend" },
  { value: "tokens", label: "Tokens" },
  { value: "evidence", label: "Checked answers" },
  { value: "runs", label: "AI calls" },
  { value: "history", label: "History" },
  { value: "retests", label: "Trials on new models" },
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
  const { mode: billing } = useBillingMode();

  if (jobs.data && !job) {
    return (
      <EmptyState
        title={`There is no AI task called “${jobName}”`}
        hint="It may have been renamed, or it belongs to another project."
        action={<ButtonLink to={p("/jobs")}>All AI tasks</ButtonLink>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
          <Link to={p("/jobs")} className="hover:text-ink">AI tasks</Link>
          <IconArrowRight size={13} />
          <span className="truncate text-dim">{jobTitle(jobName)}</span>
        </nav>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-[28px] font-semibold tracking-tight md:text-[34px]">{jobTitle(jobName)}</h1>
            <p className="mt-1">
              <span title="name in your code" className="rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-dim">{jobName}</span>
              <span className="ml-2 text-xs text-muted">name in your code</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-dim">
              {rec.data ? <VerdictPill verdict={rec.data.verdict as Verdict} /> : rec.isPending ? <Skeleton className="h-6 w-28" /> : <Pill>No recommendation yet</Pill>}
              {job && <span>{count(job.run_count)} AI calls</span>}
              {job && <span className="text-muted">· {CHECK_KIND_LABELS[job.check_kind]}</span>}
            </div>
            
          </div>
        </div>
        {job && <AboutTask job={job} />}
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <Segmented<Tab>
            label="AI task views"
            value={tab}
            onChange={(t) => setParams(t === "verdict" ? {} : { tab: t }, { replace: true })}
            options={TABS.map((t) => ({ value: t.value, label: t.value === "spend" && billing === "subscription" ? "Usage" : t.label }))}
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
      {tab === "verdict" && <ExamplesCard job={jobName} />}
      {tab === "quality" && <QualityTab job={jobName} rec={rec.data ?? null} />}
      {tab === "spend" && <SpendTab job={jobName} />}
      {tab === "tokens" && <TokensTab job={jobName} />}
      {tab === "evidence" && <EvidenceTab job={jobName} rec={rec.data ?? null} />}
      {tab === "runs" && <RunsTab job={jobName} rec={rec.data ?? null} />}
      {tab === "history" && <HistoryTab job={jobName} />}
      {tab === "retests" && <RetestsTab job={jobName} rec={rec.data ?? null} />}
    </div>
  );
}
