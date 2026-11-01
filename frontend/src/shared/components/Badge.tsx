import type { ReactNode } from "react";

type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-skeleton text-dim",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}
