/** The "Unsaved changes" bar at the bottom of a settings section. It sits in the page flow (never over
 * content or the phone keyboard), appears only while the section differs from what is saved, and offers
 * Apply and Discard. While it shows, leaving the page asks first. */
import { useContext, useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router-dom";
import { Button } from "./primitives";

/** The in-app part of the leave guard; only works inside a data router, so it is mounted only there. */
function RouteGuard() {
  const blocker = useBlocker(true);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("You have changes that are not applied. Leave without applying them?")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  return null;
}

/** Every bar with unsaved changes registers here, so leaving the page asks ONCE however many sections are
 * dirty: the first registered bar owns the page-leave and tab-close guards. */
const dirtyOwners: string[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const firstOwner = () => dirtyOwners[0] ?? null;

function useIsGuardOwner(id: string, dirty: boolean): boolean {
  useEffect(() => {
    if (!dirty) return;
    dirtyOwners.push(id);
    emit();
    return () => {
      dirtyOwners.splice(dirtyOwners.indexOf(id), 1);
      emit();
    };
  }, [id, dirty]);
  return useSyncExternalStore(subscribe, firstOwner, firstOwner) === id;
}

/** Asks the browser to confirm closing or reloading the tab, only while there are unsaved changes. */
function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [active]);
}

export function ApplyBar({
  dirty,
  applying,
  error,
  onApply,
  onDiscard,
  review,
  applyLabel = "Apply",
  discardLabel = "Discard",
  applyingLabel = "Applying…",
}: {
  dirty: boolean;
  applying: boolean;
  error: string | null;
  onApply: () => Promise<boolean>;
  onDiscard: () => void;
  /** "What will change": shown above the buttons, and read out with the Apply button. */
  review?: ReactNode;
  applyLabel?: string;
  discardLabel?: string;
  applyingLabel?: string;
}) {
  const router = useContext(UNSAFE_DataRouterContext);
  const ref = useRef<HTMLDivElement>(null);
  const reviewId = useId();
  const errorId = useId();
  const owner = useIsGuardOwner(useId(), dirty);
  useBeforeUnload(dirty && owner);
  if (!dirty && !applying && !error) return null;
  const apply = async () => {
    const scope = ref.current?.parentElement;
    const ok = await onApply();
    // The bar closes, so give focus back to the section instead of letting it fall to the page.
    if (ok) setTimeout(() => scope?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled]), [href]")?.focus(), 0);
  };
  const describedBy = [review ? reviewId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div ref={ref} className="mt-4 rounded-[10px] border border-rule bg-surface-2 p-3">
      {router && dirty && owner && <RouteGuard />}
      {review && <div id={reviewId} className="mb-3 text-[13px] text-dim">{review}</div>}
      {error && <p id={errorId} role="alert" className="mb-3 text-[13px] text-bad">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-dim">Unsaved changes</span>
        <span className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={applying}>{discardLabel}</Button>
          <Button variant="primary" size="sm" onClick={() => void apply()} disabled={applying} aria-describedby={describedBy}>{applying ? applyingLabel : applyLabel}</Button>
        </span>
      </div>
    </div>
  );
}
