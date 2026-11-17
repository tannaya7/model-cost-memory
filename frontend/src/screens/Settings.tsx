/** Settings: one page, one section per decision, with a section menu beside it. */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AddLimitForm } from "../features/limits/components/AddLimitForm";
import { LimitCard } from "../features/limits/components/LimitCard";
import { useLimits } from "../features/limits/hooks/useLimits";
import { ApiKeyRevealBox } from "../features/projects/components/ApiKeyRevealBox";
import { DeleteProjectCard } from "../features/projects/components/DeleteProjectCard";
import { parseBudget } from "../features/projects/hooks/useBudget";
import { usePatchProject, useProject, useRegenerateProjectKey } from "../features/projects/hooks/useProjects";
import { ProviderKeyForm } from "../features/retest/components/ProviderKeyForm";
import { useDeleteProviderKey, useRetestLimits } from "../features/retest/hooks/useRetest";
import { ProjectKeySettings } from "../features/settings/components/ProjectKeySettings";
import { ApiError } from "../shared/api/apiFetch";
import { useProject as useProjectScope } from "../app/project";
import { useNavigate } from "react-router-dom";
import type { Project } from "../shared/api/types";
import { useHealth } from "../features/health/api";
import { useDeleteToolInputs } from "../features/projects/hooks/useToolInputs";
import { Help } from "../ui/Help";
import { usd } from "../ui/format";
import { IconCheck } from "../ui/icons";
import { Button, cx, EmptyState, Panel, PanelHeader, Pill, Skeleton } from "../ui/primitives";

const SECTIONS = [
  { id: "project", label: "Project" },
  { id: "alerts", label: "Alerts" },
  { id: "privacy", label: "Data kept" },
  { id: "retests", label: "Model trials" },
  { id: "keys", label: "API keys" },
  { id: "budget", label: "Spending limit" },
  { id: "tool-inputs", label: "Tool inputs" },
  { id: "limits", label: "Usage limits" },
  { id: "status", label: "System status" },
  { id: "danger", label: "Delete" },
];

const field =
  "w-full rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-accent";

function SaveRow({ saving, saved, error, dirty, onSave }: { saving: boolean; saved: boolean; error: string | null; dirty: boolean; onSave: () => void }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
      {error && <p className="text-xs text-bad">{error}</p>}
      {saved && <span className="flex items-center gap-1 text-xs text-ok"><IconCheck size={14} /> Saved</span>}
      <Button variant="primary" size="sm" onClick={onSave} disabled={saving || !dirty}>{saving ? "Saving…" : "Save"}</Button>
    </div>
  );
}

/** One form row of the project: edits a single field and saves it on its own. */
function useFieldSave(project: Project) {
  const patch = usePatchProject();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (input: Parameters<typeof patch.mutateAsync>[0]["input"]) => {
    setError(null);
    setSaved(false);
    try {
      await patch.mutateAsync({ id: project.project_id, input });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not save");
    }
  };
  return { save, saving: patch.isPending, saved, error };
}

function ProjectSection({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);
  const s = useFieldSave(project);
  return (
    <Panel id="project" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Project" hint={<>Your app's SDK sends its AI calls to this project id: <span className="font-mono text-ink">{project.project_id}</span>.</>} />
      <label htmlFor="project-name" className="mt-4 block text-xs font-semibold text-dim">Name</label>
      <input id="project-name" className={cx(field, "mt-1.5 max-w-md")} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      <SaveRow saving={s.saving} saved={s.saved} error={s.error} dirty={name.trim() !== project.name && name.trim().length > 0} onSave={() => s.save({ name: name.trim() })} />
    </Panel>
  );
}

