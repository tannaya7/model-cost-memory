import { Link } from "react-router-dom";
import { Badge } from "../../../shared/components/Badge";
import type { FlowEvent } from "../types";

function getStageBadge(stage: string, message: string, data: Record<string, unknown> | null) {
  const norm = stage.toLowerCase();
  const isFail =
    norm === "check" &&
    (message.toLowerCase().includes("fail") || data?.outcome === "FAIL");

  if (isFail) {
    return <Badge tone="bad">check (fail)</Badge>;
  }

  switch (norm) {
    case "sdk":
      return <Badge tone="neutral">sdk</Badge>;
    case "api":
      return <Badge tone="neutral">api</Badge>;
    case "check":
      return <Badge tone="ok">check</Badge>;
    case "index":
      return <Badge tone="accent">index</Badge>;
    case "consolidate":
      return <Badge tone="ok">consolidate</Badge>;
    default:
      return <Badge tone="neutral">{norm}</Badge>;
  }
}

export function FlowEventList({ events }: { events: FlowEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-rule bg-surface p-12 text-center text-sm text-dim">
        Waiting for stream events...
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card border border-rule bg-surface">
      <table className="w-full min-w-[600px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-rule bg-bg text-xs font-semibold uppercase tracking-wider text-dim">
            <th className="px-4 py-3 w-28">Time</th>
            <th className="px-4 py-3 w-32">Stage</th>
            <th className="px-4 py-3 w-36">Run ID</th>
            <th className="px-4 py-3">Message</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule font-mono text-xs">
          {events.map((ev) => {
            const timeStr = new Date(ev.ts).toLocaleTimeString(undefined, {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });

            const shortRun = ev.run_id ? ev.run_id.slice(0, 12) : null;
            const jobName =
              ev.data && typeof ev.data.job === "string" ? ev.data.job : null;

            return (
              <tr key={ev.event_id} className="hover:bg-bg/50 transition-colors">
                <td className="px-4 py-2.5 text-dim whitespace-nowrap">
                  {timeStr}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  {getStageBadge(ev.stage, ev.message, ev.data)}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  {shortRun ? (
                    jobName ? (
                      <Link
                        to={`/runs?job=${encodeURIComponent(jobName)}`}
                        className="text-accent hover:underline font-semibold"
                        title={`View runs for ${jobName}`}
                      >
                        {shortRun}
                      </Link>
                    ) : (
                      <span className="text-ink">{shortRun}</span>
                    )
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-sans text-xs text-ink">
                  {ev.message}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
