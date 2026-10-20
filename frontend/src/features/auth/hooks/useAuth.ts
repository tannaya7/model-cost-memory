import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMe, logout } from "../api/authApi";

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
      queryClient.clear();
    },
  });
}
