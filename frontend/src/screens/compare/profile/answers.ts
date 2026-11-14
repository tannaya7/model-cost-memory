import type { Answers, Need, People, Priority, Task } from "./types";

export const PEOPLE: { value: People; label: string }[] = [
  { value: "1", label: "Just me" },
  { value: "2-10", label: "2 to 10" },
  { value: "11-50", label: "11 to 50" },
  { value: "50+", label: "More than 50" },
];
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

export const profileKey = (project: string, job: string) => `mcm_profile_${project}_${job}`;

const has = <T extends string>(list: { value: T }[], v: unknown): v is T => list.some((x) => x.value === v);

function valid(a: unknown): a is Answers {
  if (!a || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  return (
    has(PEOPLE, o.people) &&
    has(PRIORITIES, o.priority) &&
    Array.isArray(o.tasks) && o.tasks.every((t) => has(TASKS, t)) &&
    Array.isArray(o.needs) && o.needs.every((n) => has(NEEDS, n)) &&
    (o.budgetUsd === null || (typeof o.budgetUsd === "number" && Number.isFinite(o.budgetUsd) && o.budgetUsd >= 0))
  );
}

/** The saved answers for a job, or null (nothing saved, damaged, or storage blocked). */
export function readAnswers(project: string, job: string): Answers | null {
  try {
    const raw = localStorage.getItem(profileKey(project, job));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Saves the answers; returns false when storage is blocked (the answers still work for this visit). */
export function writeAnswers(project: string, job: string, answers: Answers): boolean {
  try {
    localStorage.setItem(profileKey(project, job), JSON.stringify(answers));
    return true;
  } catch {
    return false;
  }
}
