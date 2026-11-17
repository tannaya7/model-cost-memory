/** Small messages that confirm something happened ("Settings applied"). A success is announced politely
 * (role=status) and never takes focus; an error is announced at once (role=alert). Each stays about six
 * seconds, pauses while the mouse or keyboard is on it, and can be closed. At most three show at a time. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconCheck } from "./icons";
import { cx } from "./primitives";

export type ToastInput = { message: string; kind?: "success" | "error"; undo?: { label: string; onUndo: () => void } };
type ToastItem = ToastInput & { id: number };
type Push = (t: ToastInput) => void;

const MAX = 3;
const LIFETIME_MS = 6000;

// Outside a provider (a unit test of one screen) a toast simply does nothing.
const ToastContext = createContext<Push>(() => undefined);

export function useToast(): Push {
  return useContext(ToastContext);
}

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: () => void }) {
  const [paused, setPaused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => closeRef.current(), LIFETIME_MS);
    return () => clearTimeout(t);
  }, [paused]);
  const isError = toast.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cx(
        "pointer-events-auto flex items-center gap-2.5 rounded-[12px] border bg-surface px-3.5 py-2.5 text-sm text-ink shadow-lg motion-safe:animate-[toast-in_0.2s_ease-out]",
        isError ? "border-bad/50" : "border-rule",
      )}
    >
      {!isError && <span className="text-ok"><IconCheck size={16} /></span>}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{toast.message}</span>
      {toast.undo && (
        <button type="button" onClick={() => { toast.undo?.onUndo(); onClose(); }} className="rounded-md px-2 py-1 text-xs font-semibold text-accent-ink hover:underline">
          {toast.undo.label}
        </button>
      )}
      <button type="button" aria-label="Close message" onClick={onClose} className="grid h-6 w-6 place-items-center rounded-md text-muted hover:text-ink">
        <span aria-hidden>×</span>
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback<Push>((t) => {
    const id = next.current++;
    setItems((cur) => [...cur, { ...t, id }].slice(-MAX));
  }, []);
  const close = useCallback((id: number) => setItems((cur) => cur.filter((x) => x.id !== id)), []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Above the phone's bottom bar; the region itself ignores clicks so it never blocks a field. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[90] flex flex-col items-center gap-2 px-4 md:bottom-6 md:items-end md:px-6">
        {items.map((t) => (
          <div key={t.id} className="w-full max-w-sm">
            <ToastCard toast={t} onClose={() => close(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
