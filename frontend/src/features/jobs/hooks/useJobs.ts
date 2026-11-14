import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJobs, updateJobDescription } from "../api/jobsApi";

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
