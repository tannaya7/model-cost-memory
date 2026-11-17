import { newcombeDifference } from "../compare/wilson";
import type { PromptVersion } from "../../features/insights/api/promptVersionsApi";

const pc = (v: number) => `${Math.round(v * 100)}%`;

/** The correct-answers sentence for two prompt versions. When the plausible range of the difference spans 0 it says "not enough
 * to tell" (never "about the same"); otherwise it says both rates. */
export function correctAnswersSentence(older: PromptVersion, newer: PromptVersion): string | null {
  if (older.correct_rate === null || newer.correct_rate === null || older.checked <= 0 || newer.checked <= 0) return null;
  const d = newcombeDifference(older.correct_rate, older.checked, newer.correct_rate, newer.checked);
  if (!d) return null;
  const both = `${pc(older.correct_rate)} for ${older.label} and ${pc(newer.correct_rate)} for ${newer.label}, from ${older.checked} and ${newer.checked} checked answers`;
  if (d.low <= 0 && d.high >= 0) return `Correct answers: not enough to tell whether they differ (${both}).`;
  return `Correct answers differ: ${both}.`;
}

/** The server summary with its correct-answers sentence swapped for ours (the server still says "look about the same" when
 * the two ranges merely overlap). Falls back to the server text when the versions or the sentence are not found. */
export function summaryText(summary: string, versions: PromptVersion[], olderLabel: string, newerLabel: string): string {
  const older = versions.find((v) => v.label === olderLabel);
  const newer = versions.find((v) => v.label === newerLabel);
  const ours = older && newer ? correctAnswersSentence(older, newer) : null;
  if (!ours) return summary.replace(/Correct answers look about the same/, "Correct answers: not enough to tell whether they differ");
  return summary.replace(/Correct answers look about the same[^.]*\./, ours).replace(/Correct answers differ:[^]*?checked answers\./, ours);
}
