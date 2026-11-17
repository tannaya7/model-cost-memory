/** The project a screen belongs to comes from the address: /p/<project>/jobs. Two special ids:
 *  - "key":  the project a saved project key belongs to (no sign-in)
 *  - "demo": the server's public read-only demo
 * Every request then names the project (X-Project-Id), and the cached data of another project is dropped
 * when the project changes, so one project's numbers never show on another's page. */
import { createContext, useContext } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { useProject as useProjectDetail, useProjects } from "../features/projects/hooks/useProjects";
import { Link } from "react-router-dom";
import { findProject, projectPath } from "../shared/projectPath";
import { ApiError, getActiveProject, hasApiKey, setActiveProject } from "../shared/api/apiFetch";
import { queryClient } from "../shared/api/queryClient";
import { Skeleton } from "../ui/primitives";
import { Frame } from "./Frame";

export type ProjectMode = "owned" | "key" | "demo";

/** id is the real project id (headers, API); ref is the short name shown in the address. */
const ProjectContext = createContext<{ id: string; ref: string; mode: ProjectMode }>({ id: "", ref: "", mode: "owned" });

/** Puts a screen inside a project without the router (tests, previews). */
export function WithProject({ id, slug, children }: { id: string; slug?: string; children: React.ReactNode }) {
  return <ProjectContext.Provider value={{ id, ref: slug ?? id, mode: modeOf(id) }}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  return useContext(ProjectContext);
}

/** Links inside the current project: p("/jobs") is "/p/<project>/jobs", p("/") its overview. */
export function useP() {
  const { ref } = useContext(ProjectContext);
  return (path = "/") => projectPath(ref, path);
}

function modeOf(id: string): ProjectMode {
  return id === "key" ? "key" : id === "demo" ? "demo" : "owned";
}

/** Point every request at this project before anything below it fetches. */
function applyScope(id: string, mode: ProjectMode) {
  const header = mode === "owned" ? id : "";
  if (getActiveProject() !== header) {
    setActiveProject(header);
    queryClient.removeQueries(); // another project's data must not linger in the cache
  }
}

/** A project that does not exist, was deleted, or belongs to someone else (the API answers 404 for all three). */
function ProjectMissing() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-gradient text-6xl font-semibold tracking-tight">404</p>
      <p className="text-lg font-semibold">This project is not among yours</p>
      <p className="text-sm text-dim">It may have been deleted, or it belongs to another account.</p>
      <Link to="/projects" className="mt-2 text-sm font-semibold text-accent hover:underline">Your projects</Link>
    </div>
  );
}

function Waiting() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

/** /p/:projectRef/... : the project's dashboard, for its owner, a project key, or the public demo.
 *  projectRef is the short name (/p/production); an old link with the long id is sent to the short name.
 *  The name is looked up among the signed-in person's own projects only, and the API still checks ownership. */
export function ProjectScope() {
  const { projectRef = "" } = useParams();
  const location = useLocation();
  const mode = modeOf(projectRef);
  const me = useMe();
  const config = useAuthConfig();
  const projects = useProjects(mode === "owned" && Boolean(me.data));
  const found = mode === "owned" && projects.data ? findProject(projects.data, projectRef) : undefined;
  const id = mode === "owned" ? found?.project_id ?? "" : projectRef;
  if (id) applyScope(id, mode);
  const detail = useProjectDetail(id && mode === "owned" ? id : undefined);

  const next = encodeURIComponent(location.pathname + location.search);
  if (mode === "key" && !hasApiKey()) return <Navigate to={`/signin?next=${next}`} replace />;
  if (mode === "demo" && config.data && !config.data.demo_project_id) return <Navigate to="/" replace />;
  if (mode === "owned") {
    if (me.isPending) return <Waiting />;
    const signedOut = me.isError && me.error instanceof ApiError && me.error.status === 401;
    if (signedOut || (!me.data && !me.isError)) return <Navigate to={`/signin?next=${next}`} replace />;
    if (projects.isPending) return <Waiting />;
    if (!found) return <ProjectMissing />;
    if (found.slug && found.slug !== projectRef) {
      // An old link with the long id: show the short name in the address instead.
      const rest = location.pathname.replace(/^\/p\/[^/]+/, "");
      return <Navigate to={`${projectPath(found)}${rest}${location.search}${location.hash}`} replace />;
    }
    if (detail.isError && detail.error instanceof ApiError && detail.error.status === 404) return <ProjectMissing />;
  }
  return (
    <ProjectContext.Provider value={{ id, ref: projectRef, mode }}>
      <Frame />
    </ProjectContext.Provider>
  );
}

/** Pages that need a signed-in person (the project list, a new project). Someone with only a project
 * key goes to that project; anyone else signs in first. */
export function RequireUser() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Waiting />;
  if (me.data) return <Outlet />;
  // Projects need a signed-in person; a saved project key is only used where someone chose /key.
  return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
}

/** Old addresses (/jobs, /activity?tab=news, /runs?job=x) open in the project last used. */
export function LegacyRedirect({ to }: { to?: string }) {
  const location = useLocation();
  const active = getActiveProject();
  const projects = useProjects(Boolean(active));
  if (!active) return <Navigate to="/projects" replace />;
  if (projects.isPending) return <Waiting />;
  const found = projects.data ? findProject(projects.data, active) : undefined;
  if (!found) return <Navigate to="/projects" replace />;
  return <Navigate to={`${projectPath(found)}${to ?? location.pathname + location.search + location.hash}`} replace />;
}
