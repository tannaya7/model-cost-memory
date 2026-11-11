import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UsageLimitInput } from "../../../shared/api/types";
import { createLimit, deleteLimit, fetchLimits, reportLimitUsed } from "../api/limitsApi";

export const limitsKey = ["limits"] as const;

/** Refreshed every minute: the pace and the time to the reset move on their own. */
export function useLimits() {
  return useQuery({ queryKey: limitsKey, queryFn: fetchLimits, refetchInterval: 60_000 });
}

function useLimitMutation<T>(fn: (arg: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: limitsKey });
    },
  });
}

export function useCreateLimit() {
  return useLimitMutation((input: UsageLimitInput) => createLimit(input));
}

export function useReportLimitUsed() {
  return useLimitMutation(({ limitId, usedPercent }: { limitId: string; usedPercent: number }) =>
    reportLimitUsed(limitId, usedPercent),
  );
}

export function useDeleteLimit() {
  return useLimitMutation((limitId: string) => deleteLimit(limitId));
}
