/** A local draft of one settings section. Nothing is sent until `apply()`; the server's answer is awaited
 * (no optimistic update), the user's input is kept when it fails, and a second press while one is in flight
 * is ignored. Success shows a toast. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../shared/api/apiFetch";
import { useToast } from "./Toast";

export function useDraftSection<T, R = unknown>({
  saved,
  save,
  success,
  validate,
  equal = (a, b) => JSON.stringify(a) === JSON.stringify(b),
}: {
  saved: T;
  /** Sends the draft. Throw to report a failure. */
  save: (draft: T) => Promise<R>;
  success: string | ((draft: T, result: R) => string);
  /** A plain-words problem with the draft, or null. Checked on Apply, before anything is sent. */
  validate?: (draft: T) => string | null;
  equal?: (a: T, b: T) => boolean;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<T | undefined>(undefined);
  const [applied, setApplied] = useState<{ value: T } | null>(null); // what the server just accepted, until the refetch lands
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const busy = useRef(false);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setApplied(null), [savedKey]);

  const base = applied ? applied.value : saved;
  const value = draft === undefined ? base : draft;
  const dirty = draft !== undefined && !equal(draft, base);

  const change = useCallback((next: T) => {
    setDraft(next);
    setError(null);
    setResult(null);
  }, []);
  const discard = useCallback(() => {
    setDraft(undefined);
    setError(null);
  }, []);

  /** Resolves to true when the server accepted it. */
  const apply = useCallback(async (): Promise<boolean> => {
    if (busy.current || draft === undefined) return false;
    const problem = validate?.(draft) ?? null;
    if (problem) {
      setError(problem);
      return false;
    }
    busy.current = true;
    setApplying(true);
    setError(null);
    try {
      const r = await save(draft);
      setApplied({ value: draft });
      setDraft(undefined);
      setResult(r);
      toast({ message: typeof success === "function" ? success(draft, r) : success });
      return true;
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "Could not save");
      return false;
    } finally {
      busy.current = false;
      setApplying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, save, validate, success, toast]);

  return { value, dirty, change, discard, apply, applying, error, setError, result, clearResult: () => setResult(null), saved: base };
}
