/** A monthly spend budget the person sets for a project. Kept in this browser only. */
const key = (project: string) => `mcm_budget_${project}`;

export function readBudget(project: string): number | null {
  try {
    const v = Number(localStorage.getItem(key(project)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeBudget(project: string, value: number | null) {
  try {
    if (value === null) localStorage.removeItem(key(project));
    else localStorage.setItem(key(project), String(value));
  } catch {
    /* kept for this visit */
  }
}
