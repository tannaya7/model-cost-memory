import { ApiError } from "../api/apiFetch";

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "The project key was not accepted. Check it in Settings.";
    return `${error.message} (${error.status})`;
  }
  // fetch() throws a TypeError ("Failed to fetch") when the request never reached a server.
  if (error instanceof TypeError) {
    return "Could not reach the server. Check that the dev server is still running, then try again.";
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-bad bg-bad-soft p-4 text-sm text-bad">
      <p className="font-semibold">Could not load this.</p>
      <p className="mt-1">{describe(error)}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded-md border border-bad px-3 py-1 font-semibold hover:bg-surface"
        >
          Try again
        </button>
      )}
    </div>
  );
}
