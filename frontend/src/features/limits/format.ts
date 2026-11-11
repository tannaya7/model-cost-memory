import type { LimitState, UsageLimit } from "../../shared/api/types";

type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

export const STATE_LABELS: Record<LimitState, { label: string; tone: Tone }> = {
  OK: { label: "Lasts until reset", tone: "ok" },
  AT_RISK: { label: "Runs out early", tone: "warn" },
  EXHAUSTED: { label: "Used up", tone: "bad" },
  UNKNOWN: { label: "Needs your reading", tone: "neutral" },
};

/** "sonnet-5@low" → "sonnet-5 · low effort". */
export function optionLabel(option: string): string {
  const [model, effort] = option.split("@");
  return effort ? `${model} · ${effort} effort` : model;
}

export function hoursLabel(hours: number): string {
  if (hours < 1) return `${Math.max(Math.round(hours * 60), 1)} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function windowLabel(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? "1 day" : `${hours / 24} days`;
  return `${hours} hours`;
}

function compact(n: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** What is used, in the limit's own measure: "$31.20 of $40", "1.2M of 5M tokens", "84%". */
export function usedLabel(limit: UsageLimit): string {
  if (limit.share_used === null || limit.used === null) return "—";
  switch (limit.measure) {
    case "USD":
      return `$${limit.used.toFixed(2)} of $${(limit.size ?? 0).toFixed(2)}`;
    case "TOKENS":
      return `${compact(limit.used)} of ${compact(limit.size ?? 0)} tokens`;
    case "REQUESTS":
      return `${compact(limit.used)} of ${compact(limit.size ?? 0)} requests`;
    default:
      return `${Math.round(limit.share_used * 100)}% (estimated)`;
  }
}
