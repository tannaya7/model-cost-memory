import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProviderKeyInput, RetestCreateInput } from "../../../shared/api/types";
import {
  deleteProviderKey,
  fetchJobRetests,
  fetchRetestLimits,
  fetchRetestStatus,
  saveProviderKey,
  startRetest,
} from "../api/retestApi";

export const retestLimitsKey = ["retest", "limits"] as const;

export function useRetestLimits() {
  return useQuery({
    queryKey: retestLimitsKey,
    queryFn: fetchRetestLimits,
  });
}

export function useStartRetest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      jobName,
      input,
    }: {
      jobName: string;
      input: RetestCreateInput;
    }) => startRetest(jobName, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: retestLimitsKey });
    },
  });
}

export const retestStatusKey = (jobName: string, retestId: string) =>
  ["retest", "status", jobName, retestId] as const;

export function useRetestStatus(jobName: string, retestId: string) {
  return useQuery({
    queryKey: retestStatusKey(jobName, retestId),
    queryFn: () => fetchRetestStatus(jobName, retestId),
    enabled: Boolean(jobName && retestId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "QUEUED" || status === "RUNNING") {
        return 2000;
      }
      return false;
    },
  });
}

export function useJobRetests(jobName: string | undefined) {
  return useQuery({
    queryKey: ["retest", "list", jobName],
    queryFn: () => fetchJobRetests(jobName!),
    enabled: Boolean(jobName),
  });
}

export function useSaveProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderKeyInput) => saveProviderKey(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: retestLimitsKey }),
  });
}

export function useDeleteProviderKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteProviderKey,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: retestLimitsKey }),
  });
}
