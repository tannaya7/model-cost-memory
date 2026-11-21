/** What this company's account records and who sees it, the person's own optional job role, and (admins) the rollup. */
import { ApiError } from "../../../shared/api/apiFetch";
import { Button, Panel, Pill } from "../../../ui/primitives";
import { useNotice, usePrivacyActions, useRollups, useYou } from "../hooks/useWorkspaces";

const say = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong");

export function PrivacyNotice({ orgId }: { orgId: string }) {
  const notice = useNotice(orgId);
  const act = usePrivacyActions(orgId);
  if (!notice.data || !Array.isArray(notice.data.sections)) return null;
  const n = notice.data;
  return (
    <Panel className="p-5" aria-label="Privacy notice">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">What this account records and who sees it</h2>
        {n.acknowledged ? (
          <Pill tone="good" icon={false}>You were shown this{n.acknowledged_at ? ` on ${new Date(n.acknowledged_at).toLocaleDateString()}` : ""}</Pill>
        ) : (
          <Pill tone="neutral" icon={false}>Not yet acknowledged</Pill>
        )}
      </div>
      <details className="mt-2" open={!n.acknowledged}>
        <summary className="cursor-pointer text-sm font-semibold text-accent">Read the notice</summary>
        <div className="mt-3 flex flex-col gap-4">
          {n.sections.map((s) => (
            <section key={s.heading}>
              <h3 className="text-sm font-semibold">{s.heading}</h3>
              {s.body.map((b) => <p key={b} className="mt-1 text-sm text-dim">{b}</p>)}
            </section>
          ))}
        </div>
      </details>
      {!n.acknowledged && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => act.acknowledge.mutate(n.version)} disabled={act.acknowledge.isPending}>I have read this</Button>
          <span className="text-xs text-muted">This records that the notice was shown to you. It is not a consent, and nothing depends on it.</span>
        </div>
      )}
      {act.acknowledge.isError && <p role="alert" className="mt-2 text-sm text-bad">{say(act.acknowledge.error)}</p>}
      {n.status_counts && (
        <p className="mt-3 text-xs text-muted">{n.status_counts.acknowledged} of {n.status_counts.members} members have acknowledged this version. Counts only, never names.</p>
      )}
    </Panel>
  );
}

export function YourJobRole({ orgId }: { orgId: string }) {
  const you = useYou(orgId);
  const notice = useNotice(orgId);
  const act = usePrivacyActions(orgId);
  if (!you.data || !you.data.job_roles) return null;
  const min = notice.data?.min_group_size ?? 5;
  return (
    <Panel className="p-5" aria-label="Your job role">
      <h2 className="text-lg font-semibold">Your job role (optional)</h2>
      <p className="mt-1 text-sm text-dim">
        Only you can set this. It is not guessed, not shown next to your name, and never used for access, budgets or judging anyone.
        Admins only see how many people chose each role, in groups of {min} or more.
      </p>
      <label className="mt-3 flex max-w-xs flex-col gap-1 text-sm font-semibold text-dim">What kind of work do you do?
        <select
          value={you.data.job_role ?? ""}
          onChange={(e) => act.jobRole.mutate(e.target.value || null)}
          disabled={act.jobRole.isPending}
          className="rounded-[10px] border border-rule bg-surface-2 px-2 py-2 text-sm font-normal text-ink"
        >
          <option value="">Prefer not to say</option>
          {Object.entries(you.data.job_roles).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      {act.jobRole.isError && <p role="alert" className="mt-2 text-sm text-bad">{say(act.jobRole.error)}</p>}
    </Panel>
  );
}

export function RoleRollup({ orgId }: { orgId: string }) {
  const r = useRollups(orgId, true);
  if (!r.data || !Array.isArray(r.data.groups)) return null;
  const d = r.data;
  return (
    <Panel className="p-5" aria-label="Job role groups">
      <h2 className="text-lg font-semibold">Job roles chosen by members</h2>
      <p className="mt-1 text-sm text-dim">{d.reason}</p>
      {d.shown && (
        <ul className="mt-3 divide-y divide-rule text-sm">
          {d.groups.map((g) => (
            <li key={g.job_role} className="flex justify-between py-1.5"><span>{g.label}</span><span className="tabular">{g.members} members</span></li>
          ))}
          <li className="flex justify-between py-1.5 text-dim"><span>Everyone else (small groups, or no role chosen)</span><span className="tabular">{d.not_shown} members</span></li>
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">{d.usage_by_role_note}</p>
    </Panel>
  );
}
