/** A short, hand-kept list of model FAMILIES, with only what the price catalog lacks: what the provider
 * itself says each is for, and where to read about it. No prices (those come from the project's catalog at
 * runtime) and no scores or rankings.
 *
 * Model names change fast, so entries are family level (match patterns, not exact versions) and every fact
 * carries an `asOf` date. Checked on 2026-11-13 against:
 *   Claude  https://platform.claude.com/docs/en/models/overview   (all current models: text + image input, tool use)
 *   Gemini  https://aistudio.google.com/docs/models  (was ai.google.dev/gemini-api/docs/models; no input limits stated on the page, so none given here)
 *   OpenAI  https://developers.openai.com/api/docs/models         (GPT-6 flagship models list a 1.05M window)
 * Not verified, so left out: an open-weights option (OpenAI's page lists no gpt-oss model) and Gemini context windows. */
import type { Tag } from "./types";

export type CatalogEntry = {
  /** Regular expression source, tested against a lower-cased model id. */
  pattern: string;
  provider: "Anthropic" | "Google" | "OpenAI";
  name: string;
  bestFor: Tag[];
  /** The provider's own size class by family name (2 large, 1 mid, 0 small). A size class, not a quality claim. */
  tier: 2 | 1 | 0;
  contextWindow?: number;
  officialUrl: string;
  asOf: string;
};

const CLAUDE = "https://platform.claude.com/docs/en/models/overview";
const GEMINI = "https://aistudio.google.com/docs/models";
const OPENAI = "https://developers.openai.com/api/docs/models";
const AS_OF = "2026-11-13";

export const MODEL_CATALOG: CatalogEntry[] = [
  // Provider text: "For long-running agentic coding and knowledge work"
  { pattern: "claude-opus", provider: "Anthropic", name: "Claude Opus", bestFor: ["coding", "agents", "tool-use", "multimodal"], tier: 2, contextWindow: 1_000_000, officialUrl: CLAUDE, asOf: AS_OF },
  // Provider text: "combination of speed and intelligence"
  { pattern: "claude-sonnet", provider: "Anthropic", name: "Claude Sonnet", bestFor: ["balanced", "tool-use", "multimodal"], tier: 1, contextWindow: 1_000_000, officialUrl: CLAUDE, asOf: AS_OF },
  // Provider text: "high-volume, latency-sensitive tasks such as classification, extraction, and routing"
  { pattern: "claude-haiku", provider: "Anthropic", name: "Claude Haiku", bestFor: ["classification", "extraction", "fast-cheap", "tool-use", "multimodal"], tier: 0, contextWindow: 1_000_000, officialUrl: CLAUDE, asOf: AS_OF },
  // Provider text: "deep reasoning and coding capabilities"
  { pattern: "gemini-[\\d.]+-pro", provider: "Google", name: "Gemini Pro", bestFor: ["reasoning", "coding"], tier: 2, officialUrl: GEMINI, asOf: AS_OF },
  // Provider text: "software engineering, autonomous agents, and complex enterprise workflows"; "speed and multimodal capabilities"
  { pattern: "gemini-[\\d.]+-flash(?!-lite)", provider: "Google", name: "Gemini Flash", bestFor: ["coding", "agents", "fast-cheap", "multimodal"], tier: 1, officialUrl: GEMINI, asOf: AS_OF },
  // Provider text: "fastest, most cost-effective ... for high-throughput execution"; multimodal
  { pattern: "gemini-[\\d.]+-flash-lite", provider: "Google", name: "Gemini Flash-Lite", bestFor: ["fast-cheap", "multimodal"], tier: 0, officialUrl: GEMINI, asOf: AS_OF },
  // Provider text: "for the most demanding work" / "for complex work at a lower cost"
  { pattern: "gpt-[\\d.]+-(astra|sol)", provider: "OpenAI", name: "GPT-6 Astra and Sol", bestFor: ["complex-work"], tier: 2, contextWindow: 1_050_000, officialUrl: OPENAI, asOf: AS_OF },
  // Provider text: "most efficient model for focused, high-volume tasks"
  { pattern: "gpt-[\\d.]+-luna", provider: "OpenAI", name: "GPT-6 Luna", bestFor: ["fast-cheap"], tier: 0, contextWindow: 1_050_000, officialUrl: OPENAI, asOf: AS_OF },
];

/** The entry whose pattern matches a model id, if any. */
export function entryFor(model: string): CatalogEntry | null {
  const id = model.toLowerCase();
  const e = MODEL_CATALOG.find((x) => new RegExp(x.pattern).test(id));
  if (!e) return null;
  if (e.provider !== "Anthropic") return e;
  const window = claudeWindow(id);
  return window === e.contextWindow ? e : { ...e, contextWindow: window };
}

/**
 * Claude context window by version, from the official models overview (https://platform.claude.com/docs/en/about-claude/models/overview,
 * opened 2026-11-16, "All models" table): "1M tokens" for Opus 4.6 and later (4.6, 4.7, 4.8, 5, 5.5), Sonnet 4.6 and later (4.6, 5, 5.5)
 * and Haiku 5.5; "200K tokens" for Opus 4.5, 4.1 and 4, Sonnet 4.5 and 4, and Haiku 4.5.
 * An id whose version is not on that page gets no window rather than a guess.
 */
export function claudeWindow(id: string): number | undefined {
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id.toLowerCase());
  if (!m) return undefined;
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  if (m[1] === "haiku") return major === 4 && minor === 5 ? 200_000 : major === 5 && minor === 5 ? 1_000_000 : undefined;
  if (major >= 5) return 1_000_000;
  if (major === 4) {
    if (minor >= 6) return 1_000_000;
    if (minor === 5 || minor === 1 || minor === 0) return 200_000;
  }
  return undefined;
}
