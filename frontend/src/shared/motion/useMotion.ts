/** How much motion this person wants. Follows the operating system's "reduce motion" setting unless they chose for themselves.
 *  The choice is a per-browser convenience (localStorage); the page works the same when it cannot be read or written. */
import { useCallback, useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

export type MotionChoice = "auto" | "full" | "calm";

const KEY = "mcm-motion";
const EVENT = "mcm-motion-change";

/** The choice made on this page, kept in memory too: when the browser blocks storage (a private window) it still lasts until the page closes. */
let session: MotionChoice | null = null;

/** Test hook: forget the choice held in memory. */
export function resetMotionSession(): void {
  session = null;
}

export function readMotionChoice(): MotionChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "full" || v === "calm" ? v : (session ?? "auto");
  } catch {
    return session ?? "auto";
  }
}

export function useMotion() {
  const os = useReducedMotion();
  const [choice, setChoice] = useState<MotionChoice>(readMotionChoice);

  useEffect(() => {
    const sync = () => setChoice(readMotionChoice());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const set = useCallback((next: MotionChoice) => {
    session = next === "auto" ? null : next;
    try {
      if (next === "auto") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      /* private window or blocked storage: the choice just lasts until the page is closed */
    }
    setChoice(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  const calm = choice === "calm" || (choice === "auto" && Boolean(os));
  return { calm, choice, set };
}
