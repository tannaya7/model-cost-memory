import { Suspense } from "react";
import { getActiveProject } from "../shared/api/apiFetch";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { motion, MotionConfig } from "framer-motion";
import { RouteErrorBoundary } from "../shared/components/RouteErrorBoundary";
import { Skeleton } from "../shared/components/Skeleton";
import { useAlertsCount } from "../features/alerts/hooks/useAlertsCount";
import { useMe, useLogout } from "../features/auth/hooks/useAuth";

export const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/spend", label: "Spend" },
  { to: "/flow", label: "Live flow" },
  { to: "/runs", label: "Runs" },
  { to: "/jobs", label: "Jobs" },
  { to: "/models", label: "Models" },
  { to: "/alerts", label: "Alerts" },
  { to: "/history", label: "History" },
  { to: "/retest", label: "Re-test" },
  { to: "/settings", label: "Settings" },
  { to: "/projects", label: "Projects" },
];

function PageFallback() {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading page">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { count: alertsCount, isPending: isAlertsPending } = useAlertsCount();
  const { data: user } = useMe();
  const logoutMutation = useLogout();

  const handleSignOut = async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch {
      /* ignore */
    }
    navigate("/signin");
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen md:flex">
        <aside className="border-b border-rule bg-surface p-4 md:min-h-screen md:w-[var(--sidebar-width)] md:border-b-0 md:border-r flex flex-col justify-between">
          <div>
            <div className="mb-4 space-y-1">
              <div className="text-sm font-bold tracking-tight">Model &amp; Cost Memory</div>
              {getActiveProject() && (
                <NavLink to="/projects" className="block truncate text-xs text-dim hover:text-accent">
                  Project: <span className="font-mono text-ink">{getActiveProject()}</span>
                </NavLink>
              )}
            </div>
            <nav className="flex flex-wrap gap-1 md:flex-col">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex min-h-[40px] items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-dim hover:bg-bg"
                    }`
                  }
                >
                  <span>{item.label}</span>
                  {item.to === "/alerts" && !isAlertsPending && alertsCount > 0 && (
                    <span
                      aria-label={`${alertsCount} open ${
                        alertsCount === 1 ? "alert" : "alerts"
                      }`}
                      className="inline-flex items-center justify-center rounded-full bg-bad-soft px-1.5 py-0.5 text-xs font-bold text-bad"
                    >
                      {alertsCount}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* User profile & Sign out */}
          <div className="mt-6 border-t border-rule pt-4 space-y-2">
            {user && (
              <div className="px-1">
                <p className="text-xs font-semibold text-ink truncate">
                  {user.name}
                </p>
                <p className="text-xs text-dim truncate">{user.email}</p>
              </div>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={logoutMutation.isPending}
              className="w-full min-h-[40px] flex items-center rounded-md px-3 py-2 text-xs font-medium text-dim hover:text-bad hover:bg-bg transition-colors cursor-pointer disabled:opacity-50"
            >
              {logoutMutation.isPending ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 p-4 md:p-8">
          {/* key resets the boundary when the route changes */}
          <RouteErrorBoundary key={pathname}>
            <Suspense fallback={<PageFallback />}>
              <motion.div
                key={pathname}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="w-full"
              >
                <Outlet />
              </motion.div>
            </Suspense>
          </RouteErrorBoundary>
        </main>
      </div>
    </MotionConfig>
  );
}
