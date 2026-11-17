import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteTaskSummary, fetchJobs, fetchTaskProfile, setTaskSummaryConsent, updateJobDescription } from "../api/jobsApi";

export const jobsKey = ["jobs"] as const;

export function useJobs() {
  return useQuery({ queryKey: jobsKey, queryFn: fetchJobs });
}

export function useUpdateJobDescription(name: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (description: string | null) => updateJobDescription(name, description),
    onSuccess: () => client.invalidateQueries({ queryKey: jobsKey }),
  });
}

export const profileKey = (name: string) => ["jobs", "profile", name] as const;

/** The task's measured facts and AI-summary state. While a summary is being written it asks again every few seconds. */
export function useTaskProfile(name: string) {
  return useQuery({
    queryKey: profileKey(name),
    queryFn: () => fetchTaskProfile(name),
    refetchInterval: (q) => (q.state.data?.summary?.state === "pending" ? 4000 : false),
  });
}

export function useTaskSummaryConsent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: setTaskSummaryConsent,
    onSuccess: () => client.invalidateQueries({ queryKey: ["jobs", "profile"] }),
  });
}

export function useDeleteTaskSummary(name: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => deleteTaskSummary(name),
    onSuccess: () => client.invalidateQueries({ queryKey: profileKey(name) }),
  });
}
