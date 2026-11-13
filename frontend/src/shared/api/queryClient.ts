import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./apiFetch";

/** A 401 inside the app means the session ended (or a saved key stopped working): send the person to
 * sign in, and back to this page afterwards. Pages that handle signed-out visitors themselves (the
 * landing page, sign-in, the public demo) are left alone. */
export function onSignedOut(err: unknown, where: Location = window.location) {
  if (!(err instanceof ApiError) || err.status !== 401) return;
  const path = where.pathname;
  if (path.startsWith("/p/key")) {
    where.assign("/key");
  } else if ((path.startsWith("/p/") && !path.startsWith("/p/demo")) || path.startsWith("/projects")) {
    where.assign(`/signin?next=${encodeURIComponent(path + where.search)}`);
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err) => onSignedOut(err) }),
  mutationCache: new MutationCache({ onError: (err) => onSignedOut(err) }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Don't retry client errors (401, 404...): they won't fix themselves.
      retry: (count, err) =>
        !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});
