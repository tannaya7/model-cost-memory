/** Overview: am I wasting money, is anything broken, where does the money go. Built from widgets the
 * person chooses (Add widget), over a period they choose, with the period's numbers to export. */
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSearchParams } from "react-router-dom";
import { useProject } from "../app/project";
import { useDaily } from "../features/insights/api/dailyApi";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { FirstResults } from "../features/guide/FirstResults";
import { useWaitingForFirstCall, WaitingForFirstCall } from "../features/guide/WaitingForFirstCall";
import { IconCalendar, IconWidgets } from "../ui/icons";
import { Button, cx, EmptyState, ErrorState } from "../ui/primitives";
import { useAllRecommendations } from "./shared";
import { useBillingMode } from "../features/projects/hooks/useBillingMode";
import { useToast } from "../ui/Toast";
import { sectionTitle, useLayout, WIDGETS, type SectionId, type WidgetId } from "./overview/layout";
import { periods, rangeLabel } from "./overview/metrics";
import { ExportButton } from "../features/exports/ExportButton";
import { canAdminister, useMyRole } from "../app/useMyRole";
import { MonthProjection, UnitCost, WastedSpend } from "./overview/moneyWidgets";
import { TokenUsage } from "./overview/TokenUsage";
import { TokensWent } from "./overview/TokensWent";
import { WhatChanged } from "./overview/WhatChanged";
import { ToolServers } from "./overview/ToolServers";
import { AgentTasks } from "./overview/AgentTasks";
import { SavingsTracker } from "./overview/SavingsTracker";
import { AgentsView } from "./overview/AgentsView";
import { WidgetDrawer } from "./overview/WidgetDrawer";
import { CorrectAnswers, SpendMonth } from "./overview/mergedWidgets";
import { floorOf, Attention, CardLevel, BusiestDay, JobsTable, KpiCards, News, PassGauge, Pipeline, Savings, SpendByJob, SpendSplit, SpendTrend, type Ctx, type ShellProps } from "./overview/widgets";

const PERIODS = [7, 30, 90] as const;
/** A flat fee has no bill to project, no money wasted and no unit price, so these are left out for a subscription. */
const BILL_WIDGETS: WidgetId[] = ["projection", "wasted-spend", "unit-cost", "spend-by-job"];
/** Which card says "N AI calls not counted: no known price": the first one on screen, so it is said once. */
const UNPRICED_ORDER: WidgetId[] = ["spend-month", "kpis", "projection", "wasted-spend", "unit-cost"];
const SPAN = { 1: "lg:col-span-1", 2: "lg:col-span-2", 3: "lg:col-span-3" } as const;

