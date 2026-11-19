/** Settings: one page, one section per decision, with a section menu beside it. */
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AddLimitForm } from "../features/limits/components/AddLimitForm";
import { LimitCard } from "../features/limits/components/LimitCard";
import { useLimits } from "../features/limits/hooks/useLimits";
import { ApiKeyRevealBox } from "../features/projects/components/ApiKeyRevealBox";
import { DeleteProjectCard } from "../features/projects/components/DeleteProjectCard";
import { usePatchProject, useProject, useRegenerateProjectKey } from "../features/projects/hooks/useProjects";
import { ProviderKeyForm } from "../features/retest/components/ProviderKeyForm";
import { useDeleteProviderKey, useRetestLimits } from "../features/retest/hooks/useRetest";
import { ProjectKeySettings } from "../features/settings/components/ProjectKeySettings";
import { useProject as useProjectScope } from "../app/project";
import { useNavigate } from "react-router-dom";
import type { Project } from "../shared/api/types";
import { useHealth } from "../features/health/api";
import { useDeleteToolInputs } from "../features/projects/hooks/useToolInputs";
import { ApiError } from "../shared/api/apiFetch";
import { Help } from "../ui/Help";
import { BillingChoice } from "../features/projects/components/BillingChoice";
import type { BillingMode } from "../features/projects/hooks/useBillingMode";
import { billingTitle, payModeChange } from "../features/projects/payModeChange";
import { usd } from "../ui/format";
import { IconCheck } from "../ui/icons";
import { ApplyBar } from "../ui/ApplyBar";
import { InlineConfirm } from "../ui/InlineConfirm";
import { useToast } from "../ui/Toast";
import { useDraftSection } from "../ui/useDraftSection";
import { isNotices, useNotices } from "../features/notices/api/noticesApi";
import { BudgetEditor } from "./overview/BudgetEditor";
import { Button, cx, EmptyState, Panel, PanelHeader, Pill, Skeleton } from "../ui/primitives";

const SECTIONS = [
  { id: "project", label: "Project" },
  { id: "alerts", label: "Alerts" },
  { id: "notices", label: "Model notices" },
  { id: "ai-summaries", label: "AI summaries" },
  { id: "privacy", label: "Data kept" },
  { id: "retests", label: "Model trials" },
  { id: "keys", label: "API keys" },
  { id: "billing", label: "How you pay" },
  { id: "budget", label: "Spending limit" },
  { id: "tool-inputs", label: "Tool inputs" },
  { id: "limits", label: "Usage limits" },
  { id: "status", label: "System status" },
  { id: "danger", label: "Delete" },
];

const field =
  "w-full rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-accent";

/** Sends one PATCH to the project and throws if it fails. Used by every section's Apply. */
function useProjectSave(project: { project_id: string }) {
  const patch = usePatchProject();
  return useCallback((input: Parameters<typeof patch.mutateAsync>[0]["input"]) => patch.mutateAsync({ id: project.project_id, input }), [patch.mutateAsync, project.project_id]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function ProjectSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const d = useDraftSection<string>({
    saved: project.name,
    equal: (a, b) => a.trim() === b || a.trim().length === 0,
    save: (name) => send({ name: name.trim() }),
    success: "Settings applied",
  });
  return (
    <Panel id="project" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Project" hint="Your app sends its AI calls here with this project's API key (see API keys below)." />
      <form onSubmit={(e) => { e.preventDefault(); void d.apply(); }}>
        <label htmlFor="project-name" className="mt-4 block text-xs font-semibold text-dim">Name</label>
        <input id="project-name" className={cx(field, "mt-1.5 max-w-md")} value={d.value} onChange={(e) => d.change(e.target.value)} maxLength={100} />
        <ApplyBar dirty={d.dirty} applying={d.applying} error={d.error} onApply={d.apply} onDiscard={d.discard} />
      </form>
    </Panel>
  );
}

export function AlertsSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const d = useDraftSection<string>({
    saved: project.webhook_url ?? "",
    equal: (a, b) => a.trim() === b,
    validate: (u) => (u.trim() && !u.trim().startsWith("https://") ? "Use an address that starts with https://." : null),
    save: (u) => send({ webhook_url: u.trim() || null }),
    success: (u) => (u.trim() ? "Alert address saved" : "Alert address removed. Alerts now show only in the app."),
  });
  const removing = d.dirty && d.value.trim() === "" && Boolean(project.webhook_url);
  return (
    <Panel id="alerts" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Where alerts go" hint="Paste a Slack, Discord, Google Chat or Mattermost webhook. Leave empty to see alerts here only." />
      <label htmlFor="webhook" className="mt-4 block text-xs font-semibold text-dim">Webhook URL</label>
      <input id="webhook" type="url" className={cx(field, "mt-1.5")} value={d.value} onChange={(e) => d.change(e.target.value)} placeholder="https://hooks.slack.com/services/…" aria-invalid={d.error ? true : undefined} />
      {project.webhook_secret && (
        <details className="mt-2 text-xs text-muted">
          <summary className="cursor-pointer font-semibold text-accent">For developers: check a message came from us</summary>
          <div className="mt-2 space-y-1">
          <p>
            If you send alerts to your own program, you can check a message really came from us. Each one carries a time in <span className="font-mono">X-MCM-Timestamp</span> and a signature in <span className="font-mono">X-MCM-Signature-V2</span>.
          </p>
          <p>
            Work the signature out with your secret <span className="font-mono text-dim">{project.webhook_secret.slice(0, 6)}…</span> (HMAC-SHA256 over the timestamp, a dot, then the message body), and ignore messages older than 5 minutes.
          </p>
          <p>
            For now we also still send the older <span className="font-mono">X-MCM-Signature</span>, which signs the body only.
          </p>
          </div>
        </details>
      )}
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        review={removing ? "With no address, alerts only appear in the app. Nothing is sent to Slack or anywhere else." : undefined}
        applyLabel={removing ? "Remove address" : "Save address"}
        applyingLabel="Saving…"
        discardLabel={removing ? "Keep address" : "Discard"}
      />
    </Panel>
  );
}

