/** Overview: am I wasting money, is anything broken, where does the money go. Built from widgets the
 * person chooses (Add widget), over a period they choose, with the period's numbers to export. */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import { useProject } from "../app/project";
import { useDaily } from "../features/insights/api/dailyApi";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { FirstResults } from "../features/guide/FirstResults";
import { IconCalendar, IconDownload, IconWidgets } from "../ui/icons";
import { Button, cx, EmptyState, ErrorState } from "../ui/primitives";
import { useAllRecommendations } from "./shared";
import { useLayout, WIDGETS, type WidgetId } from "./overview/layout";
import { periods, rangeLabel, toCsv } from "./overview/metrics";
import { MonthProjection, UnitCost, WastedSpend } from "./overview/moneyWidgets";
import { TokenUsage } from "./overview/TokenUsage";
import { TokensWent } from "./overview/TokensWent";
import { AgentsView } from "./overview/AgentsView";
import { WidgetDrawer } from "./overview/WidgetDrawer";
import { floorOf, Attention, BusiestDay, JobsTable, KpiCards, News, PassGauge, Pipeline, Savings, SpendByJob, SpendSplit, SpendTrend, type Ctx, type ShellProps } from "./overview/widgets";

const PERIODS = [7, 30, 90] as const;
const SPAN = { 1: "lg:col-span-1", 2: "lg:col-span-2", 3: "lg:col-span-3" } as const;

function Widget({ id, ctx, shell }: { id: WidgetId; ctx: Ctx; shell: ShellProps }) {
  switch (id) {
    case "kpis":
      return <KpiCards ctx={ctx} />;
    case "savings":
      return <Savings ctx={ctx} />;
    case "spend-trend":
      return <SpendTrend ctx={ctx} shell={shell} />;
    case "tokens":
      return <TokenUsage ctx={ctx} shell={shell} />;
    case "agents":
      return <AgentsView ctx={ctx} shell={shell} />;
    case "tokens-went":
      return <TokensWent ctx={ctx} shell={shell} />;
    case "projection":
      return <MonthProjection shell={shell} />;
    case "unit-cost":
      return <UnitCost ctx={ctx} shell={shell} />;
    case "wasted-spend":
      return <WastedSpend ctx={ctx} shell={shell} />;
    case "pass-gauge":
      return <PassGauge ctx={ctx} shell={shell} />;
    case "spend-split":
      return <SpendSplit ctx={ctx} shell={shell} />;
    case "busiest-day":
      return <BusiestDay ctx={ctx} shell={shell} />;
    case "jobs-table":
      return <JobsTable ctx={ctx} shell={shell} />;
    case "attention":
      return <Attention shell={shell} />;
    case "spend-by-job":
      return <SpendByJob ctx={ctx} shell={shell} />;
    case "pipeline":
      return <Pipeline ctx={ctx} shell={shell} />;
    case "news":
      return <News shell={shell} />;
  }
}

export default function Overview() {
  const { id: project } = useProject();
  const [params, setParams] = useSearchParams();
  const asked = Number(params.get("days"));
  const days = (PERIODS as readonly number[]).includes(asked) ? asked : 30;
  const [drawer, setDrawer] = useState(false);
  const layout = useLayout(project);

  const jobsQuery = useJobs();
  const { byJob, isPending: recsPending } = useAllRecommendations(jobsQuery.data);
  const daily = useDaily({ days: days * 2 });
  const points = useMemo(() => daily.data ?? [], [daily.data]);
  const { cur, prev } = useMemo(() => periods(points, days), [points, days]);

  if (jobsQuery.isError && !jobsQuery.data) return <ErrorState error={jobsQuery.error} onRetry={() => jobsQuery.refetch()} />;

  const ctx: Ctx = { days, points, cur, prev, dailyPending: daily.isPending, jobs: jobsQuery.data, jobsPending: jobsQuery.isPending, byJob, recsPending };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([toCsv(cur)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `model-cost-memory-${project}-last-${days}-days.csv`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="flex flex-col gap-5">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-0.5 text-sm text-dim">What your app spends on AI, how often the answers are correct, and what you could change to save money. Each card below explains itself.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-stretch overflow-hidden rounded-[11px] border border-rule bg-surface text-sm shadow-sm">
            <span className="hidden items-center gap-2 border-r border-rule px-3 text-dim sm:flex"><IconCalendar size={15} /> {rangeLabel(days)}</span>
            <select
              aria-label="Period"
              value={days}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set("days", e.target.value);
                setParams(next, { replace: true });
              }}
              className="bg-transparent px-3 py-2 font-medium text-ink outline-none"
            >
              {PERIODS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
            </select>
          </div>
          <Button onClick={() => setDrawer(true)}><IconWidgets size={16} /> Add widget</Button>
          <Button variant="primary" onClick={exportCsv} disabled={cur.length === 0} title={cur.length === 0 ? "No AI calls recorded in this period, so there is nothing to download" : `Download the last ${days} days as a spreadsheet file (CSV)`}>
            <IconDownload size={16} /> Export
          </Button>
        </div>
      </motion.div>

      <FirstResults floor={floorOf(byJob)} />

      {layout.ids.length === 0 ? (
        <EmptyState icon={<IconWidgets size={18} />} title="Your overview is empty" hint="Widgets are the cards that show your spending and answer quality. Choose Add widget to pick the ones you want." action={<Button variant="primary" onClick={() => setDrawer(true)}>Add widget</Button>} />
      ) : (
        <div className="grid grid-flow-row-dense grid-cols-1 gap-4 lg:grid-cols-3">
          <AnimatePresence initial={false}>
            {layout.ids.map((id, i) => (
              <motion.div
                key={id}
                layout
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
                transition={{ type: "spring", stiffness: 260, damping: 30, delay: Math.min(i, 6) * 0.04 }}
                className={cx("min-w-0", SPAN[WIDGETS[id].span])}
              >
                <Widget
                  id={id}
                  ctx={ctx}
                  shell={{ id, first: i === 0, last: i === layout.ids.length - 1, onMove: (by) => layout.move(id, by), onRemove: () => layout.remove(id) }}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <WidgetDrawer open={drawer} onClose={() => setDrawer(false)} ids={layout.ids} onAdd={layout.add} onRemove={layout.remove} />
    </div>
  );
}
