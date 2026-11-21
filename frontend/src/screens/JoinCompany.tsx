/** /join/:token : accept a company invite. Joining never moves or merges the person's own projects. */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../shared/api/apiFetch";
import { useMe } from "../features/auth/hooks/useAuth";
import { useAcceptInvite } from "../features/workspaces/hooks/useWorkspaces";
import { Button, Panel } from "../ui/primitives";

export default function JoinCompany() {
  const { token = "" } = useParams();
  const me = useMe();
  const accept = useAcceptInvite();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    setError(null);
    try {
      const space = await accept.mutateAsync(token);
      navigate(space.org_id ? `/company/${space.org_id}` : "/projects", { replace: true });
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not join");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <Panel className="p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Join a company</h1>
        <p className="mt-2 text-sm text-dim">
          You are signed in as <strong className="text-ink">{me.data?.email}</strong>. The invite works only for the address it was sent to.
          Your own projects stay yours and separate.
          After you join, you will see what the company's account records and who can see it.
        </p>
        {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={join} disabled={accept.isPending}>Join</Button>
          <Link to="/projects" className="text-sm text-dim hover:text-ink">Not now</Link>
        </div>
      </Panel>
    </main>
  );
}
