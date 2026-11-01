import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { queryClient } from "../shared/api/queryClient";
import { Card } from "../shared/components/Card";
import { useAuthConfig } from "../features/auth/hooks/useAuth";
import { devLogin } from "../features/auth/api/authApi";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function SignInPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "google" ? "Google sign-in did not finish. Please try again." : null,
  );
  const next = safeNext(searchParams.get("next"));

  const isMock = import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "true";

  const finish = () => {
    queryClient.clear();
    navigate(next === "/" ? "/projects" : next, { replace: true });
  };

  const handleGoogle = () => {
    if (isMock) {
      try {
        localStorage.setItem("mcm_mock_signed_in", "true");
        // Also a cookie, so the Vite fallback mock (which runs in Node) sees it.
        document.cookie = "mcm_mock_signed_in=true; path=/; SameSite=Lax";
      } catch {
        /* storage unavailable: ignore */
      }
      finish();
    } else {
      window.location.assign(`/auth/google/login?next=${encodeURIComponent(next)}`);
    }
  };

  const handleDevLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await devLogin(email.trim());
      finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    }
  };

  const google = isMock || Boolean(config.data?.google);
  const dev = Boolean(config.data?.dev_login);

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-8 text-center space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink">Model &amp; Cost Memory</h1>
          <p className="text-sm text-dim">
            The cheapest model that still does each job properly, and a warning when an upgrade quietly
            makes things worse.
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-bad/30 bg-bad-soft p-3 text-sm text-bad">
            {error}
          </p>
        )}

        <div className="space-y-4 pt-2">
          {google && (
            <button
              type="button"
              onClick={handleGoogle}
              className="w-full inline-flex items-center justify-center gap-3 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 transition-opacity cursor-pointer"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
              Sign in with Google
            </button>
          )}

          {dev && (
            <form onSubmit={handleDevLogin} className="space-y-2 text-left">
              <label htmlFor="dev-email" className="text-xs font-semibold uppercase tracking-wider text-dim">
                Development sign-in
              </label>
              <div className="flex gap-2">
                <input
                  id="dev-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="min-h-[40px] flex-1 rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <button
                  type="submit"
                  className="rounded-md border border-rule bg-surface px-4 text-sm font-semibold text-ink hover:bg-bg"
                >
                  Sign in
                </button>
              </div>
              <p className="text-xs text-dim">Only on a development server (DEV_LOGIN=true).</p>
            </form>
          )}

          {!config.isPending && !google && !dev && (
            <p className="text-sm text-dim">Sign-in is not set up on this server yet.</p>
          )}

          <p className="text-xs text-dim">
            Have a project key?{" "}
            <Link to="/settings" className="font-semibold text-accent hover:underline">
              Use it instead
            </Link>
            {config.data?.demo_project_id && (
              <>
                {" "}
                or{" "}
                <Link to="/" className="font-semibold text-accent hover:underline">
                  look at the demo
                </Link>
              </>
            )}
          </p>
        </div>
      </Card>
    </div>
  );
}
