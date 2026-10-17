import { useQuery } from "@tanstack/react-query";
import { fetchJobRegressions } from "../api/recommendationsApi";

export function useJobRegressions(jobName: string | undefined) {
  return useQuery({
    queryKey: ["regressions", jobName],
    queryFn: () => (jobName ? fetchJobRegressions(jobName) : Promise.resolve([])),
    enabled: Boolean(jobName),
  });
}
