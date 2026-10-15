import { Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { RouteErrorBoundary } from "../shared/components/RouteErrorBoundary";
import { Skeleton } from "../shared/components/Skeleton";

export const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/spend", label: "Spend" },
  { to: "/runs", label: "Runs" },
  { to: "/jobs", label: "Jobs" },
  { to: "/models", label: "Models" },
  { to: "/alerts", label: "Alerts" },
  { to: "/history", label: "History" },
  { to: "/retest", label: "Re-test" },
  { to: "/settings", label: "Settings" },
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
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-rule bg-surface p-4 md:min-h-screen md:w-[var(--sidebar-width)] md:border-b-0 md:border-r">
        <div className="mb-4 text-sm font-bold tracking-tight">Model &amp; Cost Memory</div>
        <nav className="flex flex-wrap gap-1 md:flex-col">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-accent-soft text-accent" : "text-dim hover:bg-bg"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        {/* key resets the boundary when the route changes */}
        <RouteErrorBoundary key={pathname}>
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
