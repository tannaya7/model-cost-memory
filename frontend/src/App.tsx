/** The way through the app:
 *    /                 landing page (signed-in people go to their projects)
 *    /signin           sign in with Google
 *    /projects         all of your projects; none yet goes to /projects/new
 *    /projects/new     name a project, take its key, set up the recorder
 *    /p/:project/...   the project's dashboard: overview, jobs, models, activity, settings
 *    /key              open a project with its key instead of signing in
 * Old addresses (/jobs, /alerts, /runs?job=x, ...) open in the project last used. */
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, RouterProvider, useParams, useSearchParams } from "react-router-dom";
import { LegacyRedirect, ProjectScope, RequireUser } from "./app/project";
import { Skeleton } from "./ui/primitives";

const Landing = lazy(() => import("./screens/Landing"));
const SignIn = lazy(() => import("./screens/SignIn"));
const Projects = lazy(() => import("./screens/Projects"));
const NewProject = lazy(() => import("./screens/NewProject"));
const UseKey = lazy(() => import("./screens/UseKey"));
const Overview = lazy(() => import("./screens/Overview"));
const Jobs = lazy(() => import("./screens/Jobs"));
const JobWorkspace = lazy(() => import("./screens/job/JobWorkspace"));
const Models = lazy(() => import("./screens/Models"));
const Activity = lazy(() => import("./screens/Activity"));
const Settings = lazy(() => import("./screens/Settings"));
const RetestStart = lazy(() => import("./screens/Retest").then((m) => ({ default: m.RetestStart })));
const RetestRun = lazy(() => import("./screens/Retest").then((m) => ({ default: m.RetestRun })));
const NotFound = lazy(() => import("./screens/Retest").then((m) => ({ default: m.NotFound })));

function Loading() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

const page = (el: React.ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

/** Inside a project, /runs?job=x opens that job's runs. */
function RunsRedirect() {
  const [params] = useSearchParams();
  const { projectId = "" } = useParams();
  const job = params.get("job");
  const base = `/p/${encodeURIComponent(projectId)}`;
  return <Navigate to={job ? `${base}/jobs/${encodeURIComponent(job)}?tab=runs` : `${base}/jobs`} replace />;
}

function InProject({ to }: { to: string }) {
  const { projectId = "" } = useParams();
  return <Navigate to={`/p/${encodeURIComponent(projectId)}${to}`} replace />;
}

const router = createBrowserRouter([
  { path: "/", element: page(<Landing />) },
  { path: "/signin", element: page(<SignIn />) },
  { path: "/key", element: page(<UseKey />) },
  {
    element: <RequireUser />,
    children: [
      { path: "/projects", element: page(<Projects />) },
      { path: "/projects/new", element: page(<NewProject />) },
    ],
  },
  {
    path: "/p/:projectId",
    element: <ProjectScope />,
    children: [
      { index: true, element: <Overview /> },
      { path: "jobs", element: <Jobs /> },
      { path: "jobs/:jobName", element: <JobWorkspace /> },
      { path: "models", element: <Models /> },
      { path: "activity", element: <Activity /> },
      { path: "settings", element: <Settings /> },
      { path: "retest", element: <RetestStart /> },
      { path: "retest/:retestId", element: <RetestRun /> },
      // Older addresses inside a project.
      { path: "runs", element: <RunsRedirect /> },
      { path: "alerts", element: <InProject to="/activity" /> },
      { path: "news", element: <InProject to="/activity?tab=news" /> },
      { path: "flow", element: <InProject to="/activity?tab=live" /> },
      { path: "spend", element: <InProject to="" /> },
      { path: "history", element: <InProject to="/jobs" /> },
      { path: "limits", element: <InProject to="/settings#limits" /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  // Addresses from before projects were in the address: open them in the project last used.
  ...["/jobs", "/jobs/:jobName", "/models", "/activity", "/settings", "/retest", "/retest/:retestId", "/runs"].map((path) => ({
    path,
    element: <LegacyRedirect />,
  })),
  { path: "/alerts", element: <LegacyRedirect to="/activity" /> },
  { path: "/news", element: <LegacyRedirect to="/activity?tab=news" /> },
  { path: "/flow", element: <LegacyRedirect to="/activity?tab=live" /> },
  { path: "/spend", element: <LegacyRedirect to="" /> },
  { path: "/history", element: <LegacyRedirect to="/jobs" /> },
  { path: "/limits", element: <LegacyRedirect to="/settings#limits" /> },
  { path: "/projects/:projectId", element: <ProjectSettingsRedirect /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

function ProjectSettingsRedirect() {
  const { projectId = "" } = useParams();
  return <Navigate to={`/p/${encodeURIComponent(projectId)}/settings`} replace />;
}

export default function App() {
  return <RouterProvider router={router} />;
}
