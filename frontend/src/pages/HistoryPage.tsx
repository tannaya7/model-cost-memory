import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { QueryState } from "../shared/components/QueryState";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { JobHistoryTimeline } from "../features/recommendations/components/JobHistoryTimeline";

export default function HistoryPage() {
  const jobs = useJobs();
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <>
      <PageHeader
        title="Decision history"
        subtitle="Every recommendation a job has had: what changed, when and why. Nothing is overwritten."
      />
      <QueryState
        query={jobs}
        emptyTitle="No jobs yet."
        emptyHint="Define a job, record runs, and its first recommendation appears here."
      >
        {(list) => {
          const selected = searchParams.get("job") || list[0]?.name;
          return (
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                <label htmlFor="history-job" className="text-xs font-semibold uppercase tracking-wider text-dim">
                  Job
                </label>
                <select
                  id="history-job"
                  value={selected}
                  onChange={(e) => setSearchParams({ job: e.target.value })}
                  className="min-h-[40px] rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {list.map((j) => (
                    <option key={j.job_id} value={j.name}>
                      {j.name}
                    </option>
                  ))}
                </select>
              </div>
              {selected && <JobHistoryTimeline key={selected} jobName={selected} />}
            </div>
          );
        }}
      </QueryState>
    </>
  );
}
