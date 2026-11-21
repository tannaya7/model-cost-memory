import { useMutation } from "@tanstack/react-query";
import { useProject as useScope } from "../../../app/project";
import { deleteToolInputs } from "../api/projectsApi";
import { useProject } from "./useProjects";

/** Whether the signed-in owner's project keeps the inputs of tool calls (off unless they switched it on). */
export function useToolInputsSwitch() {
  const scope = useScope();
  const owned = scope.mode === "owned" ? scope.id : "";
  const query = useProject(owned || undefined);
  return { canEdit: Boolean(owned), on: query.data?.store_tool_arguments === true, ready: !owned || !query.isPending };
}

export function useDeleteToolInputs() {
  return useMutation({ mutationFn: (id: string) => deleteToolInputs(id) });
}
