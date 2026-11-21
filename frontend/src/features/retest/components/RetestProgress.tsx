import { useState } from "react";
import { useP } from "../../../app/project";
import { canAdminister, useMyRole } from "../../../app/useMyRole";
import { Link } from "react-router-dom";
import { InlineConfirm } from "../../../ui/InlineConfirm";
import { Button } from "../../../ui/primitives";
import { useStopRetest } from "../hooks/useRetest";
import { Card } from "../../../shared/components/Card";
import { Badge } from "../../../shared/components/Badge";
import type { RetestExecutionStatus, RetestStatus } from "../../../shared/api/types";

function getStatusBadge(status: RetestExecutionStatus) {
  switch (status) {
    case "QUEUED":
      return <Badge tone="neutral">Queued</Badge>;
    case "RUNNING":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
          </span>
          Running
        </span>
      );
    case "DONE":
      return <Badge tone="ok">Completed</Badge>;
    case "STOPPED_BUDGET":
      return <Badge tone="warn">Stopped (trial budget reached)</Badge>;
    case "STOPPED_CAP":
      return <Badge tone="warn">Stopped (monthly trial budget reached)</Badge>;
    case "STOPPED_USER":
      return <Badge tone="neutral">Stopped by you</Badge>;
    case "FAILED":
      return <Badge tone="bad">Failed</Badge>;
  }
}

/** Stop a trial that has not finished. It asks first, in the page, and says what is kept and what is still paid for. */
function StopTrial({ retest }: { retest: RetestStatus }) {
  const stop = useStopRetest(retest.job, retest.retest_id);
  const [asking, setAsking] = useState(false);
  if (retest.stopping || stop.isSuccess) {
    return <p role="status" className="text-xs text-dim">{retest.status === "QUEUED" ? "Stopped before it started." : "Stopping: no new prompts are sent. The ones already sent will finish."}</p>;
  }
  if (!asking) {
    return <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>Stop this trial</Button>;
  }
  const waiting = retest.status === "QUEUED";
  return (
    <InlineConfirm
      label="Stop this trial"
      confirmLabel="Stop the trial"
      cancelLabel={waiting ? "Keep it waiting" : "Keep it running"}
      busy={stop.isPending}
      busyLabel="Stopping…"
      error={stop.isError ? (stop.error instanceof Error ? stop.error.message : "Could not stop it") : null}
      onConfirm={() => stop.mutate()}
      onCancel={() => setAsking(false)}
    >
      {waiting
        ? "This trial has not started, so nothing has been sent and nothing will be charged."
        : `No new prompts will be sent. The ones already sent will finish, and you pay your provider for them. The ${retest.runs_done} already replayed are kept and counted.`}
    </InlineConfirm>
  );
}

