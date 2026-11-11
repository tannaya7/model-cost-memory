import { useQuery } from "@tanstack/react-query";
import { fetchJobs } from "../api/jobsApi";

export const jobsKey = ["jobs"] as const;

export function useJobs() {
  return useQuery({ queryKey: jobsKey, queryFn: fetchJobs });
}
