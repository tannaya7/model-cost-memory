import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { Skeleton } from "../shared/components/Skeleton";
import { ErrorMessage } from "../shared/components/ErrorMessage";
import { ApiError, hasApiKey } from "../shared/api/apiFetch";

export function RequireAuth() {
  const location = useLocation();
  const { data: user, isPending, isError, error, refetch } = useMe();
  const config = useAuthConfig();

  if (isPending || (isError && config.isPending)) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }

  // Only a 401 means "signed out". A 404 means the backend has not built /v1/me yet,
  // so sign-in is not switched on: let people in rather than locking everyone out.
  if (isError && error instanceof ApiError && error.status === 404) {
    return <Outlet />;
  }

  const isSignedOut = isError && error instanceof ApiError && error.status === 401;

  // Not signed in, but a project key is saved (the SDK-style setup) or this server has a public demo.
  // Settings is where a key is entered, so it must be reachable before one exists.
  if (isSignedOut && (hasApiKey() || config.data?.demo_project_id || location.pathname === "/settings")) {
    return <Outlet />;
  }

  // We already know who the user is and only a background refresh failed (not a 401): stay in.
  if (isError && user && !isSignedOut) {
    return <Outlet />;
  }

  if (isError && !isSignedOut) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <div className="w-full max-w-md">
          <ErrorMessage error={error} onRetry={() => refetch()} />
        </div>
      </div>
    );
  }

  if (isError || !user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return (
      <Navigate
        to={`/signin${location.pathname !== "/" ? `?next=${next}` : ""}`}
        replace
      />
    );
  }

  return <Outlet />;
}
