import { useProject as useScope } from "../../../app/project";
import { ApiError } from "../../../shared/api/apiFetch";
import { usePatchProject, useProject } from "./useProjects";

/** The most a person wants the project's AI calls to cost each month, kept on their account. */
export function useMonthlyBudget() {
  const scope = useScope();
  const owned = scope.mode === "owned" ? scope.id : "";
  const query = useProject(owned || undefined);
  const patch = usePatchProject();
  return {
    canEdit: Boolean(owned),
    projectId: owned,
    ready: !owned || !query.isPending,
    budget: query.data?.monthly_budget_usd ?? null,
    saving: patch.isPending,
    /** Saves a limit, or clears it with null. Resolves to an error message, or null when it worked. */
    save: async (value: number | null): Promise<string | null> => {
      try {
        await patch.mutateAsync({ id: owned, input: { monthly_budget_usd: value } });
        return null;
      } catch (e) {
        return e instanceof ApiError || e instanceof Error ? e.message : "Could not save";
      }
    },
  };
}

export const BUDGET_MAX = 1_000_000;
const BAD_FORMAT = "Use numbers only, like 500 or 1,200.50.";

/** Plain-words check of a typed limit. Accepts a pasted "$1,200.50"; returns the number (to the cent), or an error message. */
export function parseBudget(text: string): { value: number } | { error: string } {
  const t = text.replace(/[$\s]/g, "");
  if (!t) return { error: "Type an amount above zero, like 500." };
  if (t.startsWith("-")) return { error: "Type an amount above zero, like 500." };
  // Commas may only be thousands separators, so "1.200,50" is refused instead of read as 1.2.
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^\.\d+$/.test(t)) return { error: BAD_FORMAT };
  const v = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(v) || v <= 0) return { error: "Type an amount above zero, like 500." };
  if (v > BUDGET_MAX) return { error: "That is too high. Use $1,000,000 or less." };
  const cents = Math.round(v * 100) / 100;
  if (cents <= 0) return { error: "Type an amount above zero, like 500." };
  return { value: cents };
}
