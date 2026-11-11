import { useState } from "react";
import { useLabelRun } from "../hooks/useLabelRun";
import { ApiError } from "../../../shared/api/apiFetch";
import type { LabelCreate } from "../../../shared/api/types";

type Outcome = LabelCreate["outcome"];

function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "This run already has an outcome. The panel now shows it.";
  }
  if (error instanceof Error) return error.message;
  return "Could not save the label.";
}

/** For a run stored UNKNOWN: say whether it was right, so it counts toward the job's pass rate. */
export function RunLabelForm({ runId }: { runId: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [reason, setReason] = useState("");
  const mutation = useLabelRun(runId);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!outcome) return;
    mutation.mutate({ outcome, reason: reason.trim() || null });
  }

  const choice = (value: Outcome, label: string, selected: string) => (
    <button
      type="button"
      onClick={() => setOutcome(value)}
      aria-pressed={outcome === value}
      className={`min-h-[40px] flex-1 rounded-md border px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-accent ${
        outcome === value ? selected : "border-rule bg-surface text-dim hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={submit} className="space-y-3 rounded-card border border-rule bg-bg p-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">Label this run</h3>
        <p className="mt-1 text-xs text-dim">
          No automatic check could decide this run. Until it is labelled, it does not count toward
          any pass rate.
        </p>
      </div>

      <div className="flex gap-2" role="group" aria-label="Outcome">
        {choice("PASS", "Pass", "border-ok bg-ok-soft text-ok")}
        {choice("FAIL", "Fail", "border-bad bg-bad-soft text-bad")}
      </div>

      <div>
        <label htmlFor="label-reason" className="text-xs font-semibold uppercase tracking-wider text-dim">
          Reason (optional)
        </label>
        <input
          id="label-reason"
          type="text"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={outcome === "FAIL" ? "What was wrong?" : "Why it passed"}
          className="mt-1 min-h-[40px] w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {mutation.isError && (
        <p role="alert" className="text-sm text-bad">
          {describe(mutation.error)}
        </p>
      )}

      <button
        type="submit"
        disabled={!outcome || mutation.isPending}
        className="min-h-[40px] w-full rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {mutation.isPending ? "Saving…" : "Save label"}
      </button>
    </form>
  );
}
