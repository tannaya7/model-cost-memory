/** A small in-flow review for an action that cannot be undone or that shares data: it says exactly what
 * will happen and offers two buttons named for the outcome. No dialog, nothing is sent until the person
 * confirms; a failure shows next to the buttons and the panel stays open. Focus starts on the safe button. */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./primitives";

export function InlineConfirm({
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  busyLabel,
  error,
  danger = false,
  label,
}: {
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  busyLabel?: string;
  error?: string | null;
  danger?: boolean;
  /** Names the group for screen readers. */
  label: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  // The first button is the safe one.
  useEffect(() => rootRef.current?.querySelector("button")?.focus(), []);
  return (
    <div ref={rootRef} role="group" aria-label={label} aria-describedby={id} className="mt-3 rounded-[10px] border border-rule bg-surface-2 p-3">
      <div id={id} className="text-[13px] text-dim">{children}</div>
      {error && <p role="alert" className="mt-2 text-[13px] text-bad">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        <Button variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm} disabled={busy}>{busy ? (busyLabel ?? confirmLabel) : confirmLabel}</Button>
      </div>
    </div>
  );
}
