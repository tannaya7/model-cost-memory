/** The first-visit tour: a small card that points at real parts of the app, one at a time.
 * It never blocks the page (the dimming does not catch clicks), can be skipped at any step or with Esc,
 * keeps keyboard focus on its own buttons, and turns into a bottom sheet when what it points at is hidden. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { Button, cx } from "../../ui/primitives";
import { FIRST_CALL_SNIPPET } from "./snippet";
import { nextStep, TOUR_STEPS, type TourStep } from "./steps";

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The first marked element that is actually on screen (the phone and the desktop each mark their own). */
export function findTarget(name: string | undefined, root: ParentNode = document): HTMLElement | null {
  if (!name) return null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

const PAD = 6;

function boxOf(el: HTMLElement | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

/** Where the card goes: next to a sidebar item, above a bottom-bar item, a sheet along the bottom when the
 * target is hidden, or in the middle for a step that points at nothing. */
export type Placement = "side" | "above" | "sheet" | "center";
export function placementFor(box: Box | null, hasTarget: boolean, viewport: { w: number; h: number }): Placement {
  if (!hasTarget) return viewport.w >= 768 ? "center" : "sheet";
  if (!box) return "sheet";
  if (viewport.w >= 768 && box.left < viewport.w * 0.4) return "side";
  return box.top > viewport.h / 2 ? "above" : "sheet";
}

export function Tour({ open, onClose }: { open: boolean; onClose: (finished: boolean) => void }) {
  const p = useP();
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [copied, setCopied] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const step: TourStep = TOUR_STEPS[at];

  useEffect(() => {
    if (open) setAt(0);
  }, [open]);

  const measure = useCallback(() => setBox(boxOf(findTarget(step.target))), [step.target]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  // Focus goes to the card when it opens and on each step, and back to where it was when it closes.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, [open]);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, at]);

  const go = (dir: 1 | -1) => {
    const to = nextStep(at, dir);
    if (to === null) onClose(true);
    else setAt(to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose(false);
      return;
    }
    if (e.key !== "Tab" || !card.current) return;
    const items = Array.from(card.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), [tabindex='0']"));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === heading.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const placement = placementFor(box, Boolean(step.target), viewport);
  const style: React.CSSProperties = {};
  if (placement === "side" && box) {
    style.left = Math.min(box.left + box.width + 16, viewport.w - 360);
    style.top = Math.max(12, Math.min(box.top, viewport.h - 400));
  } else if (placement === "above" && box) {
    style.bottom = viewport.h - box.top + 12;
  }
  const lastStep = at === TOUR_STEPS.length - 1;

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]" onKeyDown={onKeyDown}>
      {/* The dimming leaves a hole around the real element and lets clicks through, so the page stays usable. */}
      {box ? (
        <div
          aria-hidden
          data-testid="tour-spotlight"
          className="absolute rounded-[12px] ring-2 ring-accent transition-all duration-200 motion-reduce:transition-none"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)" }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-black/55" />
      )}
      <div role="status" aria-live="polite" className="sr-only">
        Step {at + 1} of {TOUR_STEPS.length}: {step.title}. {step.body}
      </div>
      <div
        ref={card}
        role="dialog"
        aria-label="Quick tour"
        style={style}
        className={cx(
          "pointer-events-auto absolute flex max-h-[85vh] flex-col gap-3 overflow-y-auto rounded-[16px] border border-rule-strong bg-surface-2 p-5 text-ink shadow-2xl",
          placement === "center" && "left-1/2 top-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
          placement === "side" && "w-[min(21rem,calc(100vw-2rem))]",
          placement === "above" && "inset-x-3",
          placement === "sheet" && "inset-x-0 bottom-0 rounded-b-none",
        )}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Step {at + 1} of {TOUR_STEPS.length}</p>
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none">
          {step.title}
        </h2>
        <p className="text-sm text-dim">{step.body}</p>
        {step.code && (
          <div className="flex flex-col gap-2">
            <pre tabIndex={0} aria-label="Example code" className="overflow-x-auto rounded-[10px] border border-rule bg-bg p-3 font-mono text-[11.5px] leading-relaxed text-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{FIRST_CALL_SNIPPET}</pre>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(FIRST_CALL_SNIPPET);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  } catch {
                    /* the text stays selectable */
                  }
                }}
              >
                {copied ? "Copied" : "Copy the code"}
              </Button>
              <Link to={p("/settings#keys")} onClick={() => onClose(false)} className="inline-flex items-center rounded-[10px] px-2 py-1.5 text-xs font-semibold text-accent-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                Find your project key
              </Link>
            </div>
          </div>
        )}
        <p className="rounded-[10px] bg-surface-3 px-3 py-2 text-[13px] text-dim">{step.later}</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <button type="button" onClick={() => onClose(false)} className="rounded-[8px] px-2 py-1.5 text-sm font-medium text-muted hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
            Skip the tour
          </button>
          <div className="flex gap-2">
            {at > 0 && <Button onClick={() => go(-1)}>Back</Button>}
            <Button variant="primary" onClick={() => go(1)}>{lastStep ? "Done" : "Next"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
