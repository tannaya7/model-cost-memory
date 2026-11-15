/** Which first-visit guides this person has already seen. Saved on their account (so a new browser does
 * not show them again) and mirrored in this browser, so it still works when the server cannot be reached. */
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../shared/api/apiFetch";
import type { User } from "../../shared/api/types";
import { meKey, useMe } from "../auth/hooks/useAuth";
import type { GuideFlags } from "./steps";

const KEYS = ["tour_seen", "first_results_seen"] as const;
export type GuideFlag = (typeof KEYS)[number];

const storageKey = (userId: string) => `mcm_guide_${userId}`;

export function readLocal(userId: string): GuideFlags {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "{}") as Record<string, unknown>;
    const out: GuideFlags = {};
    for (const k of KEYS) if (raw[k] === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

export function writeLocal(userId: string, flags: GuideFlags) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(flags));
  } catch {
    /* kept for this visit only */
  }
}

/** The server's answer wins where it says yes; this browser's note covers a failed save. */
export function mergeFlags(server: GuideFlags | null | undefined, local: GuideFlags): GuideFlags {
  const out: GuideFlags = {};
  for (const k of KEYS) if (server?.[k] === true || local[k] === true) out[k] = true;
  return out;
}

export function saveFlags(patch: GuideFlags): Promise<unknown> {
  return apiFetch("/v1/me/ui-flags", { method: "PATCH", body: JSON.stringify(patch) });
}

type MeWithFlags = User & { ui_flags?: GuideFlags | null };

export function useGuideFlags() {
  const me = useMe();
  const client = useQueryClient();
  const user = me.data as MeWithFlags | undefined;
  const userId = user?.user_id;
  const flags = useMemo(() => (userId ? mergeFlags(user?.ui_flags, readLocal(userId)) : {}), [user, userId]);

  /** Sets a flag to true or false right away; the server save happens behind it and may fail quietly. */
  const set = useCallback(
    (flag: GuideFlag, value: boolean) => {
      if (!userId) return;
      const next: GuideFlags = { ...readLocal(userId), [flag]: value };
      if (!value) delete next[flag];
      writeLocal(userId, next);
      client.setQueryData<MeWithFlags>(meKey, (old) => (old ? { ...old, ui_flags: { ...(old.ui_flags ?? {}), [flag]: value } } : old));
      saveFlags({ [flag]: value }).catch(() => undefined);
    },
    [userId, client],
  );

  return { loaded: Boolean(userId), flags, set };
}
