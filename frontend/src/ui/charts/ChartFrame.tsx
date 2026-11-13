import { useState, type ReactNode } from "react";
import { IconChart, IconTable } from "../icons";
import { cx } from "../primitives";

export interface TableView {
  columns: string[];
  rows: Array<Array<ReactNode>>;
}

/** A chart with its title, legend and a table view of the same numbers (the accessible twin). */
export function ChartFrame({
  title,
  hint,
  legend,
  table,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  legend?: Array<{ name: string; color: string; dashed?: boolean }>;
  table?: TableView;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className={cx("m-0 flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <figcaption className="min-w-0">
          <p className="text-[15px] font-semibold tracking-tight text-ink">{title}</p>
          {hint && <p className="mt-0.5 text-[13px] text-dim">{hint}</p>}
        </figcaption>
        <div className="flex items-center gap-1.5">
          {actions}
          {table && (
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              title={asTable ? "Show the chart" : "Show the numbers as a table"}
              className="grid h-8 w-8 place-items-center rounded-[9px] border border-rule text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {asTable ? <IconChart size={15} /> : <IconTable size={15} />}
              <span className="sr-only">{asTable ? "Show chart" : "Show table"}</span>
            </button>
          )}
        </div>
      </div>
      {legend && legend.length > 1 && !asTable && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Legend">
          {legend.map((l) => (
            <li key={l.name} className="flex items-center gap-1.5 text-xs text-dim">
              <span
                aria-hidden
                className="inline-block h-[3px] w-3.5 rounded-full"
                style={{
                  background: l.dashed ? `repeating-linear-gradient(90deg, ${l.color} 0 4px, transparent 4px 7px)` : l.color,
                }}
              />
              <span className="font-mono">{l.name}</span>
            </li>
          ))}
        </ul>
      )}
      {asTable && table ? (
        <div className="max-h-80 overflow-auto rounded-[12px] border border-rule">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-surface-2">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-semibold uppercase tracking-wider text-muted">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular">
              {table.rows.map((row, i) => (
                <tr key={i} className="border-t border-rule">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5 text-dim">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </figure>
  );
}

/** The hover card every chart uses. */
export function TooltipCard({ title, rows }: { title: ReactNode; rows: Array<{ color?: string; label: ReactNode; value: ReactNode }> }) {
  return (
    <div className="min-w-44 rounded-[12px] border border-rule-strong bg-surface-2/95 px-3 py-2.5 text-xs shadow-2xl backdrop-blur">
      <p className="mb-1.5 font-semibold text-ink">{title}</p>
      <ul className="space-y-1">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-dim">
              {r.color && <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: r.color }} />}
              {r.label}
            </span>
            <span className="tabular font-semibold text-ink">{r.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
