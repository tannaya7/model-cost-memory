/** One company the person belongs to: its people, invites, and leaving. Personal projects are never touched here. */
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../shared/api/apiFetch";
import type { CompanyRole } from "../shared/api/types";
import { useMe } from "../features/auth/hooks/useAuth";
import { PrivacyNotice, RoleRollup, YourJobRole } from "../features/workspaces/components/PrivacyPanels";
import { useProjects } from "../features/projects/hooks/useProjects";
import { projectPath } from "../shared/projectPath";
import { useCompanyActions, useEvents, useInvites, useMembers, usePermissions, useWorkspaces } from "../features/workspaces/hooks/useWorkspaces";
import { Button, ErrorState, Panel, Pill, Skeleton } from "../ui/primitives";
import { InlineConfirm } from "../ui/InlineConfirm";
import { TypedConfirm } from "../ui/TypedConfirm";
import { ThemeToggle } from "../ui/ThemeToggle";

const ROLE_WORDS: Record<CompanyRole, string> = {
  owner: "Owner: everything, including admins and deleting the company",
  admin: "Admin: people, invites, settings, keys and trials",
  member: "Member: read prompts and answers, record and edit tasks",
  viewer: "Viewer: numbers only, no prompt or answer text",
};
const RANK: Record<CompanyRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const say = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong");