function AlertsSection({ project }: { project: Project }) {
  const [url, setUrl] = useState(project.webhook_url ?? "");
  const s = useFieldSave(project);
  return (
    <Panel id="alerts" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Where alerts go" hint="Paste a Slack, Discord, Google Chat or Mattermost incoming webhook, or your own https endpoint. Leave empty to see alerts here only." />
      <label htmlFor="webhook" className="mt-4 block text-xs font-semibold text-dim">Webhook URL</label>
      <input id="webhook" type="url" className={cx(field, "mt-1.5")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />
      {project.webhook_secret && (
        <div className="mt-2 space-y-1 text-xs text-muted">
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
      )}
      <SaveRow
        saving={s.saving}
        saved={s.saved}
        error={s.error}
        dirty={url.trim() !== (project.webhook_url ?? "")}
        onSave={() => {
          if (url.trim() && !url.trim().startsWith("https://")) return;
          void s.save({ webhook_url: url.trim() || null });
        }}
      />
    </Panel>
  );
}

function PrivacySection({ project }: { project: Project }) {
  const [days, setDays] = useState(String(project.content_retention_days));
  const s = useFieldSave(project);
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 3650;
  return (
    <Panel id="privacy" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="How long prompts and answers are kept" hint="After this many days, the text of each AI call (its prompt, answer, tool calls and answer key) is deleted each night. Whether it was correct, what it cost and how many tokens it used are kept, so our recommendations do not change. Tokens are the small pieces of text AI models are billed by." />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input id="retention" type="number" min={1} max={3650} className={cx(field, "w-28")} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days to keep run content" />
        <span className="text-sm text-dim">days</span>
        {[30, 90, 365].map((d) => (
          <button key={d} type="button" onClick={() => setDays(String(d))} className={cx("rounded-full border px-3 py-1 text-xs font-semibold", Number(days) === d ? "border-accent text-accent" : "border-rule text-muted hover:text-dim")}>
            {d}
          </button>
        ))}
      </div>
      {!valid && <p className="mt-2 text-xs text-bad">Between 1 and 3650 days.</p>}
      <SaveRow saving={s.saving} saved={s.saved} error={s.error} dirty={valid && n !== project.content_retention_days} onSave={() => s.save({ content_retention_days: n })} />
    </Panel>
  );
}

function RetestsSection({ project }: { project: Project | null }) {
  const limits = useRetestLimits();
  const removeKey = useDeleteProviderKey();
  const [cap, setCap] = useState(project ? String(project.retest_monthly_cap_usd) : "");
  const [allowed, setAllowed] = useState(project?.retest_allowed ?? true);
  const [editingKey, setEditingKey] = useState(false);
  const s = useFieldSave(project ?? ({ project_id: "" } as Project));
  const l = limits.data;
  const share = l && l.monthly_cap_usd > 0 ? Math.min(1, l.spent_this_month_usd / l.monthly_cap_usd) : 0;
  return (
    <Panel id="retests" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Trials on a new model" hint="A trial replays your past prompts on another model, using your provider key, to see if it does as well as the one you use now. It never spends more than the monthly budget you set here." />
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
            <input type="number" min={0} max={10000} className={cx(field, "mt-1.5")} value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
          <label className="flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
            <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
            <span>
              <span className="block text-sm font-semibold text-ink">Allow trials on new models</span>
              <span className="text-xs text-dim">Past prompts are sent to the provider of the model being tested.</span>
            </span>
          </label>
        </div>
      )}
      {project && (
        <SaveRow
          saving={s.saving}
          saved={s.saved}
          error={s.error}
          dirty={Number(cap) !== project.retest_monthly_cap_usd || allowed !== project.retest_allowed}
          onSave={() => s.save({ retest_monthly_cap_usd: Number(cap), retest_allowed: allowed })}
        />
      )}
      <div className="mt-5 border-t border-rule pt-5">
        <p className="text-sm font-semibold text-ink">Provider key</p>
        {limits.isPending ? (
          <Skeleton className="mt-3 h-12" />
        ) : l?.provider_key && !editingKey ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
            <span className="text-sm text-dim">
              <span className="font-semibold text-ink">{l.provider_key.provider}</span> key ending <span className="font-mono text-ink">…{l.provider_key.key_hint}</span>
            </span>
            <span className="flex gap-2">
              <Button size="sm" onClick={() => setEditingKey(true)}>Replace</Button>
              <Button size="sm" variant="ghost" onClick={() => removeKey.mutate()} disabled={removeKey.isPending}>Remove</Button>
            </span>
          </div>
        ) : (
          <div className="mt-3">
            <ProviderKeyForm onSaved={() => setEditingKey(false)} />
          </div>
        )}
      </div>
    </Panel>
  );
}

function KeysSection({ project }: { project: Project | null }) {
  const regenerate = useRegenerateProjectKey();
  const [fresh, setFresh] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <Panel id="keys" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="API keys" hint="Your app's SDK identifies itself with the project key when it sends AI calls. It is shown once when made; only its first characters are stored for display." />
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
      <div className="mt-5 border-t border-rule pt-5">
        <ProjectKeySettings />
      </div>
    </Panel>
  );
}

