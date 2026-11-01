import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAuthConfig, fetchMe, logout } from "../api/authApi";
import { setActiveProject } from "../../../shared/api/apiFetch";

export const meKey = ["auth", "me"] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: fetchMe,
    retry: false,
    // AppShell also calls useMe(); without this its mount refetches a failed /v1/me, which flips
    // RequireAuth back to its skeleton, unmounts the shell, and loops.
    retryOnMount: false,
    staleTime: 60_000,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      setActiveProject("");
      queryClient.clear();
    },
  });
}

export function useAuthConfig() {
  return useQuery({ queryKey: ["auth", "config"], queryFn: fetchAuthConfig, staleTime: 5 * 60_000, retry: false });
}
