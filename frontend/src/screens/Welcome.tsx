/** Shown once after a person's first sign-in with an account. It asks one plain question, the same way for everyone: the email never
 *  decides it. A work email can be used just for yourself, and a personal one for a team. The choice is not permanent: a team can be
 *  started or joined later, and a person's own projects never move. */
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError } from "../shared/api/apiFetch";
import { useLogout, useMe } from "../features/auth/hooks/useAuth";
import { useGuideFlags } from "../features/guide/useGuideFlags";
import { inviteToken } from "../features/workspaces/inviteToken";
import { useCreateCompany } from "../features/workspaces/hooks/useWorkspaces";
import { Button, Panel } from "../ui/primitives";
import { IconLogo } from "../ui/icons";

/** Only a path on this site; anything else becomes /projects. */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\") ? raw : "/projects";
}

const field = "w-full rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent";

function Choice({ title, text, onClick }: { title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full flex-col gap-1 rounded-[14px] border border-rule bg-surface-2/60 p-4 text-left transition-colors hover:border-accent focus-visible:border-accent">
      <span className="text-base font-semibold text-ink">{title}</span>
      <span className="text-sm text-dim">{text}</span>
    </button>
  );
}

export default function Welcome() {
  const me = useMe();
  const { set } = useGuideFlags();
  const logout = useLogout();
  const createCompany = useCreateCompany();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const first = me.data?.name?.split(" ")[0];
  const [step, setStep] = useState<"choose" | "team">("choose");
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const done = (to: string) => {
    set("welcome_seen", true);
    navigate(to, { replace: true });
  };
  const other = async () => {
    try {
      await logout.mutateAsync();
    } catch {
      /* signed out either way */
    }
    navigate("/signin");
  };
  const useInvite = () => {
    const token = inviteToken(invite);
    if (!token) return setError("That does not look like an invite. Paste the whole link, or the code, exactly as you were sent it.");
    setError(null);
    done(`/join/${token}`);
  };
  const startTeam = async () => {
    if (!name.trim()) return setError("Give your team or company a name.");
    setError(null);
    try {
      const made = await createCompany.mutateAsync(name.trim());
      done(`/company/${made.org_id}`);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not start it. Please try again.");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="flex items-center gap-2.5"><IconLogo size={28} /><span className="font-semibold tracking-tight">Model &amp; Cost Memory</span></div>
      <Panel glow className="p-6 md:p-8">
        <h1 className="text-3xl font-semibold tracking-tight">{first ? `Welcome, ${first}` : "Welcome"}</h1>
        <p className="mt-3 text-dim">
          You are signed in as <strong className="text-ink [overflow-wrap:anywhere]">{me.data?.email}</strong>. We keep no password for you.
        </p>

        {step === "choose" ? (
          <>
            <h2 className="mt-6 text-lg font-semibold">How will you use this?</h2>
            <div className="mt-3 flex flex-col gap-3">
              <Choice title="Just for me" text="Your own projects, private to you. A work email is fine for this." onClick={() => done(next)} />
              <Choice title="With a team or company" text="Share a space with other people, for 3 people or 300. Your own projects stay yours." onClick={() => setStep("team")} />
            </div>
            <p className="mt-4 text-xs text-muted">Nothing here is permanent. You can start or join a team later, and your own projects never move into it.</p>
          </>
        ) : (
          <>
            <h2 className="mt-6 text-lg font-semibold">With a team or company</h2>
            <div className="mt-3 flex flex-col gap-4">
              <div className="flex flex-col gap-2 rounded-[14px] border border-rule bg-surface-2/60 p-4">
                <label htmlFor="invite" className="text-sm font-semibold text-ink">I have an invite</label>
                <input id="invite" className={field} value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Paste the invite link or code" />
                <p className="text-xs text-muted">An invite works only for the email it was sent to. If it was sent to another address, sign in with that one instead.</p>
                <div><Button variant="primary" onClick={useInvite}>Use this invite</Button></div>
              </div>
              <div className="flex flex-col gap-2 rounded-[14px] border border-rule bg-surface-2/60 p-4">
                <label htmlFor="team-name" className="text-sm font-semibold text-ink">Start a team or company</label>
                <input id="team-name" className={field} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="For example Acme or Our team" />
                <p className="text-xs text-muted">You become its owner and can invite the others by email.</p>
                <div><Button variant="primary" onClick={startTeam} disabled={createCompany.isPending}>{createCompany.isPending ? "Starting…" : "Start it"}</Button></div>
              </div>
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
            <button type="button" onClick={() => { setStep("choose"); setError(null); }} className="mt-4 text-sm text-dim hover:text-ink">Back</button>
          </>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-rule pt-4">
          <button type="button" onClick={other} className="text-sm text-dim hover:text-ink">Not you? Use another account</button>
        </div>
      </Panel>
      <p className="text-xs text-muted"><Link to="/" className="hover:underline">Back to the start page</Link></p>
    </main>
  );
}
