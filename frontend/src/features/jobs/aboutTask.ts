import type { DayPoint, Job } from "../../shared/api/types";
import { pct, usd } from "../../ui/format";

const OPENERS: Record<Job["check_kind"], string> = {
  ANSWER_KEY: "You give us the right answer for each example and we compare the AI's answer with it.",
  SCHEMA: "An answer counts as correct when it follows the format you defined.",
  TEST_COMMAND: "An answer counts as correct when your test passes.",
  LATE_LABEL: "You mark answers right or wrong later; until then we can only compare cost, not quality.",
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(0, 8) : [];
}

/** How an answer is judged correct, in plain words. Only field names are shown, never answer values. */
export function checkExplanation(job: Pick<Job, "check_kind" | "check_config" | "name" | "description">): string[] {
  const out = [OPENERS[job.check_kind]];
  const cfg = (job.check_config ?? {}) as Record<string, unknown>;
  if (job.check_kind === "ANSWER_KEY") {
    const fields = strings(cfg.fields);
    if (fields.length) out.push(`We compare these fields: ${fields.join(", ")}.`);
  } else if (job.check_kind === "SCHEMA") {
    const schema = (cfg.schema ?? {}) as Record<string, unknown>;
    const required = strings(schema.required);
    if (required.length) out.push(`The answer must include: ${required.join(", ")}.`);
  }
  const text = `${job.name} ${job.description ?? ""}`.toLowerCase();
  if (/classif|categor|triage|sort|label/.test(text)) {
    out.push("This looks like sorting items into groups, so a correct answer is the right group.");
  } else if (/extract|pull|parse|read/.test(text)) {
    out.push("This looks like pulling facts out of text, so a correct answer has the right facts.");
  }
  return out;
}

export interface MonthSummary {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  spend: number;
  correct: number | null;
}

export function summarizeMonth(points: DayPoint[]): MonthSummary {
  const s = { calls: 0, tokensIn: 0, tokensOut: 0, spend: 0, passed: 0, failed: 0 };
  for (const p of points) {
    s.calls += p.runs;
    s.tokensIn += p.tokens_in;
    s.tokensOut += p.tokens_out;
    s.spend += p.spend_usd;
    s.passed += p.passed;
    s.failed += p.failed;
  }
  const checked = s.passed + s.failed;
  return { calls: s.calls, tokensIn: s.tokensIn, tokensOut: s.tokensOut, spend: s.spend, correct: checked ? s.passed / checked : null };
}

const n = (v: number) => v.toLocaleString("en");

export function monthLine(m: MonthSummary): string {
  if (m.calls === 0) return "No calls this month yet.";
  const right = m.correct === null ? "no answers checked yet" : `${pct(m.correct, 0)} of checked answers correct`;
  return `${n(m.calls)} AI calls · ${n(m.tokensIn + m.tokensOut)} tokens (${n(m.tokensIn)} in, ${n(m.tokensOut)} out) · ${usd(m.spend)} · ${right}`;
}
