import { useState, type FormEvent } from "react";
import { Button, cx } from "../../../ui/primitives";
import { NEEDS, PEOPLE, PRIORITIES, TASKS } from "./answers";
import type { Answers, Need, People, Priority, Task } from "./types";

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

const chip = (on: boolean) =>
  cx(
    "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
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

export function Questionnaire({ initial, defaultBudget, onSubmit }: { initial: Answers | null; defaultBudget: number | null; onSubmit: (a: Answers) => void }) {
  const [people, setPeople] = useState<People>(initial?.people ?? "1");
  const [tasks, setTasks] = useState<Task[]>(initial?.tasks ?? []);
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "balanced");
  const [needs, setNeeds] = useState<Need[]>(initial?.needs ?? []);
  const start = initial ? initial.budgetUsd : defaultBudget;
  const [budget, setBudget] = useState(start === null ? "" : String(start));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = budget.trim() === "" ? null : Number(budget);
    onSubmit({ people, tasks, priority, needs, budgetUsd: v !== null && Number.isFinite(v) && v >= 0 ? v : null });
  };

  return (
    <form onSubmit={submit} className="space-y-5" aria-label="Questions about your work">
      <Group title="1. How many people use the AI?">
        {PEOPLE.map((o) => (
          <label key={o.value} className={chip(people === o.value)}>
            <input type="radio" name="people" className="sr-only" checked={people === o.value} onChange={() => setPeople(o.value)} />
            {o.label}
          </label>
        ))}
      </Group>
      <Group title="2. What is the work?" hint="Choose all that apply.">
        {TASKS.map((o) => (
          <label key={o.value} className={chip(tasks.includes(o.value))}>
            <input type="checkbox" className="sr-only" checked={tasks.includes(o.value)} onChange={() => setTasks(toggle(tasks, o.value))} />
            {o.label}
          </label>
        ))}
      </Group>
      <Group title="3. What matters most?">
        {PRIORITIES.map((o) => (
          <label key={o.value} className={chip(priority === o.value)}>
            <input type="radio" name="priority" className="sr-only" checked={priority === o.value} onChange={() => setPriority(o.value)} />
            {o.label}
          </label>
        ))}
      </Group>
      <Group title="4. Any special needs?" hint="Choose all that apply.">
        {NEEDS.map((o) => (
          <label key={o.value} className={chip(needs.includes(o.value))}>
            <input type="checkbox" className="sr-only" checked={needs.includes(o.value)} onChange={() => setNeeds(toggle(needs, o.value))} />
            {o.label}
          </label>
        ))}
      </Group>
      <div className="space-y-2">
        <label htmlFor="profile-budget" className="text-sm font-semibold text-ink">5. Monthly budget (US dollars)</label>
        <p className="text-xs text-muted">Leave empty if you have none.</p>
        <input
          id="profile-budget"
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          className="w-40 rounded-[10px] border border-rule-strong bg-surface-2 px-3 py-2 text-sm text-ink"
        />
      </div>
      <Button type="submit" variant="primary">Show suggestions</Button>
    </form>
  );
}
