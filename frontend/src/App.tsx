import { lazy } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { RequireAuth } from "./app/RequireAuth";

// Every page is lazy so each ships as its own chunk.
const SignInPage = lazy(() => import("./pages/SignInPage"));
const HomePage = lazy(() => import("./pages/HomePage"));
const SpendPage = lazy(() => import("./pages/SpendPage"));
const RunsPage = lazy(() => import("./pages/RunsPage"));
const JobsPage = lazy(() => import("./pages/JobsPage"));
const JobDetailPage = lazy(() => import("./pages/JobDetailPage"));
const ModelsPage = lazy(() => import("./pages/ModelsPage"));
const AlertsPage = lazy(() => import("./pages/AlertsPage"));
const HistoryPage = lazy(() => import("./pages/HistoryPage"));
const RetestPage = lazy(() => import("./pages/RetestPage"));
const RetestRunPage = lazy(() => import("./pages/RetestRunPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const ProjectSetupPage = lazy(() => import("./pages/ProjectSetupPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

const router = createBrowserRouter([
  { path: "/signin", element: <SignInPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <HomePage /> },
          { path: "/spend", element: <SpendPage /> },
          { path: "/runs", element: <RunsPage /> },
          { path: "/jobs", element: <JobsPage /> },
          { path: "/jobs/:jobName", element: <JobDetailPage /> },
          { path: "/models", element: <ModelsPage /> },
          { path: "/alerts", element: <AlertsPage /> },
          { path: "/history", element: <HistoryPage /> },
          { path: "/retest", element: <RetestPage /> },
          { path: "/retest/:retestId", element: <RetestRunPage /> },
          { path: "/settings", element: <SettingsPage /> },
          { path: "/projects", element: <ProjectsPage /> },
          { path: "/projects/:projectId", element: <ProjectSetupPage /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
