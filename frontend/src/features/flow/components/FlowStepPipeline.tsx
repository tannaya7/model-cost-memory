import { Card } from "../../../shared/components/Card";

const STEPS = [
  { id: "sdk", label: "SDK", desc: "Run recorded" },
  { id: "api", label: "API", desc: "Ingest & queue" },
  { id: "check", label: "Check", desc: "Verify outcome" },
  { id: "index", label: "Index", desc: "Metrics & cost" },
  { id: "consolidate", label: "Consolidate", desc: "Recommendation" },
];

export function FlowStepPipeline({
  currentStage,
  isCheckFailed = false,
  activeRunId,
}: {
  currentStage: string | null;
  isCheckFailed?: boolean;
  activeRunId: string | null;
}) {
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-dim">
          Run Lifecycle Stages
        </h3>
        {activeRunId && (
          <span className="text-xs font-mono text-dim">
            Active run: <span className="text-ink font-bold">{activeRunId}</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
        {STEPS.map((step, idx) => {
          const isActive = currentStage?.toLowerCase() === step.id;
          const isFailedStep = step.id === "check" && isCheckFailed;

          return (
            <div
              key={step.id}
              className={`relative rounded-md border p-3.5 transition-all duration-200 flex flex-col justify-between ${
                isActive && isFailedStep
                  ? "border-bad bg-bad-soft text-bad shadow-xs"
                  : isActive
                    ? "border-accent bg-accent-soft text-accent shadow-xs"
                    : "border-rule bg-surface text-dim"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold">0{idx + 1}</span>
                {isActive && (
                  <span
                    className={`h-2 w-2 rounded-full animate-pulse ${
                      isFailedStep ? "bg-bad" : "bg-accent"
                    }`}
                  />
                )}
              </div>
              <div className="mt-2">
                <div
                  className={`text-sm font-bold ${
                    isActive
                      ? isFailedStep
                        ? "text-bad"
                        : "text-accent"
                      : "text-ink"
                  }`}
                >
                  {step.label}
                </div>
                <div className="text-xs text-dim mt-0.5">{step.desc}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
