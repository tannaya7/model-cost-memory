/** Keyboard behaviour every modal dialog needs: focus moves in when it opens, Tab stays inside, Escape closes,
 * and focus goes back to whatever opened it. Put the returned ref on the dialog element (give it tabIndex={-1}). */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useModalFocus<T extends HTMLElement>(open: boolean, onClose: () => void, initialFocus?: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const items = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        return close.current();
      }
      if (e.key !== "Tab") return;
      const list = items();
      const panel = ref.current;
      if (!panel) return;
      if (list.length === 0) return e.preventDefault();
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && panel.contains(active) && active !== panel;
      if (e.shiftKey && (!inside || active === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const target = (initialFocus ? ref.current?.querySelector<HTMLElement>(initialFocus) : null) ?? ref.current;
    target?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open, initialFocus]);

  return ref;
}
