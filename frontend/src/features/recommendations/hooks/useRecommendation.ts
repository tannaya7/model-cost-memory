import { useQuery } from "@tanstack/react-query";
import { fetchRecommendation } from "../api/recommendationsApi";

export function useRecommendation(jobName: string | undefined) {
  return useQuery({
    queryKey: ["recommendation", jobName],
    queryFn: () => (jobName ? fetchRecommendation(jobName) : Promise.reject(new Error("No job name provided"))),
    enabled: Boolean(jobName),
  });
}
