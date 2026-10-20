import { useQuery } from "@tanstack/react-query";
import { fetchJobHistory } from "../api/recommendationsApi";

export function useJobHistory(jobName: string | undefined) {
  return useQuery({
    queryKey: ["history", jobName],
    queryFn: () =>
      jobName ? fetchJobHistory(jobName) : Promise.reject(new Error("No job name provided")),
    enabled: Boolean(jobName),
  });
}
