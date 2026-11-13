/** Overview: am I wasting money, is anything broken, where does the money go. */
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useAllRegressions, useDeprecatedModels } from "../features/alerts/hooks/useAlerts";
import { useDaily } from "../features/insights/api/dailyApi";
import { useSpendInsights } from "../features/insights/hooks/useSpendInsights";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { useLimits } from "../features/limits/hooks/useLimits";
import { RelatedNews } from "../features/news/components/RelatedNews";
import type { Job, Recommendation } from "../shared/api/types";
import { CountUp } from "../shared/motion/CountUp";
import { ChartFrame } from "../ui/charts/ChartFrame";
import { SpendArea } from "../ui/charts/charts";
import { change, pivot, rollingPassRate, total } from "../ui/charts/data";
import { colorMap } from "../ui/charts/series";
import { count, pct, usd, type Verdict } from "../ui/format";
import { IconAlert, IconArrowRight, IconBolt, IconCheck, IconClock, IconDollar, IconJobs, IconShield, IconSpark } from "../ui/icons";
import { ButtonLink, EmptyState, ErrorState, ModelName, Panel, PanelHeader, Pill, Reveal, Skeleton } from "../ui/primitives";
import { Delta, monthlySaving, StatTile, useAllRecommendations, VerdictPill } from "./shared";

function Hero({ saving, movable, jobs, loading }: { saving: number; movable: number; jobs: number; loading: boolean }) {
  const someone = movable === 1 ? "One job" : `${movable} jobs`;
  return (
    <Panel glow className="p-6 md:p-9">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-muted">
            <IconSpark size={14} className="text-accent" /> Model &amp; cost memory
          </p>
          {loading ? (
            <Skeleton className="mt-4 h-14 w-80" />
          ) : saving > 0 ? (
            <>
              <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-tight md:text-[52px]">
                You could save <span className="text-gradient"><CountUp value={saving} prefix="$" decimals={saving < 100 ? 2 : 0} /></span>
                <span className="text-dim"> a month</span>
              </h1>
              <p className="mt-3 max-w-2xl text-[15px] text-dim">
                {someone} can move to a cheaper model that passes just as often, proven on your own runs. Nothing changes until you decide.
              </p>
            </>
          ) : movable > 0 ? (
            <>
              <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-tight md:text-[52px]">
                {someone} can run on <span className="text-gradient">a cheaper model</span>
              </h1>
              <p className="mt-3 max-w-2xl text-[15px] text-dim">
                Proven on your own runs to pass just as often. The saving appears once both models have a known price.
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-tight md:text-[52px]">
                {jobs === 0 ? "Start recording runs" : <>Every job is on <span className="text-gradient">the right model</span></>}
              </h1>
              <p className="mt-3 max-w-2xl text-[15px] text-dim">
                {jobs === 0
                  ? "Send each AI call through the SDK. The system checks every answer, remembers the results, and tells you the cheapest model that still does the job."
                  : "No cheaper model is proven to do these jobs as well yet. The system keeps checking as runs arrive and models change."}
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <ButtonLink to="/jobs" variant="primary">
            See every job <IconArrowRight size={16} />
          </ButtonLink>
        </div>
      </div>
    </Panel>
  );
}

const STEPS = [
  { key: "recorded", title: "Record", text: "Every AI call: prompt, model, tokens, cost" },
  { key: "checked", title: "Check", text: "Each answer marked pass or fail" },
  { key: "learned", title: "Remember", text: "Fresh evidence counts more than old" },
  { key: "advised", title: "Advise", text: "The cheapest model that still passes" },
] as const;

/** How it works, with the real counts flowing through each step. */
function Pipeline({ jobs, verdicts }: { jobs: Job[]; verdicts: number }) {
  const recorded = jobs.reduce((s, j) => s + j.run_count, 0);
  const state = (name: string) => jobs.reduce((s, j) => s + (j.runs_by_state?.[name] ?? 0), 0);
  const checked = recorded - state("CAPTURED") - state("INGESTION_FAILED");
  const learned = state("INDEXED") + state("CONSOLIDATED") + state("ARCHIVED");
  const values: Record<string, string> = {
    recorded: count(recorded),
    checked: count(Math.max(0, checked)),
    learned: count(learned),
    advised: `${verdicts} of ${jobs.length}`,
  };
  return (
    <Panel className="p-5">
      <PanelHeader eyebrow="How it works" title="From every AI call to a decision" />
      <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <motion.li
            key={s.key}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.08 }}
            className="relative rounded-[14px] border border-rule bg-surface-2/60 p-4"
          >
            <div className="flex items-center justify-between">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent">{i + 1}</span>
              <span className="tabular text-lg font-semibold text-ink">{values[s.key]}</span>
            </div>
            <p className="mt-3 text-sm font-semibold text-ink">{s.title}</p>
            <p className="mt-0.5 text-xs text-dim">{s.text}</p>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="absolute -right-3 top-1/2 hidden h-px w-3 overflow-hidden bg-rule-strong lg:block">
                <motion.span
                  className="absolute inset-y-0 w-2 bg-accent"
                  animate={{ x: [-8, 12] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "linear", delay: i * 0.3 }}
                />
              </span>
            )}
          </motion.li>
        ))}
      </ol>
    </Panel>
  );
}

