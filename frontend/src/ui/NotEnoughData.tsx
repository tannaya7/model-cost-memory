import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** The "nothing to show yet" situations, in plain words. Never a blank box. */

export function NoCallsYet({ to }: { to?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-rule bg-surface-2/50 p-4 text-sm text-dim">
      <p className="font-semibold text-ink">No AI calls yet</p>
      <p>When your app sends its first call, this fills in. Start by creating an AI task and sending a call from your code.</p>
      {to && <Link to={to} className="font-semibold text-accent-ink hover:underline">Create an AI task</Link>}
    </div>
  );
}

export function NoneChecked({ to }: { to?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-rule bg-surface-2/50 p-4 text-sm text-dim">
      <p className="font-semibold text-ink">Not checked yet</p>
      <p>Your calls are arriving, but none are checked yet, so we cannot say how many answers are correct. Choose how answers are checked on the task page.</p>
      {to && <Link to={to} className="font-semibold text-accent-ink hover:underline">Choose how answers are checked</Link>}
    </div>
  );
}

export function ProgressBar({ n, min, label = "Checked answers collected" }: { n: number; min: number; label?: string }) {
  const now = Math.min(Math.max(Math.round(n), 0), min);
  return (
    <div className="max-w-xs">
      <div className="mb-1 text-xs text-muted tabular">{now} of {min}</div>
      <div role="progressbar" aria-label={label} aria-valuenow={now} aria-valuemin={0} aria-valuemax={min} className="h-2 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2" style={{ width: `${(now / min) * 100}%` }} />
      </div>
    </div>
  );
}

export function NotEnoughData({ n, min, children, what = "checked answers" }: { n: number; min: number; children?: ReactNode; what?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-rule bg-surface-2/50 p-4 text-sm text-dim">
      <p className="font-semibold text-ink">Not enough {what} yet</p>
      <p>We need at least {min} to give you a result. You have {Math.round(n)} so far.</p>
      <ProgressBar n={n} min={min} label={`${what.charAt(0).toUpperCase()}${what.slice(1)} collected`} />
      <p>{children ?? "Next step: check more of your AI calls on the task page."}</p>
    </div>
  );
}
