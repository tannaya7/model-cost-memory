import { apiFetch } from "../../../shared/api/apiFetch";
import type {
  Project,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectKeyResult,
  ProjectPatchInput,
} from "../../../shared/api/types";

export function fetchProjects(): Promise<Project[]> {
  return apiFetch<Project[]>("/v1/projects");
}

export function fetchProject(id: string): Promise<Project> {
  return apiFetch<Project>(`/v1/projects/${encodeURIComponent(id)}`);
}

export function createProject(
  input: ProjectCreateInput,
): Promise<ProjectCreateResult> {
  return apiFetch<ProjectCreateResult>("/v1/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchProject(
  id: string,
  input: ProjectPatchInput,
): Promise<Project> {
  return apiFetch<Project>(`/v1/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function regenerateProjectKey(id: string): Promise<ProjectKeyResult> {
  return apiFetch<ProjectKeyResult>(
    `/v1/projects/${encodeURIComponent(id)}/key`,
    {
      method: "POST",
    },
  );
}
