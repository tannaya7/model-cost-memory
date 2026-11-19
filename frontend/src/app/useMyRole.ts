/** The signed-in person's role in the project on screen. Used only to leave out controls they could not use anyway:
 *  the server checks the role on every request, so hiding a link here is a courtesy, not the protection. */
import { useProjects } from "../features/projects/hooks/useProjects";
import type { CompanyRole } from "../shared/api/types";
import { useProject } from "./project";

export function useMyRole(): CompanyRole {
  const { id, mode } = useProject();
  const projects = useProjects(mode === "owned");
  return projects.data?.find((p) => p.project_id === id)?.role ?? "owner";
}

/** Admins and owners manage settings, keys, limits and re-tests; everyone below only reads or records. */
export const canAdminister = (role: CompanyRole) => role === "admin" || role === "owner";
