import type { ReactNode } from "react";

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-rule bg-surface p-8 text-center">
      <p className="font-semibold">{title}</p>
      {hint && <p className="mt-1 text-sm text-dim">{hint}</p>}
    </div>
  );
}
