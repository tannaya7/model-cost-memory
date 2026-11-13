/** Models: what the models you run cost, which are being retired, and the whole catalog. */
import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useModels } from "../features/models/hooks/useModels";
import type { Model } from "../shared/api/types";
import { colorMap } from "../ui/charts/series";
import { usd } from "../ui/format";
import { IconClock, IconModels, IconSearch } from "../ui/icons";
import { Button, EmptyState, ErrorState, ModelName, Panel, PanelHeader, Pill, Reveal, Segmented, Skeleton } from "../ui/primitives";

function daysUntil(date: string): number {
  return Math.ceil((Date.parse(`${date}T00:00:00Z`) - Date.now()) / 86_400_000);
}

function StatusPill({ m }: { m: Model }) {
  if (m.status === "RETIRED") return <Pill tone="bad">Retired</Pill>;
  if (m.status === "DEPRECATED") {
    const d = m.shutdown_date ? daysUntil(m.shutdown_date) : null;
    return <Pill tone="warn">{d === null ? "Retiring" : d <= 0 ? "Shut down" : `Retires in ${d} d`}</Pill>;
  }
  return <Pill tone="good">Active</Pill>;
}

/** The price of each model you run, input and output, side by side on one scale. */
function PriceBars({ models }: { models: Model[] }) {
  const priced = models.filter((m) => m.price_out_per_mtok !== null).sort((a, b) => (b.price_out_per_mtok ?? 0) - (a.price_out_per_mtok ?? 0));
  const max = Math.max(...priced.map((m) => Math.max(m.price_out_per_mtok ?? 0, m.price_in_per_mtok ?? 0)), 0.0001);
  const colors = colorMap(models.map((m) => m.model));
  if (priced.length === 0) return <EmptyState title="No priced model in use yet" />;
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-wrap gap-4 text-xs text-dim" aria-label="Legend">
        <li className="flex items-center gap-1.5"><span className="h-2 w-3.5 rounded-sm bg-dim/40" aria-hidden /> per million input tokens</li>
        <li className="flex items-center gap-1.5"><span className="h-2 w-3.5 rounded-sm bg-accent" aria-hidden /> per million output tokens</li>
      </ul>
      <ul className="flex flex-col gap-3.5">
        {priced.map((m, i) => (
          <li key={`${m.model}-${m.provider}`} className="grid grid-cols-[minmax(0,240px)_minmax(0,1fr)] items-center gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors.get(m.model) }} aria-hidden />
              <span title={m.model} className="min-w-0 truncate"><ModelName className="text-xs">{m.model}</ModelName></span>
            </span>
            <span className="flex flex-col gap-1">
              {[
                { v: m.price_in_per_mtok, cls: "bg-dim/40", label: "in" },
                { v: m.price_out_per_mtok, cls: "bg-accent", label: "out" },
              ].map((b) => (
                <span key={b.label} className="flex items-center gap-2">
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <motion.span
                      className={`block h-full rounded-full ${b.cls}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${((b.v ?? 0) / max) * 100}%` }}
                      transition={{ duration: 0.8, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </span>
                  <span className="tabular w-16 text-right text-[11px] text-dim">{usd(b.v)}</span>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type StatusFilter = "ALL" | "ACTIVE" | "DEPRECATED" | "RETIRED";

export default function Models() {
  const used = useModels({ used: true });
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [q, setQ] = useState("");
  const catalog = useModels({ status: status === "ALL" ? undefined : status, q: q.trim() || undefined });
  const usedModels = used.data?.pages.flatMap((p) => p.items) ?? [];
  const all = catalog.data?.pages.flatMap((p) => p.items) ?? [];
  const retiring = useMemo(
    () => usedModels.filter((m) => m.status !== "ACTIVE").sort((a, b) => (a.shutdown_date ?? "9").localeCompare(b.shutdown_date ?? "9")),
    [usedModels],
  );

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Models</h1>
        <p className="mt-1 text-sm text-dim">Prices and retirement dates from the public price list, refreshed daily. A retired model is never recommended.</p>
      </header>

      <Reveal className="grid gap-4 lg:grid-cols-3">
        <Panel className="p-5 md:p-6 lg:col-span-2">
          <PanelHeader title="What the models you run cost" hint="List price in US dollars per million tokens" />
          <div className="mt-5">{used.isPending ? <Skeleton className="h-48" /> : <PriceBars models={usedModels} />}</div>
        </Panel>
        <Panel className="p-5">
          <PanelHeader title="Being retired" hint="Models you run that the provider is shutting down" />
          <div className="mt-4">
            {used.isPending ? (
              <Skeleton className="h-32" />
            ) : retiring.length === 0 ? (
              <p className="text-sm text-dim">None of the models you run is being retired.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {retiring.map((m) => (
                  <li key={`${m.model}-${m.provider}`} className="flex items-center justify-between gap-2 rounded-[12px] border border-warn/25 bg-warn-soft/40 p-3">
                    <span className="min-w-0">
                      <ModelName className="block truncate text-xs">{m.model}</ModelName>
                      <span className="text-[11px] text-muted">
                        {m.shutdown_date ? new Date(`${m.shutdown_date}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" }) : "No date published"}
                      </span>
                    </span>
                    <IconClock size={16} className="shrink-0 text-warn" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </Reveal>

      <Reveal delay={0.08}>
        <Panel className="p-5 md:p-6">
          <PanelHeader
            title="The catalog"
            hint="Every model with a known price"
            actions={
              <>
                <Segmented<StatusFilter>
                  label="Status"
                  value={status}
                  onChange={setStatus}
                  options={[{ value: "ALL", label: "All" }, { value: "ACTIVE", label: "Active" }, { value: "DEPRECATED", label: "Retiring" }, { value: "RETIRED", label: "Retired" }]}
                />
                <label className="flex items-center gap-2 rounded-[10px] border border-rule bg-surface px-3 py-2 text-sm text-muted focus-within:border-accent">
                  <IconSearch size={15} />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a model" aria-label="Find a model" className="w-40 bg-transparent text-ink outline-none placeholder:text-muted" />
                </label>
              </>
            }
          />
          <div className="mt-4 overflow-x-auto">
            {catalog.isPending ? (
              <Skeleton className="h-72" />
            ) : catalog.isError ? (
              <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} />
            ) : all.length === 0 ? (
              <EmptyState icon={<IconModels size={18} />} title="No model matches" />
            ) : (
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-muted">
                    <th className="px-3 py-2 font-semibold">Model</th>
                    <th className="px-3 py-2 font-semibold">Provider</th>
                    <th className="px-3 py-2 text-right font-semibold">Input / M</th>
                    <th className="px-3 py-2 text-right font-semibold">Output / M</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {all.map((m) => (
                    <tr key={`${m.model}-${m.provider}-${m.model_version}`} className="border-t border-rule">
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <ModelName className="text-xs">{m.model}</ModelName>
                          {m.used_by_project && <Pill tone="accent" icon={false}>you use it</Pill>}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-dim">{m.provider}</td>
                      <td className="px-3 py-2.5 text-right text-dim">{usd(m.price_in_per_mtok)}</td>
                      <td className="px-3 py-2.5 text-right text-dim">{usd(m.price_out_per_mtok)}</td>
                      <td className="px-3 py-2.5"><StatusPill m={m} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {catalog.hasNextPage && (
            <div className="mt-4 text-center">
              <Button size="sm" onClick={() => catalog.fetchNextPage()} disabled={catalog.isFetchingNextPage}>
                {catalog.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </Panel>
      </Reveal>
    </div>
  );
}
