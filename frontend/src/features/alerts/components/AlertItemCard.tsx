import { useP } from "../../../app/project";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Alert, Model } from "../../../shared/api/types";
import { resolveAlert } from "../api/alertsApi";
import { newKindView } from "../newKinds";
import { useBillingMode } from "../../projects/hooks/useBillingMode";
import { MONEY_ALERT_FALLBACK, serverText } from "../../projects/moneyWording";
import { deprecated, formatPValue, silentDrop, versionRegression } from "../details";
import { Badge } from "../../../shared/components/Badge";
import { Card } from "../../../shared/components/Card";
import { RelatedNews } from "../../news/components/RelatedNews";
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

const DAY = 86_400_000;

/** Stories from two weeks before an alert to three days after it: an announcement usually comes first. */
export function newsWindow(createdAt: string): { since: string; until: string } {
  const at = new Date(createdAt).getTime();
  return { since: new Date(at - 14 * DAY).toISOString(), until: new Date(at + 3 * DAY).toISOString() };
}

export type AlertListItem =
  | { kind: "regression"; alert: Alert; timestamp: string }
  | { kind: "deprecation"; model: Model; timestamp: string };

export function AlertItemCard({ item }: { item: AlertListItem }) {
  const p = useP();
  if (item.kind === "deprecation") {
    const { model } = item;
    const { text, isUrgent } = model.shutdown_date
      ? formatShutdownCountdown(model.shutdown_date)
      : { text: "Shutting down", isUrgent: false };

    return (
      <Card className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone="warn">Shutting down</Badge>
            <span className="min-w-0 break-all font-mono text-base font-bold text-ink">
              {model.model}
            </span>
            {model.model_version && (
              <span className="break-all font-mono text-xs text-dim">
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
            to={p("/models")}
            className="text-xs font-semibold text-accent hover:underline"
          >
            View in model catalog →
          </Link>
        </div>

        {/* The provider's own announcement usually says what to move to */}
        <RelatedNews title="In the news about this model" filters={{ model: model.model }} />
      </Card>
    );
  }

  return <AlertCard alert={item.alert} />;
}

function Rates({ before, after, note }: { before: number; after: number; note: string }) {
  return (
    <div className="space-y-1.5 rounded-card border border-rule bg-bg p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-2xl font-bold text-ink">{(before * 100).toFixed(1)}%</span>
        <span className="text-lg text-dim">→</span>
        <span className="font-mono text-2xl font-bold text-bad">{(after * 100).toFixed(1)}%</span>
        <span className="font-mono text-sm font-semibold text-bad">
          ({((after - before) * 100).toFixed(1)} points)
        </span>
      </div>
      <p className="text-xs text-dim">{note}</p>
    </div>
  );
}

function AlertCard({ alert }: { alert: Alert }) {
  const p = useP();
  const { mode } = useBillingMode();
  // A flat-fee plan has no bill: the server's dollar wording is replaced, never shown.
  const summary = serverText(alert.summary, mode, MONEY_ALERT_FALLBACK);
  const queryClient = useQueryClient();
  const resolve = useMutation({
    mutationFn: () => resolveAlert(alert.alert_id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["regressions"] });
    },
  });
  const isResolved = alert.resolved_at !== null;
  const regression = versionRegression(alert);
  const silent = silentDrop(alert);
  const retired = deprecated(alert);
  const alertModel = regression?.model ?? silent?.model ?? retired?.model;
  const nk = newKindView(alert);

  if (nk) {
    return (
      <Card className={`space-y-3 ${isResolved ? "opacity-70" : ""}`}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className={nk.tone === "bad" ? "text-bad" : "text-warn"}>{nk.icon}</span>
            <Badge tone={nk.tone}>{nk.title}</Badge>
            {isResolved && <Badge tone="ok">Resolved {formatLocalDate(alert.resolved_at!)}</Badge>}
          </div>
          <span className="font-mono text-xs text-dim">{formatLocalTimestamp(alert.created_at)}</span>
        </div>
        <p className="text-sm text-ink">{summary}</p>
        {nk.numbers && serverText(nk.numbers, mode, null) && <p className="text-xs text-dim">{nk.numbers}</p>}
        <div className="flex shrink-0 items-center gap-3">
          <Link to={p(nk.to)} className="text-xs font-semibold text-accent hover:underline">{nk.linkLabel}</Link>
          {!isResolved && (
            <button
              type="button"
              onClick={() => resolve.mutate()}
              disabled={resolve.isPending}
              className="rounded-md border border-rule bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-bg disabled:opacity-50"
            >
              {resolve.isPending ? "Resolving…" : "Mark resolved"}
            </button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className={`space-y-4 ${isResolved ? "opacity-70" : ""}`}>
      {/* Header: Badge, Job name, Timestamp */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {regression && <Badge tone="bad">Quality drop</Badge>}
          {silent && <Badge tone="bad">Quiet quality drop</Badge>}
          {retired && <Badge tone="warn">{retired.status === "RETIRED" ? "Retired" : "Deprecated"}</Badge>}
          {isResolved && (
            <Badge tone="ok">Resolved {formatLocalDate(alert.resolved_at!)}</Badge>
          )}
          <Link
            to={p(`/jobs/${encodeURIComponent(alert.job)}?tab=quality`)}
            title={alert.job}
            className="min-w-0 break-all text-base font-bold text-accent hover:underline"
          >
            {alert.job}
          </Link>
        </div>
        <span className="font-mono text-xs text-dim">
          {formatLocalTimestamp(alert.created_at)}
        </span>
      </div>

      {regression && (
        <>
          <div className="break-all font-mono text-sm text-dim">
            <span className="font-semibold text-ink">{regression.model}</span>{" "}
            <span>{regression.old_version}</span> <span className="text-dim">→</span>{" "}
            <span className="font-semibold text-ink">{regression.new_version}</span>
          </div>
          <Rates
            before={regression.old_pass_rate}
            after={regression.new_pass_rate}
            note={`Share of correct answers before and after the model changed, based on ${regression.n_old.toLocaleString()} AI calls before and ${regression.n_new.toLocaleString()} after (${formatPValue(regression.p_value)}; a lower number means the drop is less likely to be chance)`}
          />
        </>
      )}

      {silent && (
        <>
          <div className="font-mono text-sm text-dim">
            <span className="font-semibold text-ink">{silent.model_version}</span>, same version throughout
          </div>
          <Rates
            before={silent.before_pass_rate}
            after={silent.after_pass_rate}
            note={`Share of correct answers, earlier (${silent.n_before.toLocaleString()} AI calls) against the latest (${silent.n_after.toLocaleString()}) (${formatPValue(silent.p_value)}; a lower number means the drop is less likely to be chance). The provider may have changed the model without giving it a new name.`}
          />
        </>
      )}

      {/* What the model makers and the press said about this model around when it happened */}
      {alertModel && (
        <RelatedNews
          title="In the news around this alert"
          filters={{ model: alertModel, ...newsWindow(alert.created_at) }}
        />
      )}

      {/* Footer: summary, delivery, actions */}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <p className="text-xs text-ink">{summary}</p>
          <p className="text-[11px] text-dim">
            {alert.delivered_at
              ? `Sent to the webhook ${formatLocalTimestamp(alert.delivered_at)}`
              : alert.delivery_failed_at
              ? `Webhook unreachable after ${alert.delivery_attempts} attempts; stopped trying. Save the webhook URL in Settings to try again`
              : alert.delivery_attempts > 0
              ? `Webhook not reached yet (${alert.delivery_attempts} attempts); retrying`
              : "Not sent to a webhook"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to={p(`/jobs/${encodeURIComponent(alert.job)}?tab=runs&outcome=FAIL`)}
            className="text-xs font-semibold text-accent hover:underline"
          >
            See the wrong answers →
          </Link>
          {!isResolved && (
            <button
              type="button"
              onClick={() => resolve.mutate()}
              disabled={resolve.isPending}
              className="rounded-md border border-rule bg-surface px-3 py-1 text-xs font-semibold text-ink hover:bg-bg disabled:opacity-50"
            >
              {resolve.isPending ? "Resolving…" : "Mark resolved"}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
