import { useState, type ReactNode } from "react";
import { Card } from "../../../../shared/components/Card";

/** One block of the job page, as in the original prototype: a question as the title, the endpoint that
 * answers it, the answer, and the raw JSON behind it for the engineer who wants to see it. */
export function Section({
  id,
  title,
  endpoint,
  raw,
  children,
}: {
  id: string;
  title: string;
  endpoint: string;
  raw?: unknown;
  children: ReactNode;
}) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <section id={id} className="scroll-mt-24">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-bold tracking-tight text-ink">{title}</h3>
          <code className="font-mono text-[11px] text-accent">{endpoint}</code>
        </div>
        {children}
        {raw !== undefined && (
          <div>
            <button
              type="button"
              onClick={() => setShowRaw((x) => !x)}
              className="text-xs font-semibold text-dim hover:text-accent"
            >
              {showRaw ? "Hide raw JSON" : "Show raw JSON"}
            </button>
            {showRaw && (
              <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-rule bg-bg p-3 font-mono text-[11px] leading-relaxed text-dim">
                {JSON.stringify(raw, null, 2)}
              </pre>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-dim">{children}</p>;
}

/** A plain data table in the prototype's style: every number visible, none hidden in a tooltip. */
export function DataTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-rule">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap border-b border-rule bg-bg px-3 py-2 text-left font-mono text-[11px] font-semibold uppercase tracking-wider text-dim">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="px-3 py-4 text-center text-xs text-dim">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((cells, i) => (
              <tr key={i} className="border-b border-rule last:border-0 hover:bg-bg/60">
                {cells.map((c, j) => (
                  <td key={j} className="px-3 py-2 align-top text-ink">
                    {c}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Tag({ tone, children }: { tone: "ok" | "warn" | "bad" | "neutral" | "accent"; children: ReactNode }) {
  const tones = {
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    neutral: "bg-skeleton text-dim",
    accent: "bg-accent-soft text-accent",
  };
  return <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

export const usd = (x: number | null | undefined, digits = 5) => (x === null || x === undefined ? "—" : `$${x.toFixed(digits)}`);
export const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
export const day = (iso: string) => iso.slice(0, 10);
export const minute = (iso: string) => iso.slice(0, 16).replace("T", " ");