export function PrivacySection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const okDays = (t: string) => Number.isInteger(Number(t)) && Number(t) >= 1 && Number(t) <= 3650;
  const d = useDraftSection<string>({
    saved: String(project.content_retention_days),
    equal: (a, b) => !okDays(a) || Number(a) === Number(b),
    save: (t) => send({ content_retention_days: Number(t) }),
    success: (t) => `Keeping prompts and answers for ${Number(t)} days`,
  });
  const days = d.value;
  const valid = okDays(days);
  const savedDays = project.content_retention_days;
  const lowering = d.dirty && valid && Number(days) < savedDays;
  return (
    <Panel id="privacy" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title={<span className="inline-flex items-center gap-1.5">How long prompts and answers are kept <Help label="About keeping prompts and answers">Tokens are the small pieces of text AI models read and write. After this many days the text of each AI call (prompt, answer, tool calls, answer key) is deleted each night. Whether it was correct, what it cost and how many tokens it used are kept, so our recommendations do not change.</Help></span>} hint="The text of each AI call is deleted after this many days." />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input id="retention" type="number" min={1} max={3650} className={field.replace("w-full", "w-28")} value={days} onChange={(e) => d.change(e.target.value)} aria-label="Days to keep AI call content" />
        <span className="text-sm text-dim">days</span>
        {[30, 90, 365].map((n) => (
          <button key={n} type="button" onClick={() => d.change(String(n))} className={cx("rounded-full border px-3 py-1 text-xs font-semibold", Number(days) === n ? "border-accent text-accent" : "border-rule text-muted hover:text-dim")}>
            {n}
          </button>
        ))}
      </div>
      {!valid && <p role="alert" className="mt-2 text-xs text-bad">Between 1 and 3650 days.</p>}
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={lowering ? `Delete older text, keep ${Number(days)} days` : valid ? `Keep ${Number(days)} days` : "Apply"}
        discardLabel={`Keep ${savedDays} days`}
        review={lowering ? (
          <><span className="font-semibold text-ink">What will be deleted.</span> At the next nightly clean-up, the prompt, answer, tool calls and answer key of every AI call older than {Number(days)} days are deleted, and so are the AI task summaries written from them. Whether each call was correct, what it cost and its token counts stay. Deleted text cannot be brought back.</>
        ) : undefined}
      />
    </Panel>
  );
}