function JobTile({ job, rec, index }: { job: Job; rec: Recommendation | null; index: number }) {
  const saving = monthlySaving(rec);
  const current = rec?.models.find((m) => m.model === rec.current?.model);
  const recommended = rec?.models.find((m) => m.model === rec.recommended?.model);
  const moving = rec && rec.recommended && rec.current && rec.recommended.model !== rec.current.model;
  return (
    <motion.li initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * index }}>
      <Link
        to={`/jobs/${encodeURIComponent(job.name)}`}
        className="panel group flex h-full flex-col gap-4 p-5 transition-all hover:-translate-y-0.5 hover:border-rule-strong"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-mono text-[15px] font-semibold text-ink">{job.name}</p>
            <p className="mt-0.5 text-xs text-muted">{count(job.run_count)} runs</p>
          </div>
          {rec ? <VerdictPill verdict={rec.verdict as Verdict} /> : <Pill tone="neutral">No verdict yet</Pill>}
        </div>

        {rec && current && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <ModelName className="text-dim">{rec.current?.model}</ModelName>
            {moving && (
              <>
                <IconArrowRight size={15} className="text-accent" />
                <ModelName>{rec.recommended?.model}</ModelName>
              </>
            )}
          </div>
        )}

        <div className="mt-auto grid grid-cols-2 gap-3 border-t border-rule pt-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted">Pass rate</p>
            <p className="tabular text-sm font-semibold text-ink">
              {pct((moving ? recommended : current)?.weighted_pass_rate)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted">{saving > 0 ? "Saving" : "Cost / success"}</p>
            <p className={`tabular text-sm font-semibold ${saving > 0 ? "text-ok" : "text-ink"}`}>
              {saving > 0 ? `${usd(saving)}/mo` : usd(current?.cost_per_success_usd)}
            </p>
          </div>
        </div>
      </Link>
    </motion.li>
  );
}

