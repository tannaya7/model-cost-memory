/** Jobs: every job with its verdict, the model it should use and what that is worth. */
import { useP } from "../app/project";
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useDaily } from "../features/insights/api/dailyApi";
import { useSpendInsights } from "../features/insights/hooks/useSpendInsights";
import { JobCreatePanel } from "../features/jobs/components/JobCreatePanel";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { Sparkline } from "../ui/charts/charts";
import { pivot } from "../ui/charts/data";
import { count, pct, usd, type Verdict } from "../ui/format";
import { IconArrowRight, IconJobs, IconPlus, IconSearch } from "../ui/icons";
import { Button, EmptyState, ErrorState, ModelName, Pill, Reveal, Segmented, Skeleton } from "../ui/primitives";
import { monthlySaving, useAllRecommendations, VerdictPill } from "./shared";

type Filter = "all" | "save" | "attention" | "learning";

export default function Jobs() {
  const p = useP();
  const jobsQuery = useJobs();
  const jobs = jobsQuery.data;
  const { byJob } = useAllRecommendations(jobs);
  const [period, setPeriod] = useState<"7" | "30" | "90">("30");
  const days = Number(period);
  const spend = useSpendInsights(days);
  const daily = useDaily({ days });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runsByJob = useMemo(() => {
    const { rows, names } = pivot(daily.data ?? [], "job", "runs", days);
    return new Map(names.map((n) => [n, rows.map((r) => r[n] as number)]));
  }, [daily.data, days]);
  const spendByJob = new Map((spend.data ?? []).map((s) => [s.job, s.spend_usd]));

  const counts = { all: 0, save: 0, attention: 0, learning: 0 };
  const rows = (jobs ?? []).map((job) => {
    const rec = byJob.get(job.name) ?? null;
    const kind: Filter = !rec || rec.verdict === "INSUFFICIENT_EVIDENCE" ? "learning" : rec.verdict === "DOWNGRADE" ? "save" : rec.verdict === "SWITCH" ? "attention" : "all";
    counts.all += 1;
    if (kind !== "all") counts[kind] += 1;
    return { job, rec, kind };
  });
  const shown = rows
    .filter((r) => filter === "all" || r.kind === filter)
    .filter((r) => !query.trim() || r.job.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => monthlySaving(b.rec) - monthlySaving(a.rec) || b.job.run_count - a.job.run_count);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Jobs</h1>
          <p className="mt-1 text-sm text-dim">One job is one kind of AI task (extract an invoice, classify a ticket). Each is judged on its own runs.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={16} /> New job
        </Button>
      </header>

      {notice && (
        <p role="status" className="rounded-[12px] border border-ok/30 bg-ok-soft px-4 py-2.5 text-sm text-ok">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<Filter>
          label="Show jobs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "save", label: "Can save", count: counts.save },
            { value: "attention", label: "Needs a better model", count: counts.attention },
            { value: "learning", label: "Still learning", count: counts.learning },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
        <Segmented<"7" | "30" | "90">
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[{ value: "7", label: "7 d" }, { value: "30", label: "30 d" }, { value: "90", label: "90 d" }]}
        />
        <label className="flex items-center gap-2 rounded-[10px] border border-rule bg-surface px-3 py-2 text-sm text-muted focus-within:border-accent">
          <IconSearch size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a job" aria-label="Find a job" className="w-44 bg-transparent text-ink outline-none placeholder:text-muted" />
        </label>
        </div>
      </div>

      {jobsQuery.isError && !jobs ? (
        <ErrorState error={jobsQuery.error} onRetry={() => jobsQuery.refetch()} />
      ) : jobsQuery.isPending ? (
        <div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<IconJobs size={18} />}
          title={jobs?.length ? "No job matches" : "No jobs yet"}
          hint={jobs?.length ? "Try another filter or search." : "A job is a kind of task you send to a model. Create one, then record its runs with the SDK."}
          action={!jobs?.length && <Button variant="primary" onClick={() => setCreating(true)}>Create the first job</Button>}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map(({ job, rec }, i) => {
            const saving = monthlySaving(rec);
            const current = rec?.models.find((m) => m.model === rec.current?.model);
            const target = rec?.models.find((m) => m.model === rec.recommended?.model);
            const moving = rec?.recommended && rec.current && rec.recommended.model !== rec.current.model;
            return (
              <motion.li key={job.job_id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Link
                  to={p(`/jobs/${encodeURIComponent(job.name)}`)}
                  className="panel group grid grid-cols-1 items-center gap-4 p-4 transition-all hover:border-rule-strong md:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_repeat(3,minmax(0,0.8fr))_120px_24px] md:p-5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[15px] font-semibold text-ink">{job.name}</p>
                    <p className="mt-1 text-xs text-muted">{count(job.run_count)} runs · {job.check_kind.toLowerCase().replace("_", " ")}</p>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {rec ? <VerdictPill verdict={rec.verdict as Verdict} /> : <Pill tone="neutral">No verdict yet</Pill>}
                    {rec?.current && (
                      <span className="flex min-w-0 items-center gap-1.5 text-sm">
                        <ModelName className="truncate text-dim">{rec.current.model}</ModelName>
                        {moving && (
                          <>
                            <IconArrowRight size={14} className="shrink-0 text-accent" />
                            <ModelName className="truncate">{rec.recommended?.model}</ModelName>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <Metric label="Pass rate" value={pct((moving ? target : current)?.weighted_pass_rate)} />
                  <Metric label={`Spend ${period} d`} value={usd(spendByJob.get(job.name) ?? 0)} />
                  <Metric label="Saving" value={saving > 0 ? `${usd(saving)}/mo` : "–"} good={saving > 0} />
                  <div className="hidden md:block">
                    <Sparkline values={runsByJob.get(job.name) ?? []} color="var(--series-7)" height={34} />
                  </div>
                  <IconArrowRight size={17} className="hidden text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent md:block" />
                </Link>
              </motion.li>
            );
          })}
        </ul>
      )}

      <Reveal delay={0.1}>
        <p className="text-center text-xs text-muted">The line on the right is runs per day over the last {period} days.</p>
      </Reveal>

      <JobCreatePanel isOpen={creating} onClose={() => setCreating(false)} onSuccess={(message) => { setCreating(false); setNotice(message); }} />
    </div>
  );
}

function Metric({ label, value, good = false }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`tabular text-sm font-semibold ${good ? "text-ok" : "text-ink"}`}>{value}</p>
    </div>
  );
}
