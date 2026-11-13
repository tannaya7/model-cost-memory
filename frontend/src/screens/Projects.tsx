/** All of a person's projects, each with its numbers, and the way to make another. A person with no
 * project yet goes straight to making one. */
import { useQueries } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useLogout, useMe } from "../features/auth/hooks/useAuth";
import { useProjects } from "../features/projects/hooks/useProjects";
import { apiFetch } from "../shared/api/apiFetch";
import type { Job, Project } from "../shared/api/types";
import { count, shortDate } from "../ui/format";
import { IconArrowRight, IconBell, IconLogo, IconPlus, IconShield } from "../ui/icons";
import { Button, ButtonLink, ErrorState, Pill, Skeleton } from "../ui/primitives";
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
          <ThemeToggle />
          <Button
            size="sm"
            variant="ghost"
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
    <motion.li initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
      <Link
        to={`/p/${encodeURIComponent(project.project_id)}`}
        className="panel group flex h-full flex-col gap-5 p-6 transition-all hover:-translate-y-0.5 hover:border-rule-strong"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold tracking-tight text-ink">{project.name}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-muted">{project.project_id}</p>
          </div>
          <IconArrowRight size={18} className="mt-1 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted">Jobs</dt>
            <dd className="tabular text-xl font-semibold text-ink">{jobs ? jobs.length : <Skeleton className="mt-1 h-6 w-8" />}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted">Runs recorded</dt>
            <dd className="tabular text-xl font-semibold text-ink">{runs !== undefined ? count(runs) : <Skeleton className="mt-1 h-6 w-12" />}</dd>
          </div>
        </dl>
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-rule pt-4">
          <Pill tone={project.webhook_url ? "good" : "neutral"} icon={false}>
            <IconBell size={12} /> {project.webhook_url ? "Alerts to webhook" : "Alerts in app only"}
          </Pill>
          <Pill tone="neutral" icon={false}><IconShield size={12} /> Prompts kept {project.content_retention_days} d</Pill>
          <span className="ml-auto text-xs text-muted">since {shortDate(project.created_at)}</span>
        </div>
      </Link>
    </motion.li>
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
          <div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              {user?.name ? <>Welcome back, <span className="text-gradient">{user.name.split(" ")[0]}</span></> : "Your projects"}
            </h1>
            <p className="mt-1.5 text-dim">Each project is one application. Open one to see its jobs, savings and alerts.</p>
          </div>
          <ButtonLink to="/projects/new" variant="primary"><IconPlus size={16} /> New project</ButtonLink>
        </div>

        {projects.isPending ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)}</div>
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
                <span className="max-w-60 text-xs text-muted">Another application, with its own jobs, key and alerts.</span>
              </Link>
            </motion.li>
          </ul>
        )}
      </main>
    </div>
  );
}
