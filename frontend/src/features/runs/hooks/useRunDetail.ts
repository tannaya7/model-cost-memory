import { useQuery } from "@tanstack/react-query";
import { fetchRunDetail } from "../api/runsApi";

export function useRunDetail(runId: string | null) {
  return useQuery({
    queryKey: ["runs", "detail", runId],
    queryFn: () => (runId ? fetchRunDetail(runId) : null),
    enabled: Boolean(runId),
  });
}