function Attention() {
  const regressions = useAllRegressions();
  const deprecated = useDeprecatedModels();
  const limits = useLimits();
  const items = [
    ...(regressions.data ?? [])
      .filter((a) => a.resolved_at === null)
      .map((a) => ({ key: a.alert_id, tone: "bad" as const, icon: <IconAlert size={16} />, title: a.summary, sub: a.job, to: `/jobs/${encodeURIComponent(a.job)}?tab=quality` })),
    ...(deprecated.data ?? []).map((m) => ({
      key: m.model,
      tone: "warn" as const,
      icon: <IconClock size={16} />,
      title: `${m.model} ${m.status === "RETIRED" ? "has been retired" : "is being retired"}`,
      sub: m.shutdown_date ? `Shutdown ${new Date(m.shutdown_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}` : "No shutdown date published",
      to: "/models",
    })),
    ...(limits.data ?? [])
      .filter((l) => l.state === "AT_RISK" || l.state === "EXHAUSTED")
      .map((l) => ({
        key: l.limit_id,
        tone: l.state === "EXHAUSTED" ? ("bad" as const) : ("warn" as const),
        icon: <IconBolt size={16} />,
        title: `${l.name} ${l.state === "EXHAUSTED" ? "is used up" : `runs out in ${Math.round(l.hours_to_full ?? 0)} h`}`,
        sub: `Resets in ${Math.round(l.hours_to_reset)} h`,
        to: "/settings#limits",
      })),
  ];
  return (
    <Panel className="flex h-full flex-col gap-4 p-5">
      <PanelHeader title="Needs your attention" hint="Quality drops, retiring models and limits about to run out" />
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft text-ok">
            <IconShield size={20} />
          </span>
          <p className="text-sm font-semibold text-ink">All clear</p>
          <p className="max-w-60 text-xs text-dim">No open quality drop, no retiring model in use, no limit at risk.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.slice(0, 6).map((it) => (
            <li key={it.key}>
              <Link to={it.to} className="flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3 transition-colors hover:border-rule-strong">
                <span className={`mt-0.5 ${it.tone === "bad" ? "text-bad" : "text-warn"}`}>{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-ink">{it.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted">{it.sub}</span>
                </span>
                <IconArrowRight size={15} className="mt-1 shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function Overview() {
  const jobsQuery = useJobs();
  const jobs = jobsQuery.data;
  const { byJob, isPending: recsPending } = useAllRecommendations(jobs);
  const daily = useDaily({ days: 60 });
  const spend30 = useSpendInsights();

  if (jobsQuery.isError && !jobs) return <ErrorState error={jobsQuery.error} onRetry={() => jobsQuery.refetch()} />;

  const recs = [...byJob.values()];
  const saving = recs.reduce((s, r) => s + monthlySaving(r), 0);
  const movable = recs.filter((r) => r && (r.verdict === "DOWNGRADE" || r.verdict === "SWITCH")).length;
  const mix = (["DOWNGRADE", "SWITCH", "HOLD", "INSUFFICIENT_EVIDENCE"] as const).map((v) => ({ v, n: recs.filter((r) => r?.verdict === v).length }));
  const verdicts = recs.filter((r) => r && r.verdict !== "INSUFFICIENT_EVIDENCE").length;

  const points = daily.data ?? [];
  const last30 = points.filter((p) => Date.parse(`${p.day}T00:00:00Z`) > Date.now() - 30 * 86_400_000);
  const byJobSpend = pivot(points, "job", "spend_usd", 60);
  const jobColors = colorMap((jobs ?? []).map((j) => j.name).concat(byJobSpend.names));
  const dailySpend = byJobSpend.rows.map((r) => byJobSpend.names.reduce((s, n) => s + (r[n] as number), 0));
  const dailyRuns = pivot(points, "job", "runs", 60).rows.map((r) => Object.entries(r).reduce((s, [k, v]) => (k === "day" ? s : s + (v as number)), 0));
  const passed7 = points.filter((p) => Date.parse(`${p.day}T00:00:00Z`) > Date.now() - 7 * 86_400_000);
  const checked7 = total(passed7, "passed") + total(passed7, "failed");
  const passTrend = rollingPassRate(points.map((p) => ({ ...p, model: "all" })), { days: 60, minChecked: 1 }).rows.map((r) => r.all as number | null).filter((v): v is number => v !== null);
  const spendTotal30 = (spend30.data ?? []).reduce((s, j) => s + j.spend_usd, 0);

  return (
    <div className="flex flex-col gap-5">
      <Hero saving={saving} movable={movable} jobs={jobs?.length ?? 0} loading={jobsQuery.isPending || recsPending} />

      <Reveal delay={0.05} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Spend, last 30 days"
          value={spend30.data ? spendTotal30 : null}
          format={(v) => usd(v)}
          note={<><Delta change={change(points, "spend_usd", 30)} upIsGood={false} /> vs the 30 days before</>}
          trend={dailySpend}
          trendColor="var(--series-1)"
          icon={<IconDollar size={16} />}
        />
        <StatTile
          label="Answers passing, last 7 days"
          value={checked7 ? total(passed7, "passed") / checked7 : null}
          format={(v) => pct(v)}
          note={`${count(checked7)} checked answers`}
          trend={passTrend}
          trendColor="var(--series-3)"
          icon={<IconCheck size={16} />}
        />
        <StatTile
          label="Runs recorded, last 30 days"
          value={daily.data ? total(last30, "runs") : null}
          note={<><Delta change={change(points, "runs", 30)} upIsGood /> vs the 30 days before</>}
          trend={dailyRuns}
          trendColor="var(--series-7)"
          icon={<IconJobs size={16} />}
        />
        <div className="panel flex min-w-0 flex-col justify-between gap-3 p-5 ring-1 ring-accent/30">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-dim">Jobs with a verdict</p>
            <IconSpark size={16} className="text-muted" />
          </div>
          <p className="text-[28px] font-semibold leading-none tracking-tight text-ink">
            {jobs ? <>{verdicts}<span className="text-lg text-muted"> / {jobs.length}</span></> : "–"}
          </p>
          <div>
            <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              {mix.filter((m) => m.n > 0).map((m) => (
                <motion.span
                  key={m.v}
                  className={{ DOWNGRADE: "bg-ok", SWITCH: "bg-warn", HOLD: "bg-dim/60", INSUFFICIENT_EVIDENCE: "bg-accent" }[m.v]}
                  initial={{ flexGrow: 0 }}
                  animate={{ flexGrow: m.n }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                />
              ))}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
              {mix.filter((m) => m.n > 0).map((m) => (
                <li key={m.v} className="flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${{ DOWNGRADE: "bg-ok", SWITCH: "bg-warn", HOLD: "bg-dim/60", INSUFFICIENT_EVIDENCE: "bg-accent" }[m.v]}`} />
                  {m.n} {{ DOWNGRADE: "can save", SWITCH: "need better", HOLD: "right model", INSUFFICIENT_EVIDENCE: "learning" }[m.v]}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="p-5 lg:col-span-2">
          {daily.isPending ? (
            <Skeleton className="h-72" />
          ) : points.length === 0 ? (
            <EmptyState title="No spend yet" hint="Spend appears here as soon as runs on priced models are recorded." />
          ) : (
            <ChartFrame
              title="Where the money goes"
              hint="Spend per day for the last 60 days, stacked by job"
              legend={byJobSpend.names.map((n) => ({ name: n, color: jobColors.get(n)! }))}
              table={{
                columns: ["Day", ...byJobSpend.names, "Total"],
                rows: byJobSpend.rows
                  .filter((r) => byJobSpend.names.some((n) => (r[n] as number) > 0))
                  .map((r) => [r.day, ...byJobSpend.names.map((n) => usd(r[n] as number)), usd(byJobSpend.names.reduce((s, n) => s + (r[n] as number), 0))]),
              }}
            >
              <SpendArea rows={byJobSpend.rows} names={byJobSpend.names} colors={jobColors} />
            </ChartFrame>
          )}
        </Panel>
        <Attention />
      </Reveal>

      <Reveal delay={0.15}>
        <div className="mb-3 mt-2 flex items-end justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Your jobs</h2>
            <p className="text-sm text-dim">Each job is one kind of AI task, judged on its own runs.</p>
          </div>
          <Link to="/jobs" className="text-sm font-semibold text-accent hover:underline">All jobs →</Link>
        </div>
        {jobsQuery.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}
          </div>
        ) : !jobs || jobs.length === 0 ? (
          <EmptyState icon={<IconJobs size={18} />} title="No jobs yet" hint="Create a job, then record runs against it with the SDK." action={<ButtonLink to="/jobs" variant="primary">Create a job</ButtonLink>} />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[...jobs]
              .sort((a, b) => monthlySaving(byJob.get(b.name)) - monthlySaving(byJob.get(a.name)) || b.run_count - a.run_count)
              .map((job, i) => <JobTile key={job.job_id} job={job} rec={byJob.get(job.name) ?? null} index={i} />)}
          </ul>
        )}
      </Reveal>

      {jobs && jobs.length > 0 && (
        <Reveal delay={0.2} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Pipeline jobs={jobs} verdicts={verdicts} />
          </div>
          <Panel className="p-5">
            <RelatedNews title="In the news about your models" filters={{ mine: true }} limit={4} emptyText="No recent story names a model you run." />
          </Panel>
        </Reveal>
      )}
    </div>
  );
}
