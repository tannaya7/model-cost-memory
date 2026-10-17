import { Link } from "react-router-dom";
import type { Model, RegressionAlert } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Card } from "../../../shared/components/Card";
import {
  formatShutdownCountdown,
  formatShutdownDate,
} from "../../models/components/ModelsTable";

function formatLocalTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatLocalDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export type AlertListItem =
  | { kind: "regression"; alert: RegressionAlert; timestamp: string }
  | { kind: "deprecation"; model: Model; timestamp: string };

export function AlertItemCard({ item }: { item: AlertListItem }) {
  if (item.kind === "deprecation") {
    const { model } = item;
    const { text, isUrgent } = model.shutdown_date
      ? formatShutdownCountdown(model.shutdown_date)
      : { text: "Shutting down", isUrgent: false };

    return (
      <Card className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warn">Shutting down</Badge>
            <span className="font-mono text-base font-bold text-ink">
              {model.model}
            </span>
            {model.model_version && (
              <span className="font-mono text-xs text-dim">
                v: {model.model_version}
              </span>
            )}
          </div>
          <span className="text-xs text-dim">
            In use by project
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-rule bg-bg p-3">
          <div>
            <div className={`text-base font-bold ${isUrgent ? "text-bad" : "text-warn"}`}>
              {text}
            </div>
            {model.shutdown_date && (
              <div className="text-xs text-dim">
                Scheduled shutdown: {formatShutdownDate(model.shutdown_date)}
              </div>
            )}
          </div>
          <Link
            to="/models?status=DEPRECATED"
            className="text-xs font-semibold text-accent hover:underline"
          >
            View in model catalog →
          </Link>
        </div>
      </Card>
    );
  }

  // Regression Alert
  const { alert } = item;
  const isResolved = alert.resolved_at !== null;
  const detail = alert.detail;

  const oldPct = (detail.old_pass_rate * 100).toFixed(1);
  const newPct = (detail.new_pass_rate * 100).toFixed(1);
  const diffPoints = ((detail.new_pass_rate - detail.old_pass_rate) * 100).toFixed(1);

  return (
    <Card className={`space-y-4 ${isResolved ? "opacity-70" : ""}`}>
      {/* Header: Badge, Job name, Timestamp */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="bad">Regression</Badge>
          {isResolved && (
            <Badge tone="ok">Resolved {formatLocalDate(alert.resolved_at!)}</Badge>
          )}
          <Link
            to={`/jobs/${encodeURIComponent(alert.job_id)}`}
            className="text-base font-bold text-accent hover:underline"
          >
            {alert.job_id}
          </Link>
        </div>
        <span className="font-mono text-xs text-dim">
          {formatLocalTimestamp(alert.created_at)}
        </span>
      </div>

      {/* Model version transition */}
      <div className="font-mono text-sm text-dim">
        <span className="font-semibold text-ink">{detail.model}</span>{" "}
        <span>{detail.old_version}</span> <span className="text-dim">→</span>{" "}
        <span className="font-semibold text-ink">{detail.new_version}</span>
      </div>

      {/* Pass rate before and after as big numbers */}
      <div className="space-y-1.5 rounded-card border border-rule bg-bg p-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-2xl font-bold text-ink">{oldPct}%</span>
          <span className="text-lg text-dim">→</span>
          <span className="font-mono text-2xl font-bold text-bad">{newPct}%</span>
          <span className="font-mono text-sm font-semibold text-bad">
            ({diffPoints} points)
          </span>
        </div>
        <p className="text-xs text-dim">
          Based on {detail.n_old.toLocaleString()} old runs and{" "}
          {detail.n_new.toLocaleString()} new runs (p={detail.p_value})
        </p>
      </div>

      {/* Footer link to runs */}
      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-dim italic truncate max-w-[70%]">
          {detail.summary}
        </p>
        <Link
          to={`/runs?job=${encodeURIComponent(alert.job_id)}&model=${encodeURIComponent(
            detail.model,
          )}`}
          className="text-xs font-semibold text-accent hover:underline"
        >
          See the runs →
        </Link>
      </div>
    </Card>
  );
}
