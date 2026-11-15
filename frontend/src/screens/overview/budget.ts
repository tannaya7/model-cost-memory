/** The monthly spending limit now lives on the account (the project's monthly_budget_usd).
 * These two helpers only find and clear a limit an earlier version saved in this browser. */
const key = (project: string) => `mcm_budget_${project}`;

export function readBrowserBudget(project: string): number | null {
  try {
    const v = Number(localStorage.getItem(key(project)));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function clearBrowserBudget(project: string) {
  try {
    localStorage.removeItem(key(project));
  } catch {
    /* nothing to clear */
  }
}