export default function Company() {
  const { orgId = "" } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const spaces = useWorkspaces();
  const space = spaces.data?.find((w) => w.org_id === orgId);
  const role = (space?.role ?? "viewer") as CompanyRole;
  const isAdmin = RANK[role] >= RANK.admin;
  const members = useMembers(orgId);
  const invites = useInvites(orgId, isAdmin);
  const events = useEvents(orgId, isAdmin);
  const perms = usePermissions();
  const act = useCompanyActions(orgId);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [link, setLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  // What is being confirmed in the page (never the browser's own pop-up): removing a person, leaving, or deleting the company.
  const [ask, setAsk] = useState<null | { kind: "remove"; userId: string; email: string } | { kind: "leave" } | { kind: "delete" }>(null);
  const projects = useProjects();
  const companyProjects = (projects.data ?? []).filter((p) => p.organisation_id === orgId);

  if (spaces.isPending) return <div role="status" aria-label="Loading" className="mx-auto max-w-3xl p-8"><Skeleton className="h-40 w-full" /></div>;
  if (!space) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-3 p-10 text-center">
        <h1 className="text-xl font-semibold">This company is not among yours</h1>
        <p className="text-sm text-dim">You may have left it, or it was deleted.</p>
        <Link to="/projects" className="text-sm font-semibold text-accent hover:underline">Your projects</Link>
      </main>
    );
  }

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
    } catch (e) {
      setMsg(say(e));
    }
  };
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const made = await act.invite.mutateAsync({ email: email.trim(), role: inviteRole });
      setLink(`${window.location.origin}${made.link}`);
      setEmail("");
    } catch (err) {
      setMsg(say(err));
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Link to="/projects" className="text-sm font-semibold text-accent hover:underline">All projects</Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">{space.name}</h1>
          <p className="mt-1 text-sm text-dim">Your role: {ROLE_WORDS[role]}. Your personal projects are not part of this company.</p>
          <Link to={`/company/${orgId}/overview`} className="mt-2 inline-block text-sm font-semibold text-accent hover:underline">Company overview: calls, tokens and cost</Link>
        </div>
        {msg && <p role="status" className="rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink">{msg}</p>}

        {ask?.kind === "remove" && (
          <InlineConfirm label={`Remove ${ask.email}`} confirmLabel="Remove" cancelLabel="Keep them" danger onCancel={() => setAsk(null)}
            onConfirm={() => { const who = ask; setAsk(null); void run(async () => { await act.remove.mutateAsync(who.userId); setRemoved(who.email); }, "Removed."); }}>
            {ask.email} will lose access to {space.name}&apos;s projects at once. They keep their own personal projects.
          </InlineConfirm>
        )}

        <PrivacyNotice orgId={orgId} />

        {removed && (
          <Panel className="p-4" aria-label="Rotate keys">
            <p className="text-sm font-semibold">{removed} can no longer open this company. A project key they saw still works until it is replaced.</p>
            {companyProjects.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-3 text-sm">
                {companyProjects.map((p) => (
                  <li key={p.project_id}><Link to={projectPath(p, "/settings")} className="font-semibold text-accent hover:underline">Replace the key for {p.name}</Link></li>
                ))}
              </ul>
            ) : <p className="mt-1 text-sm text-dim">This company has no projects, so there are no keys to replace.</p>}
          </Panel>
        )}

        <Panel className="p-5" aria-label="People">
          <h2 className="text-lg font-semibold">People</h2>
          {members.isPending ? <Skeleton className="mt-3 h-16 w-full" /> : members.isError ? <ErrorState error={members.error} onRetry={() => members.refetch()} /> : (
            <ul className="mt-3 divide-y divide-rule">
              {members.data.map((m) => {
                const mine = m.user_id === me.data?.user_id;
                const canTouch = isAdmin && !mine && (role === "owner" || RANK[m.role] < RANK.admin);
                return (
                  <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{m.name || m.email || "Member"}{mine && " (you)"}</p>
                      {m.email && <p className="truncate text-xs text-muted">{m.email}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {canTouch ? (
                        <>
                          <select aria-label={`Role for ${m.email}`} value={m.role} className="rounded-[10px] border border-rule bg-surface-2 px-2 py-1 text-sm"
                            onChange={(e) => run(() => act.role.mutateAsync({ userId: m.user_id, role: e.target.value as CompanyRole }), "Role changed.")}>
                            {(["viewer", "member", ...(role === "owner" ? ["admin", "owner"] : [])] as CompanyRole[]).map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <Button size="sm" variant="ghost" aria-label={`Remove ${m.email}`}
                            onClick={() => setAsk({ kind: "remove", userId: m.user_id, email: m.email ?? m.name ?? "this person" })}>Remove</Button>
                        </>
                      ) : <Pill tone="neutral" icon={false}>{m.role}</Pill>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {isAdmin && (
          <Panel className="p-5" aria-label="Invites">
            <h2 className="text-lg font-semibold">Invite someone</h2>
            <p className="mt-1 text-sm text-dim">No email is sent. You get a link to pass on. It works once, for that address only, for 7 days.</p>
            <form onSubmit={invite} className="mt-3 flex flex-wrap items-end gap-2">
              <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-semibold text-dim">Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm font-normal text-ink" />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-dim">Role
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "member" | "viewer")} className="rounded-[10px] border border-rule bg-surface-2 px-2 py-2 text-sm font-normal text-ink">
                  <option value="viewer">viewer</option><option value="member">member</option>{role === "owner" && <option value="admin">admin</option>}
                </select>
              </label>
              <Button type="submit" variant="primary" disabled={act.invite.isPending}>Make link</Button>
            </form>
            {link && (
              <div className="mt-3 rounded-[10px] border border-rule bg-surface-2 p-3 text-sm">
                <p className="font-semibold">Copy this link now. It is shown once.</p>
                <code className="mt-1 block break-all text-xs">{link}</code>
              </div>
            )}
            {invites.data && invites.data.length > 0 && (
              <ul className="mt-4 divide-y divide-rule text-sm">
                {invites.data.slice(0, 20).map((i) => (
                  <li key={i.invite_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0 truncate">{i.email} · {i.role} · {i.state}</span>
                    {i.state === "pending" && <Button size="sm" variant="ghost" aria-label={`Withdraw invite for ${i.email}`} onClick={() => run(() => act.withdraw.mutateAsync(i.invite_id), "Invite withdrawn.")}>Withdraw</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        {isAdmin && events.data && events.data.length > 0 && (
          <Panel className="p-5" aria-label="Audit trail">
            <h2 className="text-lg font-semibold">What happened here</h2>
            <p className="mt-1 text-sm text-dim">Who did what, newest first. Only labels are kept, never prompts, keys or settings values.</p>
            <ul className="mt-3 divide-y divide-rule text-sm">
              {events.data.slice(0, 25).map((e) => (
                <li key={e.event_id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0">{e.action.replaceAll("_", " ")}{e.actor && <span className="text-muted"> · by {e.actor}</span>}{e.target && <span className="text-muted"> · {e.target}</span>}</span>
                  <time dateTime={e.at} className="text-xs text-muted">{new Date(e.at).toLocaleString()}</time>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {perms.data && (
          <Panel className="p-5" aria-label="What each role can do">
            <details>
              <summary className="cursor-pointer text-lg font-semibold">What each role can do</summary>
              <p className="mt-2 text-sm text-dim">The server checks this on every request. A higher role has everything a lower one has.</p>
              {([["Projects", perms.data.project], ["The company", perms.data.company]] as const).map(([title, rows]) => (
                <div key={title} className="mt-4 overflow-x-auto" tabIndex={0} role="group" aria-label={`${title} permissions table`}>
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <caption className="pb-1 text-left text-sm font-semibold">{title}</caption>
                    <thead><tr className="text-xs text-muted"><th scope="col" className="py-1 pr-3 font-medium">Can</th>{perms.data.roles.map((r) => <th key={r} scope="col" className="px-2 py-1 text-center font-medium">{r}</th>)}</tr></thead>
                    <tbody className="divide-y divide-rule">
                      {rows.map((row) => (
                        <tr key={row.permission}>
                          <th scope="row" className="py-1.5 pr-3 text-left font-normal text-dim">{row.means}</th>
                          {perms.data.roles.map((r) => <td key={r} className="px-2 py-1.5 text-center">{row.roles.includes(r) ? <span aria-label="yes">✓</span> : <span aria-label="no" className="text-muted">–</span>}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </details>
          </Panel>
        )}

        <YourJobRole orgId={orgId} />
        {isAdmin && <RoleRollup orgId={orgId} />}

        <Panel className="p-5" aria-label="Leave or delete">
          <h2 className="text-lg font-semibold">Leave this company</h2>
          <p className="mt-1 text-sm text-dim">You lose access to its projects. Its projects stay with the company and your personal projects stay yours. Nothing is moved. The last owner cannot leave.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => setAsk({ kind: "leave" })}>Leave company</Button>
            {role === "owner" && <Button variant="danger" onClick={() => setAsk({ kind: "delete" })}>Delete company</Button>}
          </div>
          {ask?.kind === "leave" && (
            <InlineConfirm label={`Leave ${space.name}`} confirmLabel="Leave" cancelLabel="Stay" danger onCancel={() => setAsk(null)}
              onConfirm={() => { setAsk(null); void run(async () => { await act.leave.mutateAsync(); navigate("/projects"); }); }}>
              You will lose access to {space.name}&apos;s projects. They stay with the company, and your own personal projects stay yours.
            </InlineConfirm>
          )}
          {ask?.kind === "delete" && (
            <TypedConfirm label={`Delete ${space.name}`} expected={space.name} confirmLabel="Delete company" onCancel={() => setAsk(null)}
              onConfirm={(typed) => { setAsk(null); void run(async () => { await act.destroy.mutateAsync(typed); navigate("/projects"); }); }}>
              This deletes the company and removes everyone from it. It only works once the company has no projects: projects are never moved or deleted for you.
            </TypedConfirm>
          )}
          {role === "owner" && <p className="mt-2 text-xs text-muted">A company with projects cannot be deleted. Delete its projects first.</p>}
        </Panel>
      </main>
    </div>
  );
}
