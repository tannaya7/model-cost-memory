/** Shown once after a person's first sign-in: confirms who they signed in as, then sends them on. */
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useLogout, useMe } from "../features/auth/hooks/useAuth";
import { useGuideFlags } from "../features/guide/useGuideFlags";
import { Button, Panel } from "../ui/primitives";
import { IconLogo } from "../ui/icons";

/** Only a path on this site; anything else becomes /projects. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/projects";
}

export default function Welcome() {
  const me = useMe();
  const { set } = useGuideFlags();
  const logout = useLogout();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const first = me.data?.name?.split(" ")[0];

  const go = () => {
    set("welcome_seen", true);
    navigate(next, { replace: true });
  };
  const other = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* signed out either way */
    }
    navigate("/signin");
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="flex items-center gap-2.5"><IconLogo size={28} /><span className="font-semibold tracking-tight">Model &amp; Cost Memory</span></div>
      <Panel glow className="p-6 md:p-8">
        <h1 className="text-3xl font-semibold tracking-tight">{first ? `Welcome, ${first}` : "Welcome"}</h1>
        <p className="mt-3 text-dim">
          Your account is ready. You signed in with Google as <strong className="text-ink [overflow-wrap:anywhere]">{me.data?.email}</strong>.
          No password is needed, and we never see your Google password.
        </p>
        <ul className="mt-4 flex flex-col gap-1.5 text-sm text-dim">
          <li>Next you can make your first project, one app that uses AI.</li>
          <li>You can join a company later, if you are invited. Your own projects stay yours.</li>
        </ul>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={go}>Continue</Button>
          <button type="button" onClick={other} className="text-sm text-dim hover:text-ink">Not you? Use another account</button>
        </div>
      </Panel>
      <p className="text-xs text-muted"><Link to="/" className="hover:underline">Back to the start page</Link></p>
    </main>
  );
}
