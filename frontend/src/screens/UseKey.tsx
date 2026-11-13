/** Opening a project with its key, for people who do not sign in (a script, a teammate, CI). */
import { Link, useNavigate } from "react-router-dom";
import { ProjectKeySettings } from "../features/settings/components/ProjectKeySettings";
import { hasApiKey } from "../shared/api/apiFetch";
import { IconArrowRight, IconLogo } from "../ui/icons";
import { Button, Panel } from "../ui/primitives";
import { ThemeToggle } from "../ui/ThemeToggle";

export default function UseKey() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2.5"><IconLogo size={26} /><span className="font-semibold tracking-tight">Model &amp; Cost Memory</span></Link>
          <div className="flex items-center gap-4">
            <Link to="/signin" className="text-sm text-dim hover:text-ink">Sign in instead</Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-12">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Open a project with its key</h1>
          <p className="mt-2 text-dim">Paste the key the project was created with. It is kept in this browser only, and sent with each request.</p>
        </div>
        <Panel className="p-6">
          <ProjectKeySettings />
        </Panel>
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => (hasApiKey() ? navigate("/p/key") : undefined)}>
            Open the project <IconArrowRight size={16} />
          </Button>
        </div>
      </main>
    </div>
  );
}
