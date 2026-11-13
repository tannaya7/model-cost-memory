import { lazy, useEffect } from "react";
import { createBrowserRouter, Navigate, RouterProvider, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Frame } from "./app/Frame";
import { RequireAuth } from "./app/RequireAuth";
import { setActiveProject } from "./shared/api/apiFetch";
import { queryClient } from "./shared/api/queryClient";

const SignIn = lazy(() => import("./screens/SignIn"));
const Overview = lazy(() => import("./screens/Overview"));
const Jobs = lazy(() => import("./screens/Jobs"));
const JobWorkspace = lazy(() => import("./screens/job/JobWorkspace"));
const Models = lazy(() => import("./screens/Models"));
const Activity = lazy(() => import("./screens/Activity"));
const Settings = lazy(() => import("./screens/Settings"));
const Projects = lazy(() => import("./screens/Projects"));
const RetestStart = lazy(() => import("./screens/Retest").then((m) => ({ default: m.RetestStart })));
const RetestRun = lazy(() => import("./screens/Retest").then((m) => ({ default: m.RetestRun })));
const NotFound = lazy(() => import("./screens/Retest").then((m) => ({ default: m.NotFound })));

/** Old addresses (/runs?job=x&outcome=FAIL) land on the job's runs. */
function RunsRedirect() {
  const [params] = useSearchParams();
  const job = params.get("job");
  return <Navigate to={job ? `/jobs/${encodeURIComponent(job)}?tab=runs` : "/jobs"} replace />;
}

/** Old project pages open the project, then its settings. */
function ProjectRedirect() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  useEffect(() => {
    setActiveProject(projectId);
    void queryClient.invalidateQueries();
    navigate("/settings", { replace: true });
  }, [projectId, navigate]);
  return null;
}

const router = createBrowserRouter([
  { path: "/signin", element: <SignIn /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Frame />,
        children: [
          { path: "/", element: <Overview /> },
          { path: "/jobs", element: <Jobs /> },
          { path: "/jobs/:jobName", element: <JobWorkspace /> },
          { path: "/models", element: <Models /> },
          { path: "/activity", element: <Activity /> },
          { path: "/settings", element: <Settings /> },
          { path: "/projects", element: <Projects /> },
          { path: "/projects/:projectId", element: <ProjectRedirect /> },
          { path: "/retest", element: <RetestStart /> },
          { path: "/retest/:retestId", element: <RetestRun /> },
          // Where the old screens used to be.
          { path: "/spend", element: <Navigate to="/" replace /> },
          { path: "/history", element: <Navigate to="/jobs" replace /> },
          { path: "/alerts", element: <Navigate to="/activity" replace /> },
          { path: "/flow", element: <Navigate to="/activity?tab=live" replace /> },
          { path: "/news", element: <Navigate to="/activity?tab=news" replace /> },
          { path: "/limits", element: <Navigate to={{ pathname: "/settings", hash: "#limits" }} replace /> },
          { path: "/runs", element: <RunsRedirect /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
