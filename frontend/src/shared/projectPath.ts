/** The one place that builds a project's web address. People see /p/production, never the long project id.
 *  The id still goes in request headers and API paths; only the browser address uses the short name. */

/** Anything that names a project: a server project, or a bare address name such as "demo" or "key". */
export type ProjectLike = string | { slug?: string | null; project_id: string };

/** The address segment for a project: its short name, or the id when an older server sent no short name. */
export function projectRef(project: ProjectLike): string {
  return typeof project === "string" ? project : project.slug || project.project_id;
}

/** projectPath(project, "/jobs") is "/p/production/jobs"; projectPath(project) is "/p/production". */
export function projectPath(project: ProjectLike, path = "/"): string {
  return `/p/${encodeURIComponent(projectRef(project))}${path === "/" ? "" : path}`;
}

/** Finds a signed-in person's project from an address segment: the short name, or (old links) the id. */
export function findProject<T extends { slug?: string | null; project_id: string }>(
  projects: readonly T[],
  ref: string,
): T | undefined {
  return projects.find((p) => p.slug === ref) ?? projects.find((p) => p.project_id === ref);
}
