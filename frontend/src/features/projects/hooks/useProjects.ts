import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectCreateInput,
  ProjectPatchInput,
} from "../../../shared/api/types";
import {
  createProject,
  fetchProject,
  fetchProjects,
  patchProject,
  regenerateProjectKey,
} from "../api/projectsApi";

export const projectsKey = ["projects"] as const;
export const projectDetailKey = (id: string) => ["projects", id] as const;

export function useProjects() {
  return useQuery({
    queryKey: projectsKey,
    queryFn: fetchProjects,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: projectDetailKey(id || ""),
    queryFn: () => fetchProject(id || ""),
    enabled: Boolean(id),
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ProjectCreateInput) => createProject(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
}

export function usePatchProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProjectPatchInput }) =>
      patchProject(id, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: projectsKey });
      void queryClient.invalidateQueries({
        queryKey: projectDetailKey(variables.id),
      });
    },
  });
}

export function useRegenerateProjectKey() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => regenerateProjectKey(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: projectsKey });
      void queryClient.invalidateQueries({ queryKey: projectDetailKey(id) });
    },
  });
}
