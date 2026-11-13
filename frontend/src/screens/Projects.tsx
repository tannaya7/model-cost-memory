/** Projects: choose one, or make one and get its key. */
import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { ApiKeyRevealBox } from "../features/projects/components/ApiKeyRevealBox";
import { useCreateProject, useProjects } from "../features/projects/hooks/useProjects";
import { ApiError, getActiveProject, setActiveProject } from "../shared/api/apiFetch";
import { queryClient } from "../shared/api/queryClient";
import { shortDate } from "../ui/format";
import { IconArrowRight, IconPlus } from "../ui/icons";
import { Button, cx, EmptyState, ErrorState, Panel, PanelHeader, Pill, Skeleton } from "../ui/primitives";

export default function Projects() {
  const projects = useProjects();
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ key: string; name: string } | null>(null);
  const active = getActiveProject();

  const open = (id: string) => {
    setActiveProject(id);
    void queryClient.invalidateQueries();
    navigate("/");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the project a name");
    try {
      const result = await create.mutateAsync({ name: name.trim() });
      setActiveProject(result.project.project_id);
      void queryClient.invalidateQueries();
      setFresh({ key: result.api_key, name: result.project.name });
      setName("");
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not create the project");
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-dim">A project is one application. Its runs, jobs and keys are kept apart from every other project.</p>
      </header>

      {fresh && <ApiKeyRevealBox apiKey={fresh.key} title={`${fresh.name} is ready. Copy its key now: it is shown only once.`} onDismiss={() => setFresh(null)} />}

      <Panel glow className="p-5 md:p-6">
        <PanelHeader title="New project" hint="You get its key at once; put it in the SDK as MCM_API_KEY." />
        <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder="e.g. Invoice assistant"
            aria-label="Project name"
            className="min-w-0 flex-1 rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          <Button type="submit" variant="primary" disabled={create.isPending}>
            <IconPlus size={16} /> {create.isPending ? "Creating…" : "Create project"}
          </Button>
        </form>
        {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      </Panel>

      {projects.isPending ? (
        <Skeleton className="h-40" />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : (projects.data ?? []).length === 0 ? (
        <EmptyState title="No project yet" hint="Create the first one above." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {(projects.data ?? []).map((p, i) => (
            <motion.li key={p.project_id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
              <button
                type="button"
                onClick={() => open(p.project_id)}
                className={cx("panel group flex w-full items-center justify-between gap-3 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-rule-strong", p.project_id === active && "ring-1 ring-accent/40")}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-ink">{p.name}</span>
                    {p.project_id === active && <Pill tone="accent" icon={false}>open</Pill>}
                  </span>
                  <span className="mt-1 block truncate font-mono text-xs text-muted">{p.project_id} · since {shortDate(p.created_at)}</span>
                </span>
                <IconArrowRight size={17} className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
              </button>
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}
