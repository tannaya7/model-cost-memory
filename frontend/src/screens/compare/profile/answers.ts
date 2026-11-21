import type { Answers, Need, Priority, Profile, Task } from "./types";

export const TASKS: { value: Task; label: string }[] = [
  { value: "coding", label: "Heavy coding" },
  { value: "extraction", label: "Extracting data from documents" },
  { value: "support", label: "Support chat" },
  { value: "summarising", label: "Summarising" },
  { value: "classification", label: "Classification or tagging" },
  { value: "agents", label: "Agents that use tools (MCP)" },
  { value: "long-documents", label: "Long documents" },
  { value: "reasoning", label: "Reasoning or maths" },
];
export const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "cost", label: "Lowest cost" },
  { value: "quality", label: "Highest quality" },
  { value: "speed", label: "Speed" },
  { value: "balanced", label: "Balanced" },
];
export const NEEDS: { value: Need; label: string }[] = [
  { value: "long-inputs", label: "Very long inputs" },
  { value: "images", label: "Images" },
  { value: "tool-use", label: "Tool use" },
  { value: "privacy", label: "Privacy or data location" },
];

/** Where the answers live in this browser. `job` is null before the project has a task to attach them to. */
export const profileKey = (project: string, job: string | null) => (job === null ? `mcm_profile_${project}` : `mcm_profile_${project}_${job}`);

/** No task, no priority, no need and no budget: nothing was actually answered. */
export const isEmpty = (a: Answers) => a.tasks.length === 0 && a.priority === null && a.needs.length === 0 && a.budgetUsd === null;

export const NO_ANSWERS: Answers = { tasks: [], priority: null, needs: [], budgetUsd: null };

const has = <T extends string>(list: { value: T }[], v: unknown): v is T => list.some((x) => x.value === v);

/** Older saves also held a team-size answer and always a priority; both are read, and the team size is dropped. */
function answers(a: unknown): Answers | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const ok =
    (o.priority === null || o.priority === undefined || has(PRIORITIES, o.priority)) &&
    Array.isArray(o.tasks) && o.tasks.every((t) => has(TASKS, t)) &&
    Array.isArray(o.needs) && o.needs.every((n) => has(NEEDS, n)) &&
    (o.budgetUsd === null || o.budgetUsd === undefined || (typeof o.budgetUsd === "number" && Number.isFinite(o.budgetUsd) && o.budgetUsd >= 0));
  if (!ok) return null;
  return { tasks: o.tasks as Task[], priority: (o.priority ?? null) as Priority | null, needs: o.needs as Need[], budgetUsd: (o.budgetUsd ?? null) as number | null };
}

/** What is saved: nothing, a skip, or answers. Damaged or blocked storage reads as nothing, never as an error. */
export function readProfile(project: string, job: string | null): Profile {
  try {
    const raw = localStorage.getItem(profileKey(project, job));
    if (!raw) return { state: "none" };
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).skipped === true) return { state: "skipped" };
    const a = answers(parsed);
    return a && !isEmpty(a) ? { state: "answered", answers: a } : { state: "none" };
  } catch {
    return { state: "none" };
  }
}

/** Saves the answers, or a skip when nothing was answered. Returns false when storage is blocked (it still works for this visit). */
export function saveProfile(project: string, job: string | null, a: Answers): boolean {
  try {
    localStorage.setItem(profileKey(project, job), JSON.stringify(isEmpty(a) ? { skipped: true } : a));
    return true;
  } catch {
    return false;
  }
}

export function skipProfile(project: string, job: string | null): boolean {
  try {
    localStorage.setItem(profileKey(project, job), JSON.stringify({ skipped: true }));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the answers and the skip: the next visit asks again. */
export function clearProfile(project: string, job: string | null): boolean {
  try {
    localStorage.removeItem(profileKey(project, job));
    return true;
  } catch {
    return false;
  }
}
