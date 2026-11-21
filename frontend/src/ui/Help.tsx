import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** One open bubble at a time: opening one closes the others. */
const OPEN_EVENT = "help-bubble-open";

/**
 * A small "?" button that opens a short explanation in place (the WAI-ARIA toggletip pattern).
 * It never opens by itself, never traps focus, and does not rely on hover, so it works on touch screens.
 */
export function Help({ label = "What does this mean?", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onOther = (e: Event) => {
      if ((e as CustomEvent).detail !== id) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOther);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOther);
    };
  }, [open, id]);

  // Keep the bubble inside the screen: slide it sideways when it would overflow.
  useLayoutEffect(() => {
    if (!open || !bubble.current) {
      setShift(0);
      return;
    }
    const r = bubble.current.getBoundingClientRect();
    const margin = 8;
    const overRight = r.right - (window.innerWidth - margin);
    const overLeft = margin - r.left;
    setShift(overRight > 0 ? -overRight : overLeft > 0 ? overLeft : 0);
  }, [open]);

  const toggle = () => {
    if (!open) window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    setOpen((o) => !o);
  };

  return (
    <span ref={root} className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
        className="grid h-5 w-5 place-items-center rounded-full border border-rule bg-surface-2 text-[11px] font-semibold leading-none text-dim transition hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        ?
      </button>
      {/* The live region stays in the page so the text is announced politely when it appears. */}
      <span role="status" aria-live="polite" className="contents">
        {open && (
          <span
            ref={bubble}
            id={id}
            style={{ transform: `translateX(${shift}px)` }}
            className="absolute left-0 top-full z-30 mt-2 w-64 max-w-[calc(100vw-1rem)] rounded-[12px] border border-rule bg-surface p-3 text-left text-[13px] font-normal normal-case leading-relaxed tracking-normal text-ink shadow-xl"
          >
            {children}
          </span>
        )}
      </span>
    </span>
  );
}
