/** The project a screen belongs to comes from the address: /p/<project>/jobs. Two special ids:
 *  - "key":  the project a saved project key belongs to (no sign-in)
 *  - "demo": the server's public read-only demo
 * Every request then names the project (X-Project-Id), and the cached data of another project is dropped
 * when the project changes, so one project's numbers never show on another's page. */
import { createContext, useContext } from "react";
import { Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { useProject as useProjectDetail } from "../features/projects/hooks/useProjects";
import { Link } from "react-router-dom";
import { ApiError, getActiveProject, hasApiKey, setActiveProject } from "../shared/api/apiFetch";
import { queryClient } from "../shared/api/queryClient";
import { Skeleton } from "../ui/primitives";
import { Frame } from "./Frame";

export type ProjectMode = "owned" | "key" | "demo";

const ProjectContext = createContext<{ id: string; mode: ProjectMode }>({ id: "", mode: "owned" });

/** Puts a screen inside a project without the router (tests, previews). */
export function WithProject({ id, children }: { id: string; children: React.ReactNode }) {
  return <ProjectContext.Provider value={{ id, mode: modeOf(id) }}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  return useContext(ProjectContext);
}

/** Links inside the current project: p("/jobs") is "/p/<project>/jobs", p("/") its overview. */
export function useP() {
  const { id } = useContext(ProjectContext);
  return (path = "/") => `/p/${encodeURIComponent(id)}${path === "/" ? "" : path}`;
}

function modeOf(id: string): ProjectMode {
  return id === "key" ? "key" : id === "demo" ? "demo" : "owned";
}

/** Point every request at this project before anything below it fetches. */
function useScope(id: string, mode: ProjectMode) {
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

/** /p/:projectId/... : the project's dashboard, for its owner, a project key, or the public demo. */
export function ProjectScope() {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const mode = modeOf(projectId);
  const me = useMe();
  const config = useAuthConfig();
  useScope(projectId, mode);
  const detail = useProjectDetail(mode === "owned" && me.data ? projectId : undefined);

  const next = encodeURIComponent(location.pathname + location.search);
  if (mode === "key" && !hasApiKey()) return <Navigate to={`/signin?next=${next}`} replace />;
  if (mode === "demo" && config.data && !config.data.demo_project_id) return <Navigate to="/" replace />;
  if (mode === "owned") {
    if (me.isPending) return <Waiting />;
    const signedOut = me.isError && me.error instanceof ApiError && me.error.status === 401;
    if (signedOut || (!me.data && !me.isError)) return <Navigate to={`/signin?next=${next}`} replace />;
    if (detail.isError && detail.error instanceof ApiError && detail.error.status === 404) return <ProjectMissing />;
  }
  return (
    <ProjectContext.Provider value={{ id: projectId, mode }}>
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
  const base = active ? `/p/${encodeURIComponent(active)}` : null;
  if (!base) return <Navigate to="/projects" replace />;
  return <Navigate to={`${base}${to ?? location.pathname + location.search + location.hash}`} replace />;
}
