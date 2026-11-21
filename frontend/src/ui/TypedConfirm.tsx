/** An in-page confirmation for something that cannot be undone, in place of the browser's own prompt.
 *  Says exactly what will happen, asks the person to type a word they can see, keeps the destructive button off until it matches, and puts
 *  focus on the text box (the safe place). It is a labelled group, not a modal: nothing behind it is hidden, Escape cancels, and focus goes
 *  back to the button that opened it. */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./primitives";

export function TypedConfirm({
  label, expected, confirmLabel, cancelLabel = "Cancel", busy = false, error, onConfirm, onCancel, children, ignoreCase = false,
}: {
  label: string;
  expected: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
  children: ReactNode;
  ignoreCase?: boolean;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    input.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, []);
  const match = ignoreCase ? typed.trim().toLowerCase() === expected.toLowerCase() : typed === expected;
  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={`${id}-what`}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
      className="mt-3 rounded-[10px] border border-rule bg-surface-2 p-3"
    >
      <div id={`${id}-what`} className="text-[13px] text-dim">{children}</div>
      <label htmlFor={`${id}-in`} className="mt-3 block text-xs font-semibold text-dim">Type <span className="font-mono text-ink">{expected}</span> to confirm</label>
      <input
        id={`${id}-in`} ref={input} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
        className="mt-1 w-full max-w-sm rounded-[10px] border border-rule bg-surface px-3 py-2 text-sm text-ink"
      />
      {error && <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        <Button variant="danger" size="sm" onClick={() => onConfirm(typed)} disabled={!match || busy}>{busy ? "Working…" : confirmLabel}</Button>
      </div>
    </div>
  );
}
