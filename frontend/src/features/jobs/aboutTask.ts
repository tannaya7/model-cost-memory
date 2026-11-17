import type { DayPoint, Job, TaskProfile } from "../../shared/api/types";
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

export function monthLine(m: MonthSummary, mode: "per_use" | "subscription" | "both" = "per_use"): string {
  if (m.calls === 0) return "No calls this month yet.";
  const right = m.correct === null ? "no answers checked yet" : `${pct(m.correct, 0)} of checked answers correct`;
  const money = mode === "per_use" ? usd(m.spend) : mode === "both" ? `${usd(m.spend)} at list prices` : null;
  return [`${n(m.calls)} AI calls`, `${n(m.tokensIn + m.tokensOut)} tokens (${n(m.tokensIn)} in, ${n(m.tokensOut)} out)`, money, right].filter(Boolean).join(" · ");
}

export interface Fact {
  label: string;
  value: string;
  /** "measured" = counted or billed; "estimate" = our best guess from patterns. */
  kind: "measured" | "estimate";
}

const ROUND = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));

/** What the calls prove, in plain words. Only called once there are enough calls. */
export function profileFacts(p: TaskProfile, job: Pick<Job, "check_kind">): Fact[] {
  const out: Fact[] = [
    { label: "How answers are checked", value: CHECK_WORDS[job.check_kind], kind: "measured" },
    { label: "AI models used", value: p.models.length ? p.models.join(", ") : "None recorded", kind: "measured" },
    { label: `AI calls in the last ${p.window_days} days`, value: n(p.calls), kind: "measured" },
  ];
  if (p.uses_tools) {
    const via = p.tool_source === "mcp" ? " (through tool servers)" : "";
    out.push({ label: "Uses tools", value: `Yes${via}. The AI can look things up or take actions.`, kind: "measured" });
  } else {
    out.push({ label: "Uses tools", value: "No. It only reads text and answers.", kind: "measured" });
  }
  if (p.works_like_agent) {
    out.push({
      label: "Looks like an agent",
      value: p.works_like_agent === "yes" ? "Yes. It takes several steps with tools to finish one job." : "Probably. Several calls use tools in a row.",
      kind: "estimate",
    });
  }
  if (p.multi_agent) out.push({ label: "Several agents", value: "More than one named agent works on the same job.", kind: "measured" });
  if (p.typical_tokens_in != null && p.typical_tokens_out != null) {
    out.push({
      label: "Typical size of one call",
      value: `About ${ROUND(p.typical_tokens_in)} tokens in and ${ROUND(p.typical_tokens_out)} tokens out`,
      kind: "measured",
    });
  }
  return out;
}

const CHECK_WORDS: Record<Job["check_kind"], string> = {
  ANSWER_KEY: "Compared with the right answer you gave",
  SCHEMA: "Checked against the format you defined",
  TEST_COMMAND: "Checked by running your test",
  LATE_LABEL: "You mark answers right or wrong later",
};
