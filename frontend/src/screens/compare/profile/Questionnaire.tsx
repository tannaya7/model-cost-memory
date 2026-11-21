import { useState, type FormEvent } from "react";
import { Button, cx } from "../../../ui/primitives";
import { NEEDS, PRIORITIES, TASKS } from "./answers";
import type { Answers, Need, Priority, Task } from "./types";

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

const chip = (on: boolean) =>
  cx(
    "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
    on ? "border-accent bg-accent-soft text-accent" : "border-rule-strong bg-surface-2 text-dim hover:bg-surface-3",
  );

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold text-ink">{title}</legend>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

/** Every question is optional. Nothing is preselected, so an answer on file is always something the person chose.
 * "Skip for now" saves nothing and "Clear my answers" forgets what was saved. */
export function Questionnaire({
  initial, defaultBudget, onSubmit, onSkip, onClear, onCancel,
}: {
  initial: Answers | null;
  defaultBudget: number | null;
  onSubmit: (a: Answers) => void;
  onSkip: () => void;
  onClear?: () => void;
  onCancel?: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>(initial?.tasks ?? []);
  const [priority, setPriority] = useState<Priority | null>(initial?.priority ?? null);
  const [needs, setNeeds] = useState<Need[]>(initial?.needs ?? []);
  const start = initial ? initial.budgetUsd : defaultBudget;
  const [budget, setBudget] = useState(start === null ? "" : String(start));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = budget.trim() === "" ? null : Number(budget);
    onSubmit({ tasks, priority, needs, budgetUsd: v !== null && Number.isFinite(v) && v >= 0 ? v : null });
  };

  return (
    <form onSubmit={submit} className="space-y-5" aria-label="Questions about your work">
      <p className="text-sm text-dim" data-testid="why-we-ask">
        All optional. Your answers only help us pick which models to read about, and in what order. They do not show how any model performs on your work, and nothing here is measured until your own calls are checked.
      </p>
      <Group title="1. What is the work?" hint="Choose any that apply, or none.">
        {TASKS.map((o) => (
          <label key={o.value} className={chip(tasks.includes(o.value))}>
            <input type="checkbox" className="sr-only" checked={tasks.includes(o.value)} onChange={() => setTasks(toggle(tasks, o.value))} />
            {o.label}
          </label>
        ))}
      </Group>
      <Group title="2. What matters most?" hint="Pick one, or leave it. Choose it again to take it back.">
        {PRIORITIES.map((o) => (
          <button key={o.value} type="button" aria-pressed={priority === o.value} onClick={() => setPriority(priority === o.value ? null : o.value)} className={chip(priority === o.value)}>
            {o.label}
          </button>
        ))}
      </Group>
      <Group title="3. Any special needs?" hint="Choose any that apply, or none.">
        {NEEDS.map((o) => (
          <label key={o.value} className={chip(needs.includes(o.value))}>
            <input type="checkbox" className="sr-only" checked={needs.includes(o.value)} onChange={() => setNeeds(toggle(needs, o.value))} />
            {o.label}
          </label>
        ))}
      </Group>
      <div className="space-y-2">
        <label htmlFor="profile-budget" className="text-sm font-semibold text-ink">4. Monthly budget (US dollars)</label>
        <p className="text-xs text-muted">Leave empty if you have none. It only marks which models fit it.</p>
        <input
          id="profile-budget"
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="w-40 rounded-[10px] border border-rule-strong bg-surface-2 px-3 py-2 text-sm text-ink"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary">Show models to read about</Button>
        <Button type="button" onClick={onSkip}>Skip for now</Button>
        {onCancel && <Button type="button" onClick={onCancel}>Cancel</Button>}
        {onClear && <Button type="button" onClick={onClear}>Clear my answers</Button>}
      </div>
    </form>
  );
}
