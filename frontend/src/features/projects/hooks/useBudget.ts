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

/** Plain-words check of a typed limit. Returns the number, or an error message. */
export function parseBudget(text: string): { value: number } | { error: string } {
  const v = Number(text.replace(/[$,\s]/g, ""));
  if (!text.trim() || !Number.isFinite(v) || v <= 0) return { error: "Type an amount above zero, like 500." };
  if (v > 10_000_000) return { error: "That is too high. Use $10,000,000 or less." };
  return { value: Math.round(v * 100) / 100 };
}
