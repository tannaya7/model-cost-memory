/** Sign in: what the product does on the left, the way in on the right. */
import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { devLogin } from "../features/auth/api/authApi";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { queryClient } from "../shared/api/queryClient";
import { IconAlert, IconDollar, IconLogo, IconShield } from "../ui/icons";
import { Button } from "../ui/primitives";

function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const POINTS = [
  { x: 82, y: 22, label: "large", dim: true },
  { x: 58, y: 30, label: "mid", dim: true },
  { x: 24, y: 34, label: "mini", win: true },
  { x: 12, y: 70, label: "nano", dim: true },
];

/** A tiny picture of the idea: models on cost and quality, the cheapest good-enough one picked. */
function Picture() {
  return (
    <svg viewBox="0 0 100 90" className="h-full w-full" aria-hidden>
      <rect x="0" y="8" width="100" height="32" fill="var(--color-ok)" fillOpacity="0.07" />
      <line x1="0" y1="40" x2="100" y2="40" stroke="var(--color-ok)" strokeOpacity="0.4" strokeWidth="0.4" />
      {[20, 40, 60, 80].map((x) => <line key={x} x1={x} y1="0" x2={x} y2="88" stroke="var(--chart-grid)" strokeWidth="0.3" />)}
      {POINTS.map((p, i) => (
        <motion.g key={p.label} initial={{ opacity: 0, scale: 0.4 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4 + i * 0.15, type: "spring" }} style={{ originX: `${p.x}px`, originY: `${p.y}px` }}>
          {p.win && (
            <motion.circle cx={p.x} cy={p.y} r="5" fill="none" stroke="var(--color-accent)" strokeWidth="0.8" animate={{ r: [4.5, 7, 4.5], opacity: [1, 0.4, 1] }} transition={{ duration: 2.2, repeat: Infinity }} />
          )}
          <circle cx={p.x} cy={p.y} r="2.4" fill={p.win ? "var(--color-accent)" : "#5d6380"} />
          <text x={p.x + 4} y={p.y - 3} fontSize="5.5" fill={p.win ? "#d8d3ff" : "#7d83a6"} fontFamily="var(--font-mono)">{p.label}</text>
        </motion.g>
      ))}
      <text x="1" y="88" fontSize="4.6" fill="#7d83a6">cheaper ←</text>
      <text x="74" y="88" fontSize="4.6" fill="#7d83a6">→ costlier</text>
      <text x="1" y="6" fontSize="4.6" fill="#6fdc9c">good enough</text>
    </svg>
  );
}

const POINTS_OF_VALUE = [
  { icon: IconDollar, title: "The cheapest model that still works", text: "Proven on your own runs, with the saving per month." },
  { icon: IconAlert, title: "A warning when an upgrade breaks things", text: "Even when the provider changes a model without a new name." },
  { icon: IconShield, title: "Evidence that keeps itself current", text: "Old runs fade, new models are re-tested within a budget." },
];

export default function SignIn() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(searchParams.get("error") === "google" ? "Google sign-in did not finish. Please try again." : null);
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
        document.cookie = "mcm_mock_signed_in=true; path=/; SameSite=Lax";
      } catch {
        /* storage unavailable */
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

  const me = useMe();
  const google = isMock || Boolean(config.data?.google);
  if (me.data) return <Navigate to={next === "/" ? "/projects" : next} replace />;
  const dev = Boolean(config.data?.dev_login);

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.15fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-rule p-12 lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden className="pointer-events-none absolute -left-40 top-1/3 h-[480px] w-[480px] rounded-full bg-accent/15 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <IconLogo size={34} />
          <span className="text-lg font-semibold tracking-tight">Model &amp; Cost Memory</span>
        </div>
        <div className="relative">
          <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }} className="max-w-xl text-5xl font-semibold leading-[1.05] tracking-tight">
            Stop paying for <span className="text-gradient">a bigger model</span> than the job needs.
          </motion.h1>
          <div className="mt-8 h-56 max-w-md rounded-[18px] border border-rule bg-surface/60 p-4">
            <Picture />
          </div>
        </div>
        <ul className="relative grid gap-4 xl:grid-cols-3">
          {POINTS_OF_VALUE.map(({ icon: Icon, title, text }, i) => (
            <motion.li key={title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 + i * 0.1 }} className="flex flex-col gap-1.5">
              <Icon size={18} className="text-accent" />
              <span className="text-sm font-semibold text-ink">{title}</span>
              <span className="text-xs text-dim">{text}</span>
            </motion.li>
          ))}
        </ul>
      </section>

      <section className="flex items-center justify-center p-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="panel w-full max-w-sm p-8">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <IconLogo size={28} />
            <span className="font-semibold tracking-tight">Model &amp; Cost Memory</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-dim">See which models your AI features should use, and what that saves.</p>

          {error && <p role="alert" className="mt-5 rounded-[10px] border border-bad/30 bg-bad-soft p-3 text-sm text-bad">{error}</p>}

          <div className="mt-6 flex flex-col gap-4">
            {google && (
              <Button variant="primary" onClick={handleGoogle} className="w-full py-2.5">
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                Continue with Google
              </Button>
            )}
            {dev && (
              <form onSubmit={handleDevLogin} className="flex flex-col gap-2">
                <label htmlFor="dev-email" className="text-xs font-semibold text-dim">Development sign-in</label>
                <div className="flex gap-2">
                  <input
                    id="dev-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="min-w-0 flex-1 rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
                  />
                  <Button type="submit">Sign in</Button>
                </div>
                <p className="text-xs text-muted">Only on a development server.</p>
              </form>
            )}
            {!config.isPending && !google && !dev && <p className="text-sm text-dim">Sign-in is not set up on this server yet.</p>}
          </div>

          <p className="mt-8 border-t border-rule pt-5 text-xs text-muted">
            Have a project key? <Link to="/key" className="font-semibold text-accent hover:underline">Use it instead</Link>
            {config.data?.demo_project_id && (
              <> or <Link to="/p/demo" className="font-semibold text-accent hover:underline">explore the demo</Link></>
            )}
          </p>
        </motion.div>
      </section>
    </div>
  );
}
