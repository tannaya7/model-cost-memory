/** Activity: what happened and what is happening. Alerts, the live pipeline, and the AI news. */
import { useP } from "../app/project";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useSearchParams } from "react-router-dom";
import { AlertItemCard, type AlertListItem } from "../features/alerts/components/AlertItemCard";
import { useAllRegressions, useDeprecatedModels } from "../features/alerts/hooks/useAlerts";
import { subscribeToFlow } from "../features/flow/api/flowSubscription";
import type { FlowConnectionStatus, FlowEvent } from "../features/flow/types";
import NewsFeed from "./NewsFeed";
import { timeAgo } from "../ui/format";
import { IconActivity, IconAlert, IconBell, IconCheck, IconNews, IconShield } from "../ui/icons";
import { Button, cx, EmptyState, Panel, PanelHeader, Segmented, Skeleton } from "../ui/primitives";

type Tab = "alerts" | "live" | "news";

function Alerts() {
  const regressions = useAllRegressions();
  const deprecated = useDeprecatedModels();
  const [show, setShow] = useState<"open" | "resolved" | "all">("open");
  const items: AlertListItem[] = [
    ...(regressions.data ?? []).map((a) => ({ kind: "regression" as const, alert: a, timestamp: a.created_at })),
    ...(deprecated.data ?? []).map((m) => ({ kind: "deprecation" as const, model: m, timestamp: m.shutdown_date ?? m.first_seen_at })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const isOpen = (i: AlertListItem) => i.kind === "deprecation" || i.alert.resolved_at === null;
  const shown = items.filter((i) => (show === "all" ? true : show === "open" ? isOpen(i) : !isOpen(i)));
  const openCount = items.filter(isOpen).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-dim">
          The system checks every job every 15 minutes for two kinds of trouble: a new model version that answers worse, and a model that got worse
          under the same name. It also warns when a model you run is being retired.
        </p>
        <Segmented
          label="Which alerts"
          value={show}
          onChange={setShow}
          options={[{ value: "open", label: "Open", count: openCount }, { value: "resolved", label: "Resolved", count: items.length - openCount }, { value: "all", label: "All", count: items.length }]}
        />
      </div>
      {regressions.isPending || deprecated.isPending ? (
        <Skeleton className="h-40" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<IconShield size={18} />}
          title={show === "open" ? "Nothing needs attention" : "No alerts here"}
          hint="When a model's answers get worse, it shows here and is sent to your webhook."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shown.map((item) => (
            <motion.div key={item.kind === "regression" ? item.alert.alert_id : item.model.model} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <AlertItemCard item={item} />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

const STAGES = [
  { key: "sdk", title: "Recorded", text: "The app's call is captured" },
  { key: "api", title: "Received", text: "Stored with its cost" },
  { key: "check", title: "Checked", text: "Pass or fail" },
  { key: "index", title: "Indexed", text: "Findable by similar prompt" },
  { key: "consolidate", title: "Learned", text: "Folded into the verdict" },
] as const;

function failed(ev: FlowEvent) {
  return ev.stage === "check" && (ev.message.toLowerCase().includes("fail") || ev.data?.outcome === "FAIL");
}

function Live() {
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [status, setStatus] = useState<FlowConnectionStatus>("live");
  const [paused, setPaused] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pulse, setPulse] = useState<{ stage: string; bad: boolean; n: number } | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(
    () =>
      subscribeToFlow(
        (ev) => {
          if (pausedRef.current) return;
          setEvents((prev) => [ev, ...prev].slice(0, 40));
          setCounts((c) => ({ ...c, [ev.stage]: (c[ev.stage] ?? 0) + 1 }));
          setPulse((p) => ({ stage: ev.stage, bad: failed(ev), n: (p?.n ?? 0) + 1 }));
        },
        setStatus,
      ),
    [],
  );

  const statusInfo = {
    live: { label: "Live", cls: "bg-ok" },
    reconnecting: { label: "Reconnecting…", cls: "bg-warn" },
    polling: { label: "Checking every 2 s", cls: "bg-warn" },
  }[status];

  return (
    <div className="flex flex-col gap-4">
      <Panel glow className="p-5 md:p-7">
        <PanelHeader
          eyebrow="Live pipeline"
          title="Every run, as it moves through the system"
          hint="Send a call through the SDK and watch it get recorded, checked and learned from."
          actions={
            <>
              <span className="inline-flex items-center gap-2 rounded-full border border-rule px-3 py-1 text-xs font-semibold text-dim">
                <span className={cx("h-2 w-2 rounded-full", statusInfo.cls, !paused && "animate-pulse")} /> {paused ? "Paused" : statusInfo.label}
              </span>
              <Button size="sm" onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause"}</Button>
            </>
          }
        />
        <ol className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-5">
          {STAGES.map((s, i) => {
            const active = pulse?.stage === s.key;
            const bad = active && pulse?.bad;
            return (
              <li key={s.key} className="relative">
                <motion.div
                  key={active ? pulse?.n : "idle"}
                  initial={active ? { scale: 0.96 } : false}
                  animate={{ scale: 1 }}
                  className={cx(
                    "relative flex h-full flex-col gap-1 rounded-[14px] border p-4 transition-colors",
                    active ? (bad ? "border-bad/60 bg-bad-soft" : "border-accent/60 bg-accent-soft") : "border-rule bg-surface-2/50",
                  )}
                >
                  {active && (
                    <motion.span
                      aria-hidden
                      className={cx("absolute inset-0 rounded-[14px] ring-2", bad ? "ring-bad/50" : "ring-accent/50")}
                      initial={{ opacity: 0.9 }}
                      animate={{ opacity: 0 }}
                      transition={{ duration: 1.2 }}
                    />
                  )}
                  <span className="flex items-center justify-between">
                    <span className={cx("grid h-7 w-7 place-items-center rounded-full text-xs font-bold", active ? "bg-accent text-on-accent" : "bg-surface-3 text-dim")}>{i + 1}</span>
                    <span className="tabular text-lg font-semibold text-ink">{counts[s.key] ?? 0}</span>
                  </span>
                  <span className="mt-2 text-sm font-semibold text-ink">{s.title}</span>
                  <span className="text-xs text-dim">{s.text}</span>
                </motion.div>
                {i < STAGES.length - 1 && <span aria-hidden className="absolute -right-2.5 top-1/2 hidden h-px w-2 bg-rule-strong sm:block" />}
              </li>
            );
          })}
        </ol>
      </Panel>

      <Panel className="p-5">
        <PanelHeader title="Event stream" hint="Newest first; the last 40" />
        {events.length === 0 ? (
          <div className="mt-4">
            <EmptyState icon={<IconActivity size={18} />} title="Waiting for runs" hint="Nothing has crossed the pipeline since this page opened. Record a run with the SDK to see it here." />
          </div>
        ) : (
          <ul className="mt-4 flex flex-col">
            <AnimatePresence initial={false}>
              {events.map((ev) => (
                <motion.li
                  key={ev.event_id}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-start gap-3 border-t border-rule py-2.5 first:border-t-0"
                >
                  <span className={cx("mt-0.5 shrink-0", failed(ev) ? "text-bad" : "text-accent")}>{failed(ev) ? <IconAlert size={15} /> : <IconCheck size={15} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{ev.message}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-muted">
                      {STAGES.find((s) => s.key === ev.stage)?.title ?? ev.stage} · {ev.run_id ? `run ${String(ev.run_id).slice(0, 8)}` : "system"} · {timeAgo(ev.ts)}
                    </span>
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function Activity() {
  const p = useP();
  const [params, setParams] = useSearchParams();
  const tab = (["alerts", "live", "news"].includes(params.get("tab") ?? "") ? params.get("tab") : "alerts") as Tab;
  const regressions = useAllRegressions();
  const deprecated = useDeprecatedModels();
  const open = (regressions.data ?? []).filter((a) => a.resolved_at === null).length + (deprecated.data?.length ?? 0);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-1 text-sm text-dim">What changed, what is running right now, and what the AI world is saying about your models.</p>
        </div>
        <Segmented<Tab>
          label="Activity views"
          value={tab}
          onChange={(t) => setParams(t === "alerts" ? {} : { tab: t }, { replace: true })}
          options={[
            { value: "alerts", label: <span className="inline-flex items-center gap-1.5"><IconBell size={14} /> Alerts</span>, count: open },
            { value: "live", label: <span className="inline-flex items-center gap-1.5"><IconActivity size={14} /> Live</span> },
            { value: "news", label: <span className="inline-flex items-center gap-1.5"><IconNews size={14} /> AI news</span> },
          ]}
        />
      </header>
      {tab === "alerts" && <Alerts />}
      {tab === "live" && <Live />}
      {tab === "news" && <NewsFeed />}
      {tab === "alerts" && open > 0 && (
        <p className="text-center text-xs text-muted">
          Resolve an alert from its card once you have dealt with it. <Link to={p("/settings#alerts")} className="text-accent hover:underline">Set the webhook</Link> to get them in Slack or Discord.
        </p>
      )}
    </div>
  );
}
