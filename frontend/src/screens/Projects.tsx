/** All of a person's projects, each with its numbers, and the way to make another. A person with no
 * project yet goes straight to making one. */
import { useQueries } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useLogout, useMe } from "../features/auth/hooks/useAuth";
import { useProjects } from "../features/projects/hooks/useProjects";
import { useCreateCompany, useWorkspaces } from "../features/workspaces/hooks/useWorkspaces";
import { deleteAccount } from "../features/workspaces/api/workspacesApi";
import { ApiError } from "../shared/api/apiFetch";
import { projectPath } from "../shared/projectPath";
import { apiFetch } from "../shared/api/apiFetch";
import type { Job, Project } from "../shared/api/types";
import { count, shortDate } from "../ui/format";
import { IconArrowRight, IconBell, IconLogo, IconPlus, IconShield } from "../ui/icons";
import { Button, ButtonLink, ErrorState, Pill, Skeleton } from "../ui/primitives";
import { TypedConfirm } from "../ui/TypedConfirm";
import { ThemeToggle } from "../ui/ThemeToggle";

function TopBar() {
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <header className="border-b border-rule bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-4 md:px-6">
        <Link to="/projects" className="flex items-center gap-2.5"><IconLogo size={28} /><span className="font-semibold tracking-tight">Model &amp; Cost Memory</span></Link>
        <div className="flex items-center gap-3">
          {user && <span className="hidden text-sm text-dim sm:inline">{user.email}</span>}
          {user && <Link to="/signin?switch=1&next=%2Fprojects" className="text-sm text-dim hover:text-ink">Switch account</Link>}
          <ThemeToggle />
          <Button
            size="sm"
            variant="ghost"
            title="Signs you out on every device"
            onClick={async () => {
              try {
                await logout.mutateAsync();
              } catch {
                /* signed out either way */
              }
              navigate("/");
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

function ProjectCard({ project, jobs, index }: { project: Project; jobs: Job[] | undefined; index: number }) {
  const runs = jobs?.reduce((s, j) => s + j.run_count, 0);
  return (
    <motion.li className="min-w-0" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
      <Link
        to={projectPath(project)}
        className="panel group flex h-full flex-col gap-5 p-6 transition-all hover:-translate-y-0.5 hover:border-rule-strong"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold tracking-tight text-ink" title={project.name}>{project.name}</p>
            <p className="mt-0.5 text-xs text-muted">since {shortDate(project.created_at)}</p>
          </div>
          <IconArrowRight size={18} className="mt-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted">AI tasks</dt>
            <dd className="tabular text-xl font-semibold text-ink">{jobs ? jobs.length : <Skeleton className="mt-1 h-6 w-8" />}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted">AI calls recorded</dt>
            <dd className="tabular text-xl font-semibold text-ink">{runs !== undefined ? count(runs) : <Skeleton className="mt-1 h-6 w-12" />}</dd>
          </div>
        </dl>
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-rule pt-4">
          <Pill tone={project.webhook_url ? "good" : "neutral"} icon={false}>
            <IconBell size={12} /> {project.webhook_url ? "Alerts to webhook" : "Alerts in app only"}
          </Pill>
          <Pill tone="neutral" icon={false}><IconShield size={12} /> Prompts kept {project.content_retention_days} d</Pill>
        </div>
      </Link>
    </motion.li>
  );
}

function Companies() {
  const spaces = useWorkspaces();
  const create = useCreateCompany();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const companies = (spaces.data ?? []).filter((w) => w.kind === "company");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const made = await create.mutateAsync(name.trim());
      navigate(`/company/${made.org_id}`);
    } catch (err) {
      setMsg(err instanceof ApiError || err instanceof Error ? err.message : "Could not create the company");
    }
  };
  return (
    <section aria-labelledby="companies-h" className="panel flex flex-col gap-3 p-6">
      <h2 id="companies-h" className="text-lg font-semibold">Companies</h2>
      <p className="text-sm text-dim">Optional. A company shares projects with the people you invite. Your personal projects stay yours.</p>
      {companies.length > 0 && (
        <ul className="divide-y divide-rule">
          {companies.map((c) => (
            <li key={c.org_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 truncate font-semibold">{c.name} <span className="font-normal text-muted">· {c.role} · {c.project_count} project{c.project_count === 1 ? "" : "s"}</span></span>
              <span className="flex gap-3">
                <Link to={`/projects/new?workspace=${c.org_id}`} className="font-semibold text-accent hover:underline">New project here</Link>
                <Link to={`/company/${c.org_id}`} className="font-semibold text-accent hover:underline">People</Link>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-semibold text-dim">New company name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required className="rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm font-normal text-ink" />
        </label>
        <Button type="submit" disabled={create.isPending || !name.trim()}>Create company</Button>
      </form>
      {msg && <p role="alert" className="text-sm text-bad">{msg}</p>}
    </section>
  );
}

function DeleteAccount() {
  const { data: user } = useMe();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const remove = async (typed: string) => {
    setMsg(null);
    try {
      await deleteAccount(typed);
      navigate("/");
    } catch (err) {
      setAsking(false);
      setMsg(err instanceof ApiError || err instanceof Error ? err.message : "Could not delete the account");
    }
  };
  return (
    <section aria-labelledby="account-h" className="flex flex-col gap-2 border-t border-rule pt-6">
      <h2 id="account-h" className="text-sm font-semibold text-dim">Your account</h2>
      <p className="text-xs text-muted">Deleting it removes your personal projects and everything recorded in them. It cannot be undone. Companies keep their own projects.</p>
      <div><Button size="sm" variant="danger" onClick={() => setAsking(true)}>Delete my account</Button></div>
      {asking && user && (
        <TypedConfirm label="Delete your account" expected={user.email} ignoreCase confirmLabel="Delete my account" onCancel={() => setAsking(false)} onConfirm={(typed) => void remove(typed)}>
          This deletes your account and your personal projects with everything recorded in them. Companies keep their projects. It cannot be undone.
        </TypedConfirm>
      )}
      {msg && <p role="alert" className="text-sm text-bad">{msg}</p>}
    </section>
  );
}

export default function Projects() {
  const projects = useProjects();
  const { data: user } = useMe();
  const list = projects.data ?? [];
  const jobs = useQueries({
    queries: list.map((p) => ({
      queryKey: ["project-jobs", p.project_id],
      queryFn: () => apiFetch<Job[]>("/v1/jobs", { headers: { "X-Project-Id": p.project_id } }),
      staleTime: 60_000,
    })),
  });

  if (projects.isSuccess && list.length === 0) return <Navigate to="/projects/new" replace />;

  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="mx-auto flex max-w-[1200px] flex-col gap-8 px-4 py-10 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] md:text-4xl">
              {user?.name ? <>Welcome back, <span className="text-gradient">{user.name.split(" ")[0]}</span></> : "Your projects"}
            </h1>
            <p className="mt-1.5 text-dim">A project is one app or product that uses AI. Open one to see what it spends, how its answers are doing and how much you could save.</p>
          </div>
          <ButtonLink to="/projects/new" variant="primary"><IconPlus size={16} /> New project</ButtonLink>
        </div>

        {projects.isPending ? (
          <div role="status" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"><span className="sr-only">Loading your projects…</span>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)}</div>
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map((p, i) => <ProjectCard key={p.project_id} project={p} jobs={jobs[i]?.data} index={i} />)}
            <motion.li initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: list.length * 0.05 }}>
              <Link
                to="/projects/new"
                className="flex h-full min-h-56 flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-rule-strong p-6 text-center text-dim transition-colors hover:border-accent hover:text-ink"
              >
                <span className="grid h-11 w-11 place-items-center rounded-full bg-accent-soft text-accent"><IconPlus size={20} /></span>
                <span className="font-semibold">New project</span>
                <span className="max-w-60 text-xs text-muted">Another app, with its own AI tasks, key and alerts.</span>
              </Link>
            </motion.li>
          </ul>
        )}
        <Companies />
        <DeleteAccount />
      </main>
    </div>
  );
}