export function RetestProgress({ retest }: { retest: RetestStatus }) {
  const p = useP();
  const role = useMyRole();
  const isFinished =
    retest.status === "DONE" ||
    retest.status === "STOPPED_BUDGET" ||
    retest.status === "STOPPED_CAP" ||
    retest.status === "STOPPED_USER" ||
    retest.status === "FAILED";

  const runsPercent =
    retest.runs_planned > 0
      ? Math.min(100, Math.round((retest.runs_done / retest.runs_planned) * 100))
      : 0;

  const spendPercent =
    retest.budget_usd > 0
      ? Math.min(100, Math.round((retest.spent_usd / retest.budget_usd) * 100))
      : 0;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Overview Card */}
      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-rule">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-ink">Your trial on a new model</h2>
              {getStatusBadge(retest.status)}
            </div>
            <p className="mt-1 text-xs text-dim">
              ID: <span className="font-mono">{retest.retest_id}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to={p(`/jobs/${encodeURIComponent(retest.job)}?tab=retests`)}
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-dim hover:bg-bg hover:text-ink"
            >
              AI task: {retest.job}
            </Link>
            <Link
              to={p(`/retest?job=${encodeURIComponent(retest.job)}`)}
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-medium text-accent hover:bg-bg"
            >
              + New trial on a new model
            </Link>
          </div>
        </div>

        {!isFinished && canAdminister(role) && <div className="mt-4"><StopTrial retest={retest} /></div>}

        {/* Status Message / Notice */}
        {retest.message && (
          <div className="mt-4 rounded-md border border-warn/30 bg-warn-soft p-3 text-xs text-warn">
            <span className="font-semibold">Notice:</span> {retest.message}
          </div>
        )}

        {/* Progress Bars (Runs and Spend) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
          {/* Runs Progress */}
          <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink">Prompts replayed</span>
              <span className="font-mono text-dim">
                {retest.runs_done} / {retest.runs_planned} prompts ({runsPercent}%)
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface border border-rule">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  retest.status === "DONE"
                    ? "bg-ok"
                    : retest.status === "STOPPED_BUDGET"
                      ? "bg-warn"
                      : "bg-accent"
                }`}
                style={{ width: `${runsPercent}%` }}
              />
            </div>
          </div>

          {/* Spend Progress */}
          <div className="space-y-2 rounded-card border border-rule bg-bg p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-ink">Trial budget used</span>
              <span className="font-mono text-dim">
                ${retest.spent_usd.toFixed(4)} / ${retest.budget_usd.toFixed(2)}{" "}
                ({spendPercent}%)
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface border border-rule">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  retest.status === "STOPPED_BUDGET"
                    ? "bg-warn"
                    : spendPercent > 90
                      ? "bg-warn"
                      : "bg-accent"
                }`}
                style={{ width: `${spendPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Live Evaluation Results */}
        <div className="mt-6">
          <h3 className="text-xs font-semibold text-dim uppercase tracking-wider mb-3">
            Results so far
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-card border border-rule bg-surface p-4 text-center">
              <span className="text-xs text-dim block">Correct answers</span>
              <span
                className={`text-2xl font-bold font-mono mt-1 block ${
                  retest.pass_rate !== null
                    ? retest.pass_rate >= 0.8
                      ? "text-ok"
                      : "text-warn"
                    : "text-ink"
                }`}
              >
                {retest.pass_rate !== null
                  ? `${(retest.pass_rate * 100).toFixed(1)}%`
                  : "—"}
              </span>
            </div>
            <div className="rounded-card border border-rule bg-surface p-4 text-center">
              <span className="text-xs text-dim block">Correct</span>
              <span className="text-2xl font-bold font-mono text-ok mt-1 block">
                {retest.passed}
              </span>
            </div>
            <div className="rounded-card border border-rule bg-surface p-4 text-center">
              <span className="text-xs text-dim block">Wrong</span>
              <span className="text-2xl font-bold font-mono text-bad mt-1 block">
                {retest.failed}
              </span>
            </div>
          </div>
        </div>

        {/* Details & Metadata Grid */}
        <div className="mt-6 rounded-card border border-rule bg-surface p-4">
          <h3 className="text-xs font-semibold text-dim uppercase tracking-wider mb-3">
            Trial details
          </h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <dt className="text-dim">AI task</dt>
              <dd className="mt-0.5 font-medium text-ink">{retest.job}</dd>
            </div>
            <div>
              <dt className="text-dim">Candidate Model</dt>
              <dd className="mt-0.5 font-medium text-ink font-mono">
                {retest.candidate_model}
              </dd>
            </div>
            <div>
              <dt className="text-dim">Started</dt>
              <dd className="mt-0.5 text-ink">
                {new Date(retest.started_at ?? retest.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </dd>
            </div>
            <div>
              <dt className="text-dim">Finished</dt>
              <dd className="mt-0.5 text-ink">
                {retest.finished_at
                  ? new Date(retest.finished_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })
                  : "In progress..."}
              </dd>
            </div>
          </dl>
        </div>

        {/* Completion Action Banner */}
        {isFinished && (
          <div className="mt-6 rounded-card border border-accent/20 bg-accent-soft p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h4 className="text-sm font-semibold text-ink">
                {retest.status === "DONE"
                  ? "The trial finished successfully."
                  : retest.status === "STOPPED_BUDGET"
                    ? "The trial stopped because it reached its budget."
                    : retest.status === "STOPPED_CAP"
                      ? "The trial stopped because this month's trial budget ran out."
                      : "The trial finished."}
              </h4>
              <p className="mt-0.5 text-xs text-dim">
                The checked answers from this trial now count towards our recommendation for this AI task.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                to={p(`/jobs/${encodeURIComponent(retest.job)}`)}
                className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-on-accent hover:opacity-90 transition-opacity"
              >
                See this AI task's recommendation →
              </Link>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
