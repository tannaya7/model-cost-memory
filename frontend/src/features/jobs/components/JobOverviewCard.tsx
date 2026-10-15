import { Link } from "react-router-dom";
import type { Job, SpendInsight } from "../../../shared/api/types";
import { Card } from "../../../shared/components/Card";
import { Badge } from "../../../shared/components/Badge";
import { Skeleton } from "../../../shared/components/Skeleton";
import { useRecommendation } from "../../recommendations/hooks/useRecommendation";
import { useJobRegressions } from "../../recommendations/hooks/useJobRegressions";
import { getVerdictChip } from "../../recommendations/components/RecommendationCard";

export function JobOverviewCard({
  job,
  spend,
}: {
  job: Job;
  spend?: SpendInsight;
}) {
  const recQuery = useRecommendation(job.name);
  const regQuery = useJobRegressions(job.name);

  if (recQuery.isPending) {
    return (
      <Card className="flex flex-col justify-between space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-ink">{job.name}</span>
            <Skeleton className="h-5 w-28" />
          </div>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="space-y-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="space-y-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-4 w-20" />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-rule pt-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      </Card>
    );
  }

  const rec = recQuery.data;
  const openAlertsCount =
    regQuery.data?.filter((a) => a.resolved_at === null).length ?? 0;

  return (
    <Card className="flex flex-col justify-between space-y-4">
      <div className="space-y-3">
        {/* Job Name & Verdict Chip */}
        <div className="flex items-start justify-between gap-2">
          <Link
            to={`/jobs/${encodeURIComponent(job.name)}`}
            className="text-base font-bold text-ink hover:text-accent hover:underline"
          >
            {job.name}
          </Link>
          {rec ? (
            <div>{getVerdictChip(rec.verdict)}</div>
          ) : (
            <Badge tone="neutral">No recommendation</Badge>
          )}
        </div>

        {/* Current Model & Spend so far */}
        <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
          <div>
            <span className="text-dim">Current model:</span>
            <div className="font-mono font-semibold text-ink">
              {rec?.current_model || "None"}
            </div>
          </div>
          <div>
            <span className="text-dim">Spend so far:</span>
            <div className="font-mono font-semibold text-ink">
              {spend !== undefined ? `$${spend.spend_usd.toFixed(2)}` : "—"}
            </div>
          </div>
        </div>

        {/* Savings forecast notice */}
        {rec?.forecast && rec.forecast.monthly_saving_usd > 0 && (
          <div className="text-xs font-semibold text-ok">
            Could save ${rec.forecast.monthly_saving_usd.toFixed(2)}/month
          </div>
        )}
      </div>

      {/* Footer: Open alerts count & link */}
      <div className="flex items-center justify-between border-t border-rule pt-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-dim">Alerts:</span>
          {regQuery.isPending ? (
            <Skeleton className="h-4 w-12" />
          ) : openAlertsCount > 0 ? (
            <Badge tone="bad">
              {openAlertsCount} {openAlertsCount === 1 ? "alert" : "alerts"}
            </Badge>
          ) : (
            <span className="text-dim">0 open</span>
          )}
        </div>
        <Link
          to={`/jobs/${encodeURIComponent(job.name)}`}
          className="font-medium text-accent hover:underline"
        >
          View details →
        </Link>
      </div>
    </Card>
  );
}