function Widget({ id, ctx, shell }: { id: WidgetId; ctx: Ctx; shell: ShellProps }) {
  switch (id) {
    case "spend-month":
      return <SpendMonth ctx={ctx} shell={shell} />;
    case "correct":
      return <CorrectAnswers ctx={ctx} shell={shell} />;
    case "next-step":
      return <Savings ctx={ctx} />;
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
    case "what-changed":
      return <WhatChanged shell={shell} />;
    case "savings-tracker":
      return <SavingsTracker shell={shell} />;
    case "tool-servers":
      return <ToolServers shell={shell} />;
    case "agent-tasks":
      return <AgentTasks shell={shell} />;
    case "projection":
      return <MonthProjection shell={shell} ctx={ctx} />;
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
  const [moved, setMoved] = useState(""); // read out by a screen reader after a widget is moved with the menu
  const [pending, setPending] = useState<{ id: WidgetId; before: number; by: -1 | 1 } | null>(null);
  const layout = useLayout(project);
  const toast = useToast();
  /** Removing a card only hides it, so it is applied at once and can be undone. */
  const removeWidget = (id: WidgetId) => {
    const before = layout.ids;
    layout.remove(id);
    toast({ message: `Removed "${WIDGETS[id].title}"`, undo: { label: "Undo", onUndo: () => layout.restore(before) } });
  };
  const { mode: billing } = useBillingMode();
  const { mode: scope } = useProject();
  const role = useMyRole();
  // The server decides; the button is only left out for people it would refuse (a project key, a viewer, a member).
  const canExport = scope === "owned" && canAdminister(role);

  const jobsQuery = useJobs();
  const first = useWaitingForFirstCall();
  const { byJob, isPending: recsPending } = useAllRecommendations(jobsQuery.data);
  const daily = useDaily({ days: days * 2 });
  const points = useMemo(() => daily.data ?? [], [daily.data]);
  const { cur, prev, curDone, prevDone } = useMemo(() => periods(points, days), [points, days]);

  if (jobsQuery.isError && !jobsQuery.data) return <ErrorState error={jobsQuery.error} onRetry={() => jobsQuery.refetch()} />;

  // A flat fee has no bill to project, no money wasted and no unit price, so those are left out for a subscription.
  const shown = layout.ids.filter((id) => billing !== "subscription" || !BILL_WIDGETS.includes(id));
  // Say where a moved widget really ended up (a move can pass a widget that is hidden for this pay mode).
  useEffect(() => {
    if (!pending) return;
    const now = shown.indexOf(pending.id);
    if (now === pending.before) setMoved(`${WIDGETS[pending.id].title} did not change place on this screen.`);
    else setMoved(`${WIDGETS[pending.id].title} moved ${pending.by < 0 ? "earlier" : "later"}. It is now number ${now + 1} of ${shown.length}.`);
    setPending(null);
  }, [layout.ids]); // eslint-disable-line react-hooks/exhaustive-deps
  // Consecutive widgets of one section share a titled heading; widgets with no section (added from "Add widget") have none.
  const groups = shown.reduce<Array<{ section: SectionId | undefined; ids: WidgetId[] }>>((acc, id) => {
    const section = WIDGETS[id].section;
    const last = acc[acc.length - 1];
    if (last && last.section === section) last.ids.push(id);
    else acc.push({ section, ids: [id] });
    return acc;
  }, []);
  const unpricedOwner = UNPRICED_ORDER.find((id) => shown.includes(id));
  const ctx: Ctx = { unpricedOwner, days, points, cur, prev, curDone, prevDone, dailyPending: daily.isPending, jobs: jobsQuery.data, jobsPending: jobsQuery.isPending, byJob, recsPending, billing };

  return (
    <div className="flex flex-col gap-5">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight text-ink">Overview</h1>
          <p className="mt-0.5 text-sm text-dim">{billing === "both" ? "We cannot tell which calls were paid which way, so we show both." : billing === "subscription" ? "How much you use, whether answers are still good, and what to do next." : "What you spend, whether answers are still good, and what to do next."}</p>
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
          {canExport && (
            <ExportButton
              path={`/v1/insights/export.csv?days=${days}`}
              what={`the last ${days} days`}
              disabled={cur.length === 0}
              title={cur.length === 0 ? "No AI calls recorded in this period, so there is nothing to download" : `Download the last ${days} days as a spreadsheet file (CSV)${billing === "per_use" ? "" : ". Dollar figures are list prices, not a bill"}`}
            />
          )}
        </div>
      </motion.div>


      <div role="status" aria-live="polite" className="sr-only" data-testid="move-announcement">{moved}</div>
      <FirstResults floor={floorOf(byJob)} />
      {first.waiting && <WaitingForFirstCall checking={first.checking} onCheck={first.check} />}

      {first.waiting ? null : layout.ids.length === 0 ? (
        <EmptyState icon={<IconWidgets size={18} />} title="Your overview is empty" hint="Widgets are the cards that show your spending and answer quality. Choose Add widget to pick the ones you want." action={<Button variant="primary" onClick={() => setDrawer(true)}>Add widget</Button>} />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g, gi) => (
            <section key={`${g.section ?? "more"}-${gi}`} aria-labelledby={g.section ? `ov-section-${g.section}-${gi}` : undefined} className="flex flex-col gap-3">
              {g.section && <h2 id={`ov-section-${g.section}-${gi}`} className="text-lg font-semibold tracking-tight text-ink">{sectionTitle(g.section, billing)}</h2>}
              <CardLevel.Provider value={g.section ? 3 : 2}>
                <div className="grid grid-flow-row-dense grid-cols-1 gap-4 lg:grid-cols-3">
                  <AnimatePresence initial={false}>
                    {g.ids.map((id) => {
                      const i = shown.indexOf(id);
                      return (
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
                            shell={{ id, first: i === 0, last: i === shown.length - 1, onMove: (by) => { setPending({ id, before: shown.indexOf(id), by }); layout.move(id, by); }, onRemove: () => removeWidget(id) }}
                          />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </CardLevel.Provider>
            </section>
          ))}
        </div>
      )}

      <WidgetDrawer open={drawer} onClose={() => setDrawer(false)} ids={layout.ids} onAdd={layout.add} onRemove={removeWidget} />
    </div>
  );
}
