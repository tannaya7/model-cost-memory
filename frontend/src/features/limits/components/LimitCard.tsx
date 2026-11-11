import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { UsageLimit } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Card } from "../../../shared/components/Card";
import { useDeleteLimit, useReportLimitUsed } from "../hooks/useLimits";
import { STATE_LABELS, hoursLabel, optionLabel, usedLabel, windowLabel } from "../format";

const BAR: Record<UsageLimit["state"], string> = {
  OK: "bg-ok",
  AT_RISK: "bg-warn",
  EXHAUSTED: "bg-bad",
  UNKNOWN: "bg-dim",
};

/** One limit: how much is used, whether it lasts until the reset, and what to change per job if not. */
export function LimitCard({ limit }: { limit: UsageLimit }) {
  const report = useReportLimitUsed();
  const remove = useDeleteLimit();
  const [percent, setPercent] = useState("");
  const state = STATE_LABELS[limit.state];
  const share = Math.min(limit.share_used ?? 0, 1);
  // Where the bar will be when the window resets, at the current pace.
  const projected =
    limit.size && limit.used !== null ? Math.min((limit.used + limit.rate_per_hour * limit.hours_to_reset) / limit.size, 1) : null;
  const urgent = limit.state === "AT_RISK" || limit.state === "EXHAUSTED";

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    report.mutate({ limitId: limit.limit_id, usedPercent: value }, { onSuccess: () => setPercent("") });
  }

  return (
    <Card className={`space-y-4 ${urgent ? "border-warn/50 shadow-[0_0_24px_-12px] shadow-warn" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-bold tracking-tight text-ink">{limit.name}</h3>
          <p className="text-xs text-dim">
            {windowLabel(limit.window_hours)} window
            {limit.model ? ` · only ${limit.model}` : ""} · resets in {hoursLabel(limit.hours_to_reset)}
          </p>
        </div>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>

      <div className="space-y-1.5">
        <div className="relative h-3 overflow-hidden rounded-full bg-skeleton" aria-label={`${Math.round(share * 100)}% used`}>
          {projected !== null && projected > share && (
            <div
              className={`absolute inset-y-0 left-0 opacity-30 ${BAR[limit.state]}`}
              style={{ width: `${projected * 100}%` }}
              title="Where it will be at the reset, at this pace"
            />
          )}
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ${BAR[limit.state]} ${urgent ? "animate-pulse" : ""}`}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        <div className="flex justify-between font-mono text-xs text-dim">
          <span>{usedLabel(limit)}</span>
          {limit.hours_to_full !== null && limit.state !== "EXHAUSTED" && (
            <span>full in {hoursLabel(limit.hours_to_full)}</span>
          )}
        </div>
      </div>

      <p className={`text-sm ${urgent ? "font-semibold text-ink" : "text-dim"}`}>{limit.message}.</p>

      {limit.suggestions.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-dim">What to change</h4>
          <ul className="divide-y divide-rule rounded-md border border-rule">
            {limit.suggestions.map((s) => (
              <li key={s.job} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm text-ink">
                    <Link to={`/jobs/${encodeURIComponent(s.job)}`} className="font-semibold hover:text-accent">
                      {s.job}
                    </Link>{" "}
                    <span className="text-dim">({Math.round(s.share_of_use * 100)}% of recent use)</span>
                  </p>
                  <p className="font-mono text-xs">
                    <span className="text-dim">{optionLabel(s.current)}</span>
                    {s.suggested && (
                      <>
                        <span className="text-dim"> → </span>
                        <span className="font-semibold text-ok">{optionLabel(s.suggested)}</span>
                      </>
                    )}
                  </p>
                  <p className="text-xs text-dim">{s.note}</p>
                </div>
                {!s.suggested && s.note.includes("re-test") && (
                  <Link
                    to={`/jobs/${encodeURIComponent(s.job)}`}
                    className="shrink-0 rounded-md border border-accent/40 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
                  >
                    See re-test →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3">
        {limit.measure === "PERCENT" ? (
          <form onSubmit={submit} className="flex items-center gap-2">
            <label className="text-xs text-dim" htmlFor={`pct-${limit.limit_id}`}>
              Your plan shows
            </label>
            <input
              id={`pct-${limit.limit_id}`}
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              placeholder="80"
              className="w-16 rounded-md border border-rule bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <span className="text-xs text-dim">% used</span>
            <button
              type="submit"
              disabled={report.isPending || percent === ""}
              className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-on-accent disabled:opacity-50"
            >
              Update
            </button>
          </form>
        ) : (
          <span className="text-xs text-dim">Counted from your recorded runs.</span>
        )}
        <button
          type="button"
          onClick={() => remove.mutate(limit.limit_id)}
          disabled={remove.isPending}
          className="text-xs text-dim hover:text-bad"
        >
          Remove
        </button>
      </div>
    </Card>
  );
}
