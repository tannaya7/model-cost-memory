import { apiFetch } from "../../../shared/api/apiFetch";
import type { CompanyEvent, CompanyNotice, CompanyRole, RollupResult, YouInCompany, Invite, InviteCreated, Member, PermissionMatrix, Project, Workspace } from "../../../shared/api/types";

const org = (id: string) => `/v1/organisations/${encodeURIComponent(id)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const fetchWorkspaces = () => apiFetch<Workspace[]>("/v1/workspaces");
export const createCompany = (name: string) => apiFetch<{ org_id: string; name: string; role: CompanyRole }>("/v1/organisations", json("POST", { name }));
export const fetchMembers = (id: string) => apiFetch<Member[]>(`${org(id)}/members`);
export const changeRole = (id: string, userId: string, role: CompanyRole) => apiFetch<Member>(`${org(id)}/members/${encodeURIComponent(userId)}`, json("PATCH", { role }));
export const removeMember = (id: string, userId: string) => apiFetch<null>(`${org(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
export const leaveCompany = (id: string) => apiFetch<null>(`${org(id)}/leave`, { method: "POST" });
export const deleteCompany = (id: string, name: string) => apiFetch<null>(`${org(id)}?confirm=${encodeURIComponent(name)}`, { method: "DELETE" });
export const fetchInvites = (id: string) => apiFetch<Invite[]>(`${org(id)}/invites`);
export const createInvite = (id: string, email: string, role: "admin" | "member" | "viewer") => apiFetch<InviteCreated>(`${org(id)}/invites`, json("POST", { email, role }));
export const withdrawInvite = (id: string, inviteId: string) => apiFetch<null>(`${org(id)}/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
export const acceptInvite = (token: string) => apiFetch<Workspace>("/v1/invites/accept", json("POST", { token }));
export const deleteAccount = (email: string) => apiFetch<null>(`/v1/me?confirm=${encodeURIComponent(email)}`, { method: "DELETE" });

/** Personal projects plus those of every company the person is in. A company list that cannot be read is left out,
 *  never an error: the personal workspace always loads. A short name used twice is replaced by the id in the address. */
export async function fetchAllProjects(): Promise<Project[]> {
  const personal = await apiFetch<Project[]>("/v1/projects");
  let companies: Workspace[] = [];
  try {
    const spaces = await fetchWorkspaces();
    companies = Array.isArray(spaces) ? spaces.filter((w) => w.kind === "company" && w.org_id) : [];
  } catch {
    companies = [];
  }
  const more = await Promise.all(
    companies.map((c) => apiFetch<Project[]>(`/v1/projects?workspace=${encodeURIComponent(c.org_id as string)}`).catch(() => [] as Project[])),
  );
  const all = [...personal, ...more.flat()];
  const seen = new Map<string, number>();
  for (const p of all) seen.set(p.slug, (seen.get(p.slug) ?? 0) + 1);
  return all.map((p) => ((seen.get(p.slug) ?? 0) > 1 && p.organisation_id ? { ...p, slug: p.project_id } : p));
}

export const fetchEvents = (id: string) => apiFetch<CompanyEvent[]>(`${org(id)}/events`);
export const fetchPermissions = () => apiFetch<PermissionMatrix>("/v1/permissions");

export const fetchNotice = (id: string) => apiFetch<CompanyNotice>(`${org(id)}/notice`);
export const acknowledgeNotice = (id: string, version: string) => apiFetch<CompanyNotice>(`${org(id)}/notice/ack`, json("POST", { version }));
export const fetchYou = (id: string) => apiFetch<YouInCompany>(`${org(id)}/me`);
export const putJobRole = (id: string, jobRole: string | null) => apiFetch<YouInCompany>(`${org(id)}/me/job-role`, json("PUT", { job_role: jobRole }));
export const fetchRollups = (id: string) => apiFetch<RollupResult>(`${org(id)}/rollups`);
