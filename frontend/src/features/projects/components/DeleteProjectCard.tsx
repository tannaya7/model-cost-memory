import { useState } from "react";
import { Card } from "../../../shared/components/Card";
import { ApiError, getActiveProject, setActiveProject } from "../../../shared/api/apiFetch";
import { useDeleteProject } from "../hooks/useProjects";

type Props = {
  projectId: string;
  projectName: string;
  /** Called once the project is gone, e.g. to go back to the project list. */
  onDeleted: () => void;
};

/** Deleting a project, guarded by typing its id: it removes every job, run, prompt and key for good. */
export function DeleteProjectCard({ projectId, projectName, onDeleted }: Props) {
  const deleteMutation = useDeleteProject();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === projectId;

  const handleDelete = async () => {
    setError(null);
    try {
      await deleteMutation.mutateAsync(projectId);
      if (getActiveProject() === projectId) setActiveProject("");
      onDeleted();
    } catch (err: unknown) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "The project could not be deleted");
    }
  };

  return (
    <Card className="p-6 space-y-4 border-bad/40">
      <div>
        <h3 className="text-base font-semibold text-ink">Delete project</h3>
        <p className="mt-0.5 text-xs text-dim">
          Removes {projectName} and everything recorded under it: jobs, runs with their prompts and answers,
          re-tests, recommendations, alerts and the stored provider key. The project key stops working at once.
          This cannot be undone.
        </p>
      </div>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-bad/40 bg-surface px-4 py-2 text-xs font-semibold text-bad hover:bg-bad-soft transition-colors"
        >
          Delete this project…
        </button>
      ) : (
        <div role="alert" className="rounded-card border border-bad/40 bg-bad-soft p-4 space-y-3">
          <label htmlFor="delete-confirm" className="block text-sm font-semibold text-ink">
            Type <span className="font-mono">{projectId}</span> to confirm
          </label>
          <input
            id="delete-confirm"
            type="text"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded-md border border-rule bg-surface px-3 py-2 font-mono text-sm text-ink focus:border-bad focus:outline-none focus:ring-1 focus:ring-bad"
          />
          {error && <p className="text-xs text-bad">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={!matches || deleteMutation.isPending}
              className="rounded-md bg-bad px-3.5 py-1.5 text-xs font-semibold text-on-accent hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete project and all its data"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError(null);
              }}
              className="rounded-md border border-rule bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink hover:bg-bg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