export function RetestsSection({ project }: { project: Project | null }) {
  const limits = useRetestLimits();
  const removeKey = useDeleteProviderKey();
  const send = useProjectSave(project ?? { project_id: "" });
  const d = useDraftSection<{ cap: string; allowed: boolean }>({
    saved: { cap: project ? String(project.retest_monthly_cap_usd) : "", allowed: project?.retest_allowed ?? true },
    equal: (a, b) => Number(a.cap) === Number(b.cap) && a.allowed === b.allowed,
    save: (v) => send({ retest_monthly_cap_usd: Number(v.cap), retest_allowed: v.allowed }),
    success: (v) => (v.allowed ? "Trials are allowed" : "Trials are turned off"),
  });
  const { cap, allowed } = d.value;
  const turningOn = d.dirty && allowed && !d.saved.allowed;
  const toast = useToast();
  const [editingKey, setEditingKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const l = limits.data;
  const doRemove = async () => {
    setRemoveError(null);
    try {
      await removeKey.mutateAsync();
      setConfirmRemove(false);
      toast({ message: `${l?.provider_key?.provider ?? "Provider"} key removed` });
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Could not remove the key. Try again.");
    }
  };
  const share = l && l.monthly_cap_usd > 0 ? Math.min(1, l.spent_this_month_usd / l.monthly_cap_usd) : 0;
  return (
    <Panel id="retests" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Trials on a new model" hint="Replay past prompts on another model, using your provider key and a budget you set." />
      {l && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-dim">
            <span>Spent this month</span>
            <span className="tabular">{usd(l.spent_this_month_usd)} of {usd(l.monthly_cap_usd)}</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3">
            <div className={cx("h-full rounded-full", share > 0.9 ? "bg-bad" : share > 0.7 ? "bg-warn" : "bg-accent")} style={{ width: `${share * 100}%` }} />
          </div>
        </div>
      )}
      {project && (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold text-dim">Monthly budget for trials (USD)</span>
            <input type="number" min={0} max={10000} className={cx(field.replace("w-full", "w-40"), "mt-1.5 block")} value={cap} onChange={(e) => d.change({ ...d.value, cap: e.target.value })} />
          </label>
          <label className="flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
            <input type="checkbox" checked={allowed} onChange={(e) => d.change({ ...d.value, allowed: e.target.checked })} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
            <span>
              <span className="block text-sm font-semibold text-ink">Allow trials on new models</span>
              <span className="text-xs text-dim">Past prompts are sent to the provider of the model being tested.</span>
            </span>
          </label>
        </div>
      )}
      {project && (
        <ApplyBar
          dirty={d.dirty}
          applying={d.applying}
          error={d.error}
          onApply={d.apply}
          onDiscard={d.discard}
          applyLabel={turningOn ? "Allow trials" : "Apply"}
          discardLabel={turningOn ? "Keep trials off" : "Discard"}
          review={turningOn ? <>Past prompts will be sent to the provider of the model you choose to test, at their cost, within your trial budget of {usd(Number(cap) || 0)} a month.</> : undefined}
        />
      )}
      <div className="mt-5 border-t border-rule pt-5">
        <p className="text-sm font-semibold text-ink">Provider key</p>
        {limits.isPending ? (
          <Skeleton className="mt-3 h-12" />
        ) : l?.provider_key && !editingKey ? (
          <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
            <span className="text-sm text-dim">
              <span className="font-semibold text-ink">{l.provider_key.provider}</span> key ending <span className="font-mono text-ink">…{l.provider_key.key_hint}</span>
            </span>
            <span className="flex gap-2">
              <Button size="sm" onClick={() => setEditingKey(true)}>Replace</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRemoveError(null); setConfirmRemove(true); }} disabled={removeKey.isPending || confirmRemove}>Remove</Button>
            </span>
          </div>
          {confirmRemove && (
            <InlineConfirm label="Remove the provider key" confirmLabel="Remove key" cancelLabel="Keep key" danger busy={removeKey.isPending} busyLabel="Removing…" error={removeError} onConfirm={() => void doRemove()} onCancel={() => setConfirmRemove(false)}>
              Remove the {l.provider_key.provider} key? New trials cannot start without a key. You can add it again.
            </InlineConfirm>
          )}
          </>
        ) : (
          <div className="mt-3">
            <ProviderKeyForm onSaved={() => setEditingKey(false)} />
          </div>
        )}
      </div>
    </Panel>
  );
}

/** The paste-a-key box is only for people working without sign-in (a project key or the public demo). */
export function KeysSection({ project, mode }: { project: Project | null; mode: "owned" | "key" | "demo" }) {
  const regenerate = useRegenerateProjectKey();
  const [fresh, setFresh] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <Panel id="keys" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="API keys" hint="Your app uses the project key to send AI calls. It is shown once when made." />
      {fresh && (
        <div className="mt-4">
          <ApiKeyRevealBox apiKey={fresh} title="Your new project key. Copy it now: it is not shown again." onDismiss={() => setFresh(null)} />
        </div>
      )}
      {project && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-4">
          <span className="text-sm text-dim">Live key <span className="font-mono text-ink">{project.key_prefix}…</span></span>
          {confirm ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-warn">The current key stops working at once.</span>
              <Button size="sm" variant="danger" disabled={regenerate.isPending} onClick={async () => { setFresh((await regenerate.mutateAsync(project.project_id)).api_key); setConfirm(false); }}>Make a new key</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            </span>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)}>Make a new key</Button>
          )}
        </div>
      )}
      {mode !== "owned" && (
        <div className="mt-5 border-t border-rule pt-5">
          <ProjectKeySettings />
        </div>
      )}
    </Panel>
  );
}

