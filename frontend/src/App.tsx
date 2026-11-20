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
import { projectPath } from "./shared/projectPath";

const Landing = lazy(() => import("./screens/Landing"));
const SignIn = lazy(() => import("./screens/SignIn"));
const Projects = lazy(() => import("./screens/Projects"));
const NewProject = lazy(() => import("./screens/NewProject"));
const Company = lazy(() => import("./screens/Company"));
const CompanyOverview = lazy(() => import("./screens/CompanyOverview"));
const Welcome = lazy(() => import("./screens/Welcome"));
const JoinCompany = lazy(() => import("./screens/JoinCompany"));
const UseKey = lazy(() => import("./screens/UseKey"));
const Overview = lazy(() => import("./screens/Overview"));
const Jobs = lazy(() => import("./screens/Jobs"));
const JobWorkspace = lazy(() => import("./screens/job/JobWorkspace"));
const Models = lazy(() => import("./screens/Models"));
const Compare = lazy(() => import("./screens/compare/Compare"));
const SmartBudget = lazy(() => import("./screens/SmartBudget"));
const McpAgents = lazy(() => import("./screens/McpAgents"));
const CostAnalysis = lazy(() => import("./screens/CostAnalysis"));
const CostPlanner = lazy(() => import("./screens/CostPlanner"));
const DataCoverage = lazy(() => import("./screens/DataCoverage"));
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
  const { projectRef = "" } = useParams();
  const job = params.get("job");
  const base = projectPath(projectRef);
  return <Navigate to={job ? `${base}/jobs/${encodeURIComponent(job)}?tab=runs` : `${base}/jobs`} replace />;
}

function InProject({ to }: { to: string }) {
  const { projectRef = "" } = useParams();
  return <Navigate to={`${projectPath(projectRef)}${to}`} replace />;
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
      { path: "/welcome", element: page(<Welcome />) },
      { path: "/company/:orgId", element: page(<Company />) },
      { path: "/company/:orgId/overview", element: page(<CompanyOverview />) },
      { path: "/join/:token", element: page(<JoinCompany />) },
    ],
  },
  {
    path: "/p/:projectRef",
    element: <ProjectScope />,
    children: [
      { index: true, element: <Overview /> },
      { path: "jobs", element: <Jobs /> },
      { path: "jobs/:jobName", element: <JobWorkspace /> },
      { path: "models", element: <Models /> },
      { path: "compare", element: <Compare /> },
      { path: "budget", element: <SmartBudget /> },
      { path: "agents", element: <McpAgents /> },
      { path: "costs", element: <CostAnalysis /> },
      { path: "planner", element: <CostPlanner /> },
      { path: "coverage", element: <DataCoverage /> },
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
  ...["/jobs", "/jobs/:jobName", "/models", "/compare", "/budget", "/agents", "/costs", "/planner", "/coverage", "/activity", "/settings", "/retest", "/retest/:retestId", "/runs"].map((path) => ({
    path,
    element: <LegacyRedirect />,
  })),
  { path: "/alerts", element: <LegacyRedirect to="/activity" /> },
  { path: "/news", element: <LegacyRedirect to="/activity?tab=news" /> },
  { path: "/flow", element: <LegacyRedirect to="/activity?tab=live" /> },
  { path: "/spend", element: <LegacyRedirect to="" /> },
  { path: "/history", element: <LegacyRedirect to="/jobs" /> },
  { path: "/limits", element: <LegacyRedirect to="/settings#limits" /> },
  { path: "/projects/:projectRef", element: <ProjectSettingsRedirect /> },
  { path: "*", element: <Navigate to="/" replace /> },
]);

function ProjectSettingsRedirect() {
  const { projectRef = "" } = useParams();
  return <Navigate to={projectPath(projectRef, "/settings")} replace />;
}

export default function App() {
  return <RouterProvider router={router} />;
}
