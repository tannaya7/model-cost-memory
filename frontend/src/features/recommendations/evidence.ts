import type { ModelEvidence, ModelEvidenceStatus, Recommendation } from "../../shared/api/types";

type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

/** How the tolerance rule judged a model, in words. */
export const STATUS_LABELS: Record<ModelEvidenceStatus, { label: string; tone: Tone }> = {
  GOOD_ENOUGH: { label: "Good enough", tone: "ok" },
  UNSURE: { label: "Not sure yet", tone: "warn" },
  CLEARLY_WORSE: { label: "Clearly worse", tone: "bad" },
  BELOW_FLOOR: { label: "Needs more runs", tone: "neutral" },
  RETIRED: { label: "Retired", tone: "neutral" },
};

export function findModel(rec: Recommendation, name: string | undefined): ModelEvidence | undefined {
  return name ? rec.models.find((m) => m.model === name) : undefined;
}

export function percent(x: number | null | undefined, decimals = 1): string {
  return x === null || x === undefined ? "-" : `${(x * 100).toFixed(decimals)}%`;
}

/** "97.5–99.6%": the pass-rate interval, or "" when there is none. */
export function range(m: ModelEvidence): string {
  if (m.pass_rate_low === null || m.pass_rate_high === null) return "";
  return `${(m.pass_rate_low * 100).toFixed(1)}–${(m.pass_rate_high * 100).toFixed(1)}%`;
}

/** The rule, in one sentence, from the numbers the server used. */
export function ruleSentence(rec: Recommendation): string {
  const { confidence, margin, evidence_floor } = rec.rules;
  return (
    `A model is judged once it has ${evidence_floor} weighted runs. It qualifies when we are ` +
    `${Math.round(confidence * 100)}% sure it is at most ${Math.round(margin * 100)} points worse than ` +
    `the best; of those, the cheapest per successful run is recommended.`
  );
}