/** The most the person wants their AI calls to cost each month; we only warn, never block. */
export function BudgetSection({ project }: { project: Project }) {
  const current = project.monthly_budget_usd ?? null;
  const [text, setText] = useState(current === null ? "" : String(current));
  const [problem, setProblem] = useState<string | null>(null);
  const s = useFieldSave(project);
  const onSave = async () => {
    const r = parseBudget(text);
    if ("error" in r) return setProblem(r.error);
    setProblem(null);
    await s.save({ monthly_budget_usd: r.value });
  };
  const onRemove = async () => {
    setProblem(null);
    await s.save({ monthly_budget_usd: null });
    setText("");
  };
  return (
    <Panel id="budget" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader title="Monthly spending limit" hint="Set the most you want your app's AI calls to cost each month. We warn you at 85% and 95%, and if the month looks like it will go over. We only warn: nothing is ever blocked." />
      <p className="mt-3 text-sm text-ink">Current limit: <span className="font-semibold">{current === null ? "Not set" : `$${current.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(current) ? 0 : 2 })} a month`}</span></p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="flex items-center rounded-[10px] border border-rule bg-surface-2 px-3 focus-within:border-accent">
          <span className="text-sm text-muted">$</span>
          <input id="monthly-budget" inputMode="decimal" className="w-32 bg-transparent px-1.5 py-2 text-sm text-ink outline-none placeholder:text-muted" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 500" aria-label="Monthly spending limit in US dollars" />
        </span>
        <span className="text-sm text-dim">a month</span>
        <Button variant="primary" size="sm" onClick={onSave} disabled={s.saving}>{s.saving ? "Saving…" : "Save"}</Button>
        {current !== null && <Button variant="ghost" size="sm" onClick={onRemove} disabled={s.saving}>Remove</Button>}
        {s.saved && <span className="flex items-center gap-1 text-xs text-ok"><IconCheck size={14} /> Saved</span>}
      </div>
      {(problem || s.error) && <p role="alert" className="mt-2 text-xs text-bad">{problem ?? s.error}</p>}
      <p className="mt-3 text-xs text-muted">The spend is an estimate from your recorded calls at list prices.</p>
    </Panel>
  );
}

/** Off by default. When on, the project keeps the inputs of tool calls, only to spot an agent repeating a step. */
export function ToolInputsSection({ project }: { project: Project }) {
  const on = project.store_tool_arguments === true;
  const patch = usePatchProject();
  const wipe = useDeleteToolInputs();
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const toggle = async (next: boolean) => {
    setError(null);
    try {
      await patch.mutateAsync({ id: project.project_id, input: { store_tool_arguments: next } });
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not save");
    }
  };
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
        title={<span className="inline-flex items-center gap-1.5">Keep the inputs of tool calls so loops are easier to spot <Help label="About tool inputs">When your agent calls a tool, the call has inputs, like the search words it used. With this on, your app can send them to us. We compare them only to notice when an agent repeats the same step. They are never used to train anything, and they are deleted with the rest of the run text after your retention period.</Help></span>}
        hint="Your app can send the inputs of each tool call. We use them only to notice when an agent repeats the same step. This helps catch loops that the default check misses."
      />
      <p role="note" className="mt-3 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-[13px] text-ink">
        <span className="font-semibold">Warning:</span> tool inputs may contain private data, such as customer names, file contents or secrets. Leave this off unless you are comfortable with that being stored.
      </p>
      <label className="mt-3 flex items-center gap-3 text-sm text-ink">
        <input type="checkbox" role="switch" className="h-4 w-4" checked={on} disabled={patch.isPending} onChange={(e) => void toggle(e.target.checked)} aria-label="Keep the inputs of tool calls so loops are easier to spot" />
        <span>{patch.isPending ? "Saving…" : on ? "On: new tool inputs are stored" : "Off: tool inputs are not stored"}</span>
      </label>
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
        hint="A usage limit is a cap you or your provider set, so a mistake cannot run up a huge bill, for example a plan's 5-hour or weekly limit, a limit on one model, or an API budget. We estimate whether you will hit it before it resets, and which cheaper option would make it last."
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
          !adding && <EmptyState title="No usage limits yet" hint="A limit is a cap on how much AI you may use, set by your plan or your budget. Add one and we will warn you before it runs out." />
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
      <PanelHeader title="System status" hint="Checked every minute, so you can tell if the service is running normally. If something shows as not working, wait a minute and refresh." />
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
        <p className="mt-1 text-sm text-dim">{project ? <>For <span className="text-ink">{project.name}</span>.</> : "For the project your key belongs to."}</p>
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
                  {s.label}
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
              <PrivacySection project={project} />
              <BudgetSection project={project} />
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
          <KeysSection project={project} />
          <LimitsSection />
          <StatusSection />
          {project && (
            <div id="danger" className="scroll-mt-24">
              <DeleteProjectCard projectId={project.project_id} projectName={project.name} onDeleted={() => navigate("/projects", { replace: true })} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
