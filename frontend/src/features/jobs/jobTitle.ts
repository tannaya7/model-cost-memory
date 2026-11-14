/** A friendly title for a task, made from the name used in code: "invoice-extract" -> "Invoice extract". */
export function jobTitle(name: string): string {
  const words = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The one-time explanation shown wherever a task first appears. */
export const TASK_EXPLAINER =
  "An AI task is one kind of work your app asks an AI to do, like reading invoices or sorting support tickets. We judge each task on its own.";
