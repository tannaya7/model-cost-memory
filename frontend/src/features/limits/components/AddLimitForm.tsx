import { useState, type FormEvent } from "react";
import type { UsageLimitInput } from "../../../shared/api/types";
import { Card } from "../../../shared/components/Card";
import { useCreateLimit } from "../hooks/useLimits";

type Measure = UsageLimitInput["measure"];

/** Common shapes, so most people only pick one and fill in when it resets. */
const PRESETS: { id: string; label: string; name: string; hours: number; measure: Measure }[] = [
  { id: "weekly-plan", label: "Plan: weekly limit (shown as %)", name: "Weekly", hours: 168, measure: "PERCENT" },
  { id: "session-plan", label: "Plan: 5-hour session (shown as %)", name: "Session (5h)", hours: 5, measure: "PERCENT" },
  { id: "model-plan", label: "Plan: one model's limit (shown as %)", name: "Model limit", hours: 168, measure: "PERCENT" },
  { id: "monthly-budget", label: "API: monthly spend budget ($)", name: "Monthly budget", hours: 720, measure: "USD" },
  { id: "daily-requests", label: "API: daily request quota", name: "Daily requests", hours: 24, measure: "REQUESTS" },
  { id: "custom", label: "Custom", name: "", hours: 24, measure: "USD" },
];

const MEASURES: { id: Measure; label: string }[] = [
  { id: "PERCENT", label: "Percent, as the plan shows it" },
  { id: "USD", label: "Dollars (at list price)" },
  { id: "TOKENS", label: "Tokens" },
  { id: "REQUESTS", label: "Requests" },
];

function localInputValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function AddLimitForm({ onDone }: { onDone?: () => void }) {
  const create = useCreateLimit();
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [name, setName] = useState(PRESETS[0].name);
  const [hours, setHours] = useState(String(PRESETS[0].hours));
  const [measure, setMeasure] = useState<Measure>(PRESETS[0].measure);
  const [size, setSize] = useState("");
  const [model, setModel] = useState("");
  const [usedPercent, setUsedPercent] = useState("");
  const [resetsAt, setResetsAt] = useState(localInputValue(new Date(Date.now() + 24 * 3_600_000)));

  function choose(id: string) {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0];
    setPreset(id);
    setName(p.name);
    setHours(String(p.hours));
    setMeasure(p.measure);
  }

  const isPercent = measure === "PERCENT";
  const canSave =
    name.trim() !== "" && Number(hours) > 0 && resetsAt !== "" && (isPercent ? usedPercent !== "" : Number(size) > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    await create.mutateAsync({
      name: name.trim(),
      window_hours: Math.round(Number(hours)),
      resets_at: new Date(resetsAt).toISOString(),
      measure,
      size: isPercent ? null : Number(size),
      model: model.trim() || null,
      used_percent: isPercent ? Number(usedPercent) : null,
    });
    setSize("");
    setUsedPercent("");
    onDone?.();
  }

  const field =
    "mt-1 w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h3 className="text-base font-bold tracking-tight text-ink">Add a limit</h3>
        <p className="mt-1 text-xs text-dim">
          Plans that only show a percentage are measured from your recorded runs and your reading of the bar, so
          use made outside the recorded runs is not seen.
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-ink sm:col-span-2">
          Kind
          <select value={preset} onChange={(e) => choose(e.target.value)} className={field}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className="text-sm text-ink">
          Resets at
          <input type="datetime-local" value={resetsAt} onChange={(e) => setResetsAt(e.target.value)} className={field} />
        </label>
        <label className="text-sm text-ink">
          Window (hours)
          <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} className={field} />
        </label>
        <label className="text-sm text-ink">
          Measured in
          <select value={measure} onChange={(e) => setMeasure(e.target.value as Measure)} className={field}>
            {MEASURES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {isPercent ? (
          <label className="text-sm text-ink">
            Used now (%)
            <input
              inputMode="decimal"
              value={usedPercent}
              onChange={(e) => setUsedPercent(e.target.value)}
              placeholder="80"
              className={field}
            />
          </label>
        ) : (
          <label className="text-sm text-ink">
            Size of the limit
            <input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} className={field} />
          </label>
        )}
        <label className="text-sm text-ink">
          Only for one model (optional)
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. fable-5-1" className={field} />
        </label>
        {create.isError && (
          <p role="alert" className="text-sm text-bad sm:col-span-2">
            {create.error instanceof Error ? create.error.message : "Could not save the limit."}
          </p>
        )}
        <div className="flex justify-end sm:col-span-2">
          <button
            type="submit"
            disabled={!canSave || create.isPending}
            className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {create.isPending ? "Saving…" : "Add limit"}
          </button>
        </div>
      </form>
    </Card>
  );
}
