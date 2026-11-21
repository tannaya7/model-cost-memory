import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/workspacesApi";
import type { CompanyRole } from "../../../shared/api/types";

export const workspacesKey = ["workspaces"] as const;
const membersKey = (id: string) => ["workspaces", id, "members"] as const;
const invitesKey = (id: string) => ["workspaces", id, "invites"] as const;

export function useWorkspaces(enabled = true) {
  return useQuery({ queryKey: workspacesKey, queryFn: api.fetchWorkspaces, enabled, retry: false });
}
export const useMembers = (id: string) => useQuery({ queryKey: membersKey(id), queryFn: () => api.fetchMembers(id), retry: false });
export const useInvites = (id: string, enabled: boolean) =>
  useQuery({ queryKey: invitesKey(id), queryFn: () => api.fetchInvites(id), enabled, retry: false });

/** Everything a company change can affect is refetched, so the screen never shows a stale role or list. */
export function useCompanyActions(id: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: workspacesKey });
    void qc.invalidateQueries({ queryKey: ["projects"] });
  };
  return {
    role: useMutation({ mutationFn: (v: { userId: string; role: CompanyRole }) => api.changeRole(id, v.userId, v.role), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (userId: string) => api.removeMember(id, userId), onSuccess: refresh }),
    leave: useMutation({ mutationFn: () => api.leaveCompany(id), onSuccess: refresh }),
    destroy: useMutation({ mutationFn: (name: string) => api.deleteCompany(id, name), onSuccess: refresh }),
    invite: useMutation({
      mutationFn: (v: { email: string; role: "admin" | "member" | "viewer" }) => api.createInvite(id, v.email, v.role),
      onSuccess: () => void qc.invalidateQueries({ queryKey: invitesKey(id) }),
    }),
    withdraw: useMutation({ mutationFn: (inviteId: string) => api.withdrawInvite(id, inviteId), onSuccess: () => void qc.invalidateQueries({ queryKey: invitesKey(id) }) }),
  };
}

export function useCreateCompany() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.createCompany, onSuccess: () => void qc.invalidateQueries({ queryKey: workspacesKey }) });
}
export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.acceptInvite, onSuccess: () => { void qc.invalidateQueries({ queryKey: workspacesKey }); void qc.invalidateQueries({ queryKey: ["projects"] }); } });
}

export const useEvents = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ["workspaces", id, "events"], queryFn: () => api.fetchEvents(id), enabled, retry: false });
export const usePermissions = () => useQuery({ queryKey: ["permissions"], queryFn: api.fetchPermissions, retry: false, staleTime: Infinity });

export const useNotice = (id: string) => useQuery({ queryKey: ["workspaces", id, "notice"], queryFn: () => api.fetchNotice(id), retry: false });
export const useYou = (id: string) => useQuery({ queryKey: ["workspaces", id, "me"], queryFn: () => api.fetchYou(id), retry: false });
export const useRollups = (id: string, enabled: boolean) =>
  useQuery({ queryKey: ["workspaces", id, "rollups"], queryFn: () => api.fetchRollups(id), enabled, retry: false });
export function usePrivacyActions(id: string) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["workspaces", id] });
  return {
    acknowledge: useMutation({ mutationFn: (version: string) => api.acknowledgeNotice(id, version), onSuccess: refresh }),
    jobRole: useMutation({ mutationFn: (role: string | null) => api.putJobRole(id, role), onSuccess: refresh }),
  };
}
