import { Link } from "react-router-dom";
import { Card } from "../../../shared/components/Card";
import { Badge } from "../../../shared/components/Badge";
import type { Project } from "../../../shared/api/types";

export function ProjectCard({ project }: { project: Project }) {
  const formattedDate = new Date(project.created_at).toLocaleDateString(
    undefined,
    {
      year: "numeric",
      month: "short",
      day: "numeric",
    },
  );

  return (
    <Card className="p-5 hover:border-accent/40 transition-colors">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link
              to={`/projects/${encodeURIComponent(project.project_id)}`}
              className="text-base font-bold text-ink hover:text-accent hover:underline"
            >
              {project.name}
            </Link>
            {project.retest_allowed ? (
              <Badge tone="ok">Re-tests enabled</Badge>
            ) : (
              <Badge tone="neutral">Re-tests disabled</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-dim">
            <span>
              Key prefix:{" "}
              <span className="font-mono text-ink">
                {project.key_prefix}…
              </span>
            </span>
            <span>•</span>
            <span>
              Re-test cap:{" "}
              <span className="font-mono text-ink">
                ${project.retest_monthly_cap_usd.toFixed(2)}/mo
              </span>
            </span>
            <span>•</span>
            <span>Created {formattedDate}</span>
          </div>
        </div>

        <div>
          <Link
            to={`/projects/${encodeURIComponent(project.project_id)}`}
            className="inline-flex items-center rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-dim hover:text-ink hover:bg-bg transition-colors"
          >
            Configure →
          </Link>
        </div>
      </div>
    </Card>
  );
}