/** How the project pays for AI. A choice is only a draft until Apply: it rewrites the wording on every screen. */
export function BillingSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const savedMode = (project.billing_mode ?? "per_use") as BillingMode;
  const d = useDraftSection<BillingMode>({
    saved: savedMode,
    save: (mode) => send({ billing_mode: mode }),
    success: (mode) => `Pay mode changed to ${billingTitle(mode)}`,
  });
  return (
    <Panel id="billing" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader
        title={<span className="inline-flex items-center gap-1.5">How you pay for AI <Help label="About how you pay for AI">If you pay a flat monthly fee, a dollar figure is not your bill, so we talk about your usage allowance and how to make it last longer instead of money saved. Your recorded calls and our recommendations stay the same; only the wording and which alerts we send change.</Help></span>}
        hint="Pick what is closest. You can change it any time."
      />
      <div className="mt-3">
        <BillingChoice value={d.value} onChange={d.change} disabled={d.applying} name="settings-billing-mode" />
      </div>
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={`Switch to ${billingTitle(d.value)}`}
        applyingLabel="Switching…"
        discardLabel={`Keep ${billingTitle(savedMode)}`}
        review={<><span className="font-semibold text-ink">What will change.</span> {payModeChange(savedMode, d.value, project.monthly_budget_usd ?? null)}</>}
      />
    </Panel>
  );
}

