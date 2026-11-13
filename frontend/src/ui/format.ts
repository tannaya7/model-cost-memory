/** Numbers and words the way a person reads them. */
import type { Tone } from "./primitives";

/** Dollars: cents for normal amounts, two significant figures under a cent (never "$0.00"). */
export function usd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs === 0) return "$0";
  if (opts.compact && abs >= 1000) {
    return `${sign}$${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(abs)}`;
  }
  if (abs < 0.01) return `${sign}$${abs.toPrecision(2).replace(/0+$/, "")}`;
  if (abs < 100) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${Math.round(abs).toLocaleString("en")}`;
}

/** A 0..1 rate as a percentage with one decimal ("99.2%"). */
export function pct(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "–";
  return `${(rate * 100).toFixed(digits)}%`;
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  if (n >= 10_000) return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return n.toLocaleString("en");
}

export function timeAgo(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 14) return `${days} d ago`;
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}

export type Verdict = "SWITCH" | "DOWNGRADE" | "HOLD" | "INSUFFICIENT_EVIDENCE";

export const VERDICT: Record<Verdict, { label: string; tone: Tone; short: string }> = {
  DOWNGRADE: { label: "Cheaper model found", tone: "good", short: "Save" },
  SWITCH: { label: "Better model found", tone: "warn", short: "Switch" },
  HOLD: { label: "Right model", tone: "neutral", short: "Hold" },
  INSUFFICIENT_EVIDENCE: { label: "Gathering evidence", tone: "info", short: "Learning" },
};

export type ModelStatus = "GOOD_ENOUGH" | "UNSURE" | "CLEARLY_WORSE" | "BELOW_FLOOR" | "RETIRED";

export const MODEL_STATUS: Record<ModelStatus, { label: string; tone: Tone }> = {
  GOOD_ENOUGH: { label: "Good enough", tone: "good" },
  UNSURE: { label: "Not sure yet", tone: "warn" },
  CLEARLY_WORSE: { label: "Worse", tone: "bad" },
  BELOW_FLOOR: { label: "Too few runs", tone: "neutral" },
  RETIRED: { label: "Retired", tone: "bad" },
};
