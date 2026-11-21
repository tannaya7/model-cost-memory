import { useProject as useScope } from "../../../app/project";
import { usePatchProject, useProject } from "./useProjects";

export type BillingMode = "per_use" | "subscription" | "both";

export const BILLING_MODES: BillingMode[] = ["per_use", "subscription", "both"];

/**
 * How the signed-in owner's project pays for AI. Anyone without an owned project (the public demo, a
 * project key) sees "per_use", which is exactly how every project behaved before this choice existed.
 */
export function useBillingMode(): { mode: BillingMode; canEdit: boolean; ready: boolean } {
  const scope = useScope();
  const owned = scope.mode === "owned" ? scope.id : "";
  const query = useProject(owned || undefined);
  const raw = query.data?.billing_mode;
  const mode: BillingMode = raw === "subscription" || raw === "both" ? raw : "per_use";
  return { mode, canEdit: Boolean(owned), ready: !owned || !query.isPending };
}

export function useSetBillingMode() {
  return usePatchProject();
}
