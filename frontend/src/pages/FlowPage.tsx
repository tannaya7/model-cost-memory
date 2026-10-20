import { useState, useEffect, useRef } from "react";
import { PageHeader } from "../shared/components/PageHeader";
import { subscribeToFlow } from "../features/flow/api/flowSubscription";
import { FlowStepPipeline } from "../features/flow/components/FlowStepPipeline";
import { FlowEventList } from "../features/flow/components/FlowEventList";
import type { FlowConnectionStatus, FlowEvent } from "../features/flow/types";

export default function FlowPage() {
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [status, setStatus] = useState<FlowConnectionStatus>("live");
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [isCheckFailed, setIsCheckFailed] = useState<boolean>(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const isPausedRef = useRef(isPaused);
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    const unsubscribe = subscribeToFlow(
      (ev) => {
        if (!isPausedRef.current) {
          setEvents((prev) => [ev, ...prev].slice(0, 50));
          setCurrentStage(ev.stage);
          setActiveRunId(ev.run_id);
          const isFail =
            ev.stage.toLowerCase() === "check" &&
            (ev.message.toLowerCase().includes("fail") ||
              ev.data?.outcome === "FAIL");
          setIsCheckFailed(isFail);
        }
      },
      (newStatus) => {
        setStatus(newStatus);
      },
    );

    return () => {
      unsubscribe();
    };
  }, []);

  const getStatusDisplay = () => {
    switch (status) {
      case "live":
        return {
          label: "Live",
          dotColor: "bg-ok",
          textColor: "text-ok",
        };
      case "reconnecting":
        return {
          label: "Reconnecting…",
          dotColor: "bg-warn",
          textColor: "text-warn",
        };
      case "polling":
        return {
          label: "Polling every 2 s",
          dotColor: "bg-warn",
          textColor: "text-warn",
        };
    }
  };

  const statusInfo = getStatusDisplay();

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title="Live flow"
        subtitle="Watch each run move through the system as it happens."
        actions={
          <div className="flex items-center gap-3">
            {/* Status Indicator */}
            <div className="inline-flex items-center gap-2 rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold">
              <span
                className={`h-2 w-2 rounded-full ${statusInfo.dotColor} animate-pulse`}
              />
              <span className={statusInfo.textColor}>{statusInfo.label}</span>
            </div>

            {/* Pause / Resume Button */}
            <button
              type="button"
              onClick={() => setIsPaused((p) => !p)}
              className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-bg transition-colors cursor-pointer"
            >
              {isPaused ? "▶ Resume" : "⏸ Pause"}
            </button>
          </div>
        }
      />

      {/* Step Pipeline Visualization */}
      <FlowStepPipeline
        currentStage={currentStage}
        isCheckFailed={isCheckFailed}
        activeRunId={activeRunId}
      />

      {/* Live Events Table */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-dim">
          <span className="font-semibold uppercase tracking-wider">
            Live Stream Feed ({events.length} / 50 events)
          </span>
          {isPaused && (
            <span className="font-semibold text-warn">
              Feed paused (connection kept open)
            </span>
          )}
        </div>
        <FlowEventList events={events} />
      </div>
    </div>
  );
}
