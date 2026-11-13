/** Settings: one page, one section per decision, with a section menu beside it. */
import { useEffect, useState } from "react";
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
import { ApiError, getActiveProject } from "../shared/api/apiFetch";
import type { Project } from "../shared/api/types";
import { usd } from "../ui/format";
import { IconCheck } from "../ui/icons";
import { Button, cx, EmptyState, Panel, PanelHeader, Pill, Skeleton } from "../ui/primitives";

const SECTIONS = [
  { id: "project", label: "Project" },
  { id: "alerts", label: "Alerts" },
  { id: "privacy", label: "Data kept" },
  { id: "retests", label: "Re-tests" },
  { id: "keys", label: "API keys" },
  { id: "limits", label: "Usage limits" },
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
      <PanelHeader title="Project" hint={<>The project id the SDK sends runs to is <span className="font-mono text-ink">{project.project_id}</span>.</>} />
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
        <p className="mt-2 text-xs text-muted">
          Each message is signed: check the <span className="font-mono">X-MCM-Signature</span> header with the secret <span className="font-mono text-dim">{project.webhook_secret.slice(0, 6)}…</span>
        </p>
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
      <PanelHeader title="How long prompts and answers are kept" hint="After this many days a run's prompt, answer, tool calls and answer key are deleted each night. Pass or fail, cost and tokens stay, so recommendations do not change." />
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
      <PanelHeader title="Re-tests" hint="Re-tests replay your past prompts on another model, with your provider key, to collect evidence. They never spend past the monthly cap." />
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
            <span className="text-xs font-semibold text-dim">Monthly cap (USD)</span>
            <input type="number" min={0} max={10000} className={cx(field, "mt-1.5")} value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
          <label className="flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3">
            <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
            <span>
              <span className="block text-sm font-semibold text-ink">Allow re-tests</span>
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
      <PanelHeader title="API keys" hint="The SDK sends runs with the project key. It is shown once when made; only its first characters are stored for display." />
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

function LimitsSection() {
  const limits = useLimits();
  const [adding, setAdding] = useState(false);
  return (
    <Panel id="limits" className="scroll-mt-24 p-5 md:p-6">
      <PanelHeader
        title="Usage limits"
        hint="A plan's 5-hour or weekly limit, a per-model limit or an API budget. The system forecasts whether it runs out before it resets, and which cheaper option would stretch it."
        actions={!adding && <Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add a limit</Button>}
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
          !adding && <EmptyState title="No limit yet" hint="Add the limits your plan or budget sets, and see in advance when one will run out." />
        ) : (
          (limits.data ?? []).map((l) => <LimitCard key={l.limit_id} limit={l} />)
        )}
      </div>
    </Panel>
  );
}

export default function Settings() {
  const { hash } = useLocation();
  const projectId = getActiveProject();
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
            </>
          ) : (
            <Panel className="p-5">
              <p className="flex items-center gap-2 text-sm text-dim">
                <Pill tone="info">Using a project key</Pill> Sign in and pick a project to change its name, alerts and data retention.
              </p>
            </Panel>
          )}
          <RetestsSection key={project?.project_id ?? "none"} project={project} />
          <KeysSection project={project} />
          <LimitsSection />
          {project && (
            <div id="danger" className="scroll-mt-24">
              <DeleteProjectCard projectId={project.project_id} projectName={project.name} onDeleted={() => (window.location.href = "/projects")} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
