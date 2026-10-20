import { useMutation, useQueryClient } from "@tanstack/react-query";
import { labelRun } from "../api/runsApi";
import type { LabelCreate } from "../../../shared/api/types";

export function useLabelRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: LabelCreate) => labelRun(runId, label),
    // A label changes the run's outcome and state, so the runs list, this run's detail
    // and the per-job state counts are all out of date.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}
