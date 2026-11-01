import { Link } from "react-router-dom";
import { useLimits } from "../hooks/useLimits";

/** On the overview: only when a limit runs out before it resets, or already has. */
export function LimitBanner() {
  const { data } = useLimits();
  const urgent = (data ?? []).filter((l) => l.state === "AT_RISK" || l.state === "EXHAUSTED");
  if (urgent.length === 0) return null;
  const worst = urgent.find((l) => l.state === "EXHAUSTED") ?? urgent[0];
  const fixable = urgent.some((l) => l.suggestions.some((s) => s.suggested));

  return (
    <div
      role="alert"
      className="mb-6 flex flex-col gap-3 rounded-card border border-warn/50 bg-warn-soft p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="text-sm font-semibold text-ink">
          {urgent.length === 1 ? worst.message : `${urgent.length} limits run out before they reset`}
        </p>
        <p className="mt-0.5 text-xs text-dim">
          {fixable
            ? "Cheaper options proven for your jobs would stretch it."
            : "No cheaper option is proven for these jobs yet; a re-test would tell."}
        </p>
      </div>
      <Link
        to="/limits"
        className="shrink-0 rounded-md bg-warn px-4 py-2 text-xs font-semibold text-on-accent hover:opacity-90"
      >
        See what to change →
      </Link>
    </div>
  );
}