/** For a subscription there is no dollar limit; the allowance windows live on the usage-limits card below. */
function SubscriptionLimitPointer() {
  return (
    <Panel id="budget" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Your allowance" hint="You pay a flat fee, so there is no dollar limit to set. Your plan's allowance is what matters." />
      <p className="mt-3 text-sm text-dim">Add your allowance in <a href="#limits" onClick={(e) => { e.preventDefault(); document.getElementById("limits")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className="text-accent underline">Usage limits</a>, below.</p>
    </Panel>
  );
}

/** The most the person wants their AI calls to cost each month; we only warn, never block. */
export function BudgetSection({ project }: { project: Project }) {
  const current = project.monthly_budget_usd ?? null;
  return (
    <Panel id="budget" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title={<span className="inline-flex items-center gap-1.5">Monthly spending limit <Help label="About the spending limit">We warn you at the percentages you choose under Budget alerts (85% and 95% unless you change them), and if even the low end of the forecast goes over. The spend is an estimate from your recorded calls at list prices.</Help></span>} hint="The most you want your AI calls to cost each month." />
      <p className="mt-3 text-sm text-ink">Current limit: <span className="font-semibold">{current === null ? "Not set" : `$${current.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(current) ? 0 : 2 })} a month`}</span></p>
      <div className="mt-3">
        <BudgetEditor id="monthly-budget" alwaysOpen />
      </div>
    </Panel>
  );
}

/** The warnings that can be chosen. 100 means the limit itself has been reached. */
export const LEVEL_CHOICES = [50, 75, 85, 90, 95, 100] as const;
const COMMON_ZONES = ["UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Europe/Paris", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"];

/** Every timezone name the browser knows, UTC first; a short common list where the browser cannot list them. */
export function timezoneChoices(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  return [...new Set(["UTC", current, ...(all.length ? all : COMMON_ZONES)])];
}

type AlertDraft = { levels: number[]; projected: boolean; tz: string; webhook: boolean };

/** Which warnings the owner wants, in which timezone, and whether they also go to the webhook. They are always shown in
 * the app. Nothing is blocked, and nothing leaves the app unless the webhook is turned on here. */
export function BudgetAlertsSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const hasWebhook = Boolean(project.webhook_url);
  const d = useDraftSection<AlertDraft>({
    saved: {
      levels: [...(project.budget_alert_levels ?? [85, 95])].sort((a, b) => a - b),
      projected: project.budget_alert_projected !== false,
      tz: project.budget_timezone ?? "UTC",
      webhook: project.budget_alert_webhook === true,
    },
    save: (v) => send({ budget_alert_levels: v.levels, budget_alert_projected: v.projected, budget_timezone: v.tz, budget_alert_webhook: v.webhook }),
    success: "Budget alert settings saved",
  });
  const { levels, projected, tz, webhook } = d.value;
  const turningWebhookOn = d.dirty && webhook && !d.saved.webhook;
  let host = "your webhook";
  try {
    host = new URL(project.webhook_url ?? "").host || host;
  } catch {
    /* keep the plain wording */
  }
  const zones = timezoneChoices(tz);
  const toggle = (n: number) => d.change({ ...d.value, levels: levels.includes(n) ? levels.filter((x) => x !== n) : [...levels, n].sort((a, b) => a - b) });
  return (
    <Panel id="budget-alerts" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Budget alerts" hint="Always shown in the app. Nothing is sent anywhere unless you turn it on here. They only warn: nothing is ever blocked." />
      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-dim">Warn me when spending reaches</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {LEVEL_CHOICES.map((n) => (
            <label key={n} className="inline-flex items-center gap-2 rounded-[10px] border border-rule bg-surface-2/50 px-3 py-1.5 text-sm text-ink">
              <input type="checkbox" checked={levels.includes(n)} onChange={() => toggle(n)} className="h-4 w-4 accent-[var(--color-accent)]" />
              {n}%
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted">Of the monthly limit, counting spend that has already happened. Each warning comes once a month.</p>
      </fieldset>

      <label className="mt-4 flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
        <input type="checkbox" checked={projected} onChange={(e) => d.change({ ...d.value, projected: e.target.checked })} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-sm font-semibold text-ink">Also warn me when the forecast says I will go over</span>
          <span className="text-xs text-dim">Only when even the low end of the forecast is above your limit. This is a forecast, not spend that has happened.</span>
        </span>
      </label>

      <label className="mt-4 block">
        <span className="text-xs font-semibold text-dim">Timezone for the month and its days</span>
        <select value={tz} onChange={(e) => d.change({ ...d.value, tz: e.target.value })} className={cx(field.replace("w-full", "w-72"), "mt-1.5 block")} aria-label="Timezone for the month and its days">
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        <span className="mt-1 block text-xs text-muted">The month starts and ends at midnight in this timezone. Now: {tz}.</span>
      </label>

      <div className="mt-4">
        <p className="text-xs font-semibold text-dim">Where budget alerts go</p>
        <ul className="mt-2 space-y-2">
          <li className="text-sm text-ink">In the app <span className="text-xs text-muted">(always, in Activity)</span></li>
          <li>
            <label className={cx("flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3", !hasWebhook && "opacity-70")}>
              <input type="checkbox" checked={webhook} disabled={!hasWebhook} onChange={(e) => d.change({ ...d.value, webhook: e.target.checked })} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
              <span>
                <span className="block text-sm font-semibold text-ink">Also send budget alerts to my webhook</span>
                <span className="text-xs text-dim">{hasWebhook ? `They would be posted to ${host}. Off by default.` : "Add a webhook address in Alerts first, then you can turn this on."}</span>
              </span>
            </label>
          </li>
          <li className="text-sm text-muted">Email <span className="text-xs">(not available yet)</span></li>
        </ul>
      </div>
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={turningWebhookOn ? "Send budget alerts there" : "Apply"}
        discardLabel={turningWebhookOn ? "Keep them in the app only" : "Discard"}
        review={turningWebhookOn ? <>Budget alerts, with your spending figures but no prompt text, will also be posted to {host}. You can turn this off at any time.</> : undefined}
      />
    </Panel>
  );
}

const SOURCE_STATE: Record<string, string> = {
  NEVER: "Not read yet",
  OK: "Read",
  UNREADABLE: "Could not be read (its layout may have changed)",
  FETCH_FAILED: "Could not be fetched",
};

/** "17 Nov 2026" for a checked-at time. */
const checkedOn = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

/** Deprecation and shutdown notices from the providers' own pages, for the models this project ran in the last 30 days.
 * Information only: nothing is migrated, replaced or switched. They leave the app only if the owner opts in here. */
export function ModelNoticesSection({ project }: { project: Project }) {
  const q = useNotices();
  const data = isNotices(q.data) ? q.data : null;
  const send = useProjectSave(project);
  const hasWebhook = Boolean(project.webhook_url);
  const d = useDraftSection<boolean>({
    saved: project.notice_alert_webhook === true,
    save: (next) => send({ notice_alert_webhook: next }),
    success: (next) => (next ? "Model notices will also go to your webhook" : "Model notices stay in the app"),
  });
  let host = "your webhook";
  try {
    host = new URL(project.webhook_url ?? "").host || host;
  } catch {
    /* keep the plain wording */
  }
  const turningOn = d.dirty && d.value && !d.saved;
  const neverRead = data ? data.sources.every((x) => x.status === "NEVER") : false;
  return (
    <Panel id="notices" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Model notices" hint="What each provider's own page says about the models you used in the last 30 days. Information only: nothing is changed or switched for you." />
      {q.isPending ? (
        <Skeleton className="mt-4 h-24" />
      ) : !data ? (
        <p role="alert" className="mt-4 text-sm text-bad">Could not load the notices. Try again in a moment.</p>
      ) : (
        <>
          {data.notices.length === 0 ? (
            <p className="mt-4 text-sm text-dim" data-testid="no-notices">
              {neverRead
                ? "We have not read the providers' pages yet, so there is nothing to show. This is checked once a day."
                : "No provider notice mentions a model you used in the last 30 days."}
            </p>
          ) : (
            <ul className="mt-4 space-y-3" data-testid="notice-list">
              {data.notices.map((n) => (
                <li key={n.notice_id} className="rounded-[12px] border border-rule bg-surface-2/50 p-3">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
                    <span className="font-mono text-[13px]">{n.model}</span>
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-muted">{n.status}</span>
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-muted">Information only</span>
                  </p>
                  <p className="mt-1 text-sm text-dim">{n.text}</p>
                  {!n.served_by_known && <p className="mt-1 text-xs text-muted">We could not tell where your calls are served. If you use a partner platform, its dates may differ.</p>}
                  {n.replacement && <p className="mt-1 text-xs text-muted">The provider lists {n.replacement} as a replacement. We change nothing.</p>}
                  <p className="mt-1 text-xs text-muted">
                    Checked {checkedOn(n.checked_at)} on {n.source_name}.{" "}
                    <a href={n.notice_url} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent-ink hover:underline">Open the provider's notice ↗</a>
                    {n.stale_note ? ` ${n.stale_note}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {data.hosted_elsewhere.length > 0 && (
            <p className="mt-3 text-xs text-muted" data-testid="elsewhere">
              Not applied: {data.hosted_elsewhere.length === 1 ? "1 notice is" : `${data.hosted_elsewhere.length} notices are`} about a provider's own API, but your calls for {data.hosted_elsewhere.map((e) => e.model).join(", ")} name another host, which sets its own dates.
            </p>
          )}
          <div className="mt-4 border-t border-rule pt-3">
            <p className="text-xs font-semibold text-dim">Where these pages come from</p>
            <ul className="mt-2 space-y-1.5" data-testid="notice-sources">
              {data.sources.map((x) => (
                <li key={x.source_id} className="text-xs text-muted">
                  <a href={x.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-ink hover:underline">{x.name}</a>
                  {": "}
                  {x.status === "OK"
                    ? `${SOURCE_STATE.OK} ${checkedOn(x.last_ok_at)}${x.stale ? ". This reading is more than 7 days old" : ""}.`
                    : `${SOURCE_STATE[x.status] ?? x.status}${x.last_ok_at ? `. Last good reading ${checkedOn(x.last_ok_at)}` : ""}.`}
                  {" "}{x.covers}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <label className={cx("mt-4 flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3", !hasWebhook && "opacity-70")}>
        <input type="checkbox" checked={d.value} disabled={!hasWebhook} onChange={(e) => d.change(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-sm font-semibold text-ink">Also send model notices to my webhook</span>
          <span className="text-xs text-dim">{hasWebhook ? `They would be posted to ${host}. Off by default. Notices are always shown in the app.` : "Add a webhook address in Alerts first, then you can turn this on."}</span>
        </span>
      </label>
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={turningOn ? "Send notices there" : "Apply"}
        discardLabel={turningOn ? "Keep them in the app only" : "Discard"}
        review={turningOn ? <>Model notices (the model, the provider's date and a link to its page, no prompt text) will also be posted to {host}. You can turn this off at any time.</> : undefined}
      />
    </Panel>
  );
}

/** Off by default. When on, the figures behind a recommendation go to an outside AI that writes two sentences. */
export function AiSummariesSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const host = project.ai_summary_host ?? null;
  const d = useDraftSection<boolean>({
    saved: project.ai_summary_consent === true,
    save: (next) => send({ ai_summary_consent: next }),
    success: (next) => (next ? "Plain-language summaries are on" : "Plain-language summaries are off"),
  });
  const turningOn = d.dirty && d.value && !d.saved;
  const flat = project.billing_mode === "subscription";
  return (
    <Panel id="ai-summaries" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Plain-language summaries" hint="Two sentences under a recommendation, written by an outside AI from the figures. Off by default. Never changes a recommendation." />
      <label className={cx("mt-4 flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3", !host && "opacity-70")}>
        <input type="checkbox" checked={d.value} disabled={!host && !d.value} onChange={(e) => d.change(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-sm font-semibold text-ink">Write a summary under each recommendation</span>
          <span className="text-xs text-dim">{host ? `The figures would be sent to ${host}.` : "This server has no summary service, so there is nothing to turn on."}</span>
        </span>
      </label>
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={turningOn ? "Send figures there" : "Apply"}
        discardLabel={turningOn ? "Keep summaries off" : "Discard"}
        review={turningOn ? (
          <>
            Sent to {host}: model names, correct-answer rates and their ranges{flat ? "" : ", and costs"}. Never your prompts, answers or any run text. A daily limit applies. The text is checked against the figures, and is not shown if it does not match. You can turn this off at any time, and the summary then disappears.
          </>
        ) : undefined}
      />
    </Panel>
  );
}

/** Off by default. When on, trials of new models can start by themselves, spending your own provider budget, with no per-trial confirmation. */
export function AutoTrialsSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const d = useDraftSection<boolean>({
    saved: project.auto_retests === true,
    save: (next) => send({ auto_retests: next }),
    success: (next) => (next ? "Automatic trials are on" : "Automatic trials are off"),
  });
  const turningOn = d.dirty && d.value && !d.saved;
  return (
    <Panel id="auto-trials" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Automatic trials" hint="Off by default. Normally every trial on another model starts only after you review and confirm it." />
      <label className="mt-4 flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
        <input type="checkbox" checked={d.value} onChange={(e) => d.change(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          <span className="block text-sm font-semibold text-ink">Let trials start by themselves</span>
          <span className="text-xs text-dim">When a new model appears, when we are unsure about a cheaper one, or when you first add a provider key, a small trial may run on its own, within your monthly trial budget.</span>
        </span>
      </label>
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={turningOn ? "Allow automatic trials" : "Apply"}
        discardLabel={turningOn ? "Keep them off" : "Discard"}
        review={turningOn ? (
          <>
            Past prompts of your AI tasks will be sent to the provider behind your stored key, and your own money spent, without asking each time. Each trial stays within its budget and your monthly trial budget. Your live traffic and code are never changed. You can turn this off again at any time.
          </>
        ) : undefined}
      />
    </Panel>
  );
}

/** Off by default. When on, the project keeps the inputs of tool calls, only to spot an agent repeating a step. */
export function ToolInputsSection({ project }: { project: Project }) {
  const send = useProjectSave(project);
  const d = useDraftSection<boolean>({
    saved: project.store_tool_arguments === true,
    save: (next) => send({ store_tool_arguments: next }),
    success: (next) => (next ? "Tool inputs are now kept" : "Tool inputs are no longer kept"),
  });
  const on = d.value;
  const savedOn = project.store_tool_arguments === true;
  const wipe = useDeleteToolInputs();
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const remove = async () => {
    setError(null);
    setConfirming(false);
    try {
      setCleared((await wipe.mutateAsync(project.project_id)).runs_cleared);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not delete");
    }
  };
  return (
    <Panel id="tool-inputs" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader
        title={<span className="inline-flex items-center gap-1.5">Keep the inputs of tool calls so loops are easier to spot <Help label="About tool inputs">When your agent calls a tool, the call has inputs, like the search words it used. With this on, your app can send them to us. We compare them only to notice when an agent repeats the same step. They are never used to train anything, and they are deleted with the rest of the AI call text after your retention period.</Help></span>}
        hint="Lets us notice when an agent repeats the same step."
      />
      <p role="note" className="mt-3 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-[13px] text-ink">
        <span className="font-semibold">Warning:</span> tool inputs may contain private data, such as customer names, file contents or secrets. Leave this off unless you are comfortable with that being stored.
      </p>
      <label className="mt-3 flex items-center gap-3 text-sm text-ink">
        <input type="checkbox" role="switch" className="h-4 w-4" checked={on} disabled={d.applying} onChange={(e) => d.change(e.target.checked)} aria-label="Keep the inputs of tool calls so loops are easier to spot" />
        <span>{on ? "On: new tool inputs are stored" : "Off: tool inputs are not stored"}</span>
      </label>
      <ApplyBar
        dirty={d.dirty}
        applying={d.applying}
        error={d.error}
        onApply={d.apply}
        onDiscard={d.discard}
        applyLabel={on ? "Turn on" : "Turn off"}
        discardLabel={savedOn ? "Keep it on" : "Keep it off"}
        review={on ? "Turning this on stores the tool inputs your app sends, and they may contain private data. They are deleted after your retention period." : "Turning this off stops storing new inputs. Inputs already stored stay until you delete them below or your retention period ends."}
      />
      <p className="mt-2 text-xs text-muted">
        {on
          ? "Your app also has to send them (the recorder option send_tool_arguments). Turning this off stops storing new inputs; ones already stored stay until you delete them below or your retention period ends."
          : "Turning this off stops storing new inputs. Any stored earlier stay until you delete them below or your retention period ends."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-sm text-ink">Delete every stored tool input for this project?</span>
            <Button variant="danger" size="sm" onClick={() => void remove()} disabled={wipe.isPending}>Yes, delete them</Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => { setCleared(null); setConfirming(true); }} disabled={wipe.isPending}>{wipe.isPending ? "Deleting…" : "Delete stored tool inputs"}</Button>
        )}
        {cleared !== null && <span className="flex items-center gap-1 text-xs text-ok"><IconCheck size={14} /> {cleared === 0 ? "None were stored" : `Removed from ${cleared} calls`}. Tool names and counts are kept.</span>}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-bad">{error}</p>}
    </Panel>
  );
}

function LimitsSection() {
  const limits = useLimits();
  const [adding, setAdding] = useState(false);
  return (
    <Panel id="limits" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader
        title="Usage limits"
        hint="You enter the cap and when it resets. We count the calls recorded here against it and warn you before you reach it. We cannot see your plan's own meter."
        actions={!adding && <Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add a usage limit</Button>}
      />
      {adding && (
        <div className="mt-4">
          <AddLimitForm onDone={() => setAdding(false)} />
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3">
        {limits.isPending ? (
          <Skeleton className="h-24" />
        ) : (limits.data ?? []).length === 0 ? (
          !adding && <EmptyState title="No usage limits yet" hint="Add one and we warn you before it runs out." />
        ) : (
          (limits.data ?? []).map((l) => <LimitCard key={l.limit_id} limit={l} />)
        )}
      </div>
    </Panel>
  );
}

/** GET /healthz and /healthz/scheduler: is the server up, and are its background jobs keeping up? */
function StatusSection() {
  const health = useHealth();
  const h = health.data;
  const late = Object.entries(h?.overdue ?? {});
  return (
    <Panel id="status" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="System status" hint="Checked every minute." />
      {health.isPending ? (
        <Skeleton className="mt-4 h-16" />
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          <li className="flex items-center justify-between gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-4">
            <span>
              <span className="block text-sm font-semibold text-ink">API and database</span>
              <span className="font-mono text-[11px] text-muted">GET /healthz</span>
            </span>
            <Pill tone={h?.api === "ok" ? "good" : "bad"}>{h?.api === "ok" ? "Working" : "Not answering"}</Pill>
          </li>
          <li className="flex items-center justify-between gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-4">
            <span>
              <span className="block text-sm font-semibold text-ink">Background checks</span>
              <span className="font-mono text-[11px] text-muted">GET /healthz/scheduler</span>
            </span>
            <Pill tone={h?.scheduler === "ok" ? "good" : h?.scheduler === "overdue" ? "bad" : "neutral"}>
              {h?.scheduler === "ok" ? "Keeping up" : h?.scheduler === "overdue" ? `${late.length} overdue` : "Unknown"}
            </Pill>
          </li>
        </ul>
      )}
      {late.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-dim">
          {late.map(([job, minutes]) => (
            <li key={job}>
              <span className="font-mono text-ink">{job}</span>: {minutes === null ? "has not succeeded since the scheduler started" : `last succeeded ${Math.round(minutes)} min ago`}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function Settings() {
  const { hash } = useLocation();
  const scope = useProjectScope();
  const navigate = useNavigate();
  const projectId = scope.mode === "owned" ? scope.id : "";
  const projectQuery = useProject(projectId || undefined);
  const project = projectQuery.data ?? null;
  const [active, setActive] = useState("project");

  useEffect(() => {
    if (hash) setTimeout(() => document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }, [hash]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-90px 0px -60% 0px" },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [project]);

  const ownsProject = Boolean(project);
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-dim">{project ? <>Name, keys, alerts, data retention and limits for <span className="text-ink [overflow-wrap:anywhere]">{project.name}</span>.</> : "Name, keys, alerts, data retention and limits for the project your key belongs to."}</p>
      </header>
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-24 flex flex-col gap-0.5">
            {SECTIONS.filter((s) => ownsProject || ["retests", "keys", "limits"].includes(s.id)).map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                  className={cx("block rounded-[9px] px-3 py-2 text-sm transition-colors", active === s.id ? "bg-surface-2 font-semibold text-ink" : "text-muted hover:text-dim")}
                >
                  {s.id === "budget" && project?.billing_mode === "subscription" ? "Your allowance" : s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-4">
          {projectQuery.isPending && projectId ? (
            <Skeleton className="h-40" />
          ) : project ? (
            <>
              <ProjectSection project={project} />
              <AlertsSection project={project} />
              <ModelNoticesSection project={project} />
              <AiSummariesSection project={project} />
              <AutoTrialsSection project={project} />
              <PrivacySection project={project} />
              <BillingSection project={project} />
              {project.billing_mode === "subscription" ? <SubscriptionLimitPointer /> : <><BudgetSection project={project} /><BudgetAlertsSection project={project} /></>}
              <ToolInputsSection project={project} />
            </>
          ) : (
            <Panel className="p-5">
              <p className="flex flex-wrap items-center gap-2 text-sm text-dim">
                {scope.mode === "demo" ? (
                  <><Pill tone="info">Public demo</Pill> This is a read-only demo. Sign in to make your own project.</>
                ) : (
                  <><Pill tone="info">Using a project key</Pill> Sign in as the project's owner to change its name, alerts and data retention, or to delete it.</>
                )}
              </p>
            </Panel>
          )}
          <RetestsSection key={project?.project_id ?? "none"} project={project} />
          <KeysSection project={project} mode={scope.mode} />
          <LimitsSection />
          <StatusSection />
          {project && (
            <div id="danger" className="scroll-mt-24">
              <DeleteProjectCard projectId={project.project_id} projectSlug={project.slug} projectName={project.name} onDeleted={() => navigate("/projects", { replace: true })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
