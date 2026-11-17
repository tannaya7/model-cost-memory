import { entryFor } from "./modelCatalog";

const SITE = { Anthropic: "Anthropic's", Google: "Google's", OpenAI: "OpenAI's" } as const;
const OVERVIEW = {
  Anthropic: "https://platform.claude.com/docs/en/models/overview",
  Google: "https://aistudio.google.com/docs/models",
  OpenAI: "https://developers.openai.com/api/docs/models",
} as const;

// Per-model pages checked against the providers' own overview pages (Nov 2026). A model id only gets
// its own page when it is in these lists; anything else (dated ids, new models) keeps the overview link.
const ANTHROPIC_PAGES = new Set([
  "fable-5-2", "opus-5-5", "sonnet-5-5", "haiku-5-5", "mythos-5-2", "fable-5-1", "mythos-5-1", "fable-5", "mythos-5",
  "opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "opus-4-5", "sonnet-5", "sonnet-4-6", "sonnet-4-5", "haiku-4-5",
]);
const GOOGLE_PAGES = new Set([
  "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite",
]);
const OPENAI_PAGES = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"]);

function ownPage(provider: keyof typeof OVERVIEW, id: string): string | null {
  if (provider === "Anthropic") {
    const slug = id.replace(/^claude-/, "");
    return id.startsWith("claude-") && ANTHROPIC_PAGES.has(slug) ? `https://platform.claude.com/docs/en/models/${slug}/overview` : null;
  }
  if (provider === "Google") return GOOGLE_PAGES.has(id) ? `https://aistudio.google.com/docs/models/${id}` : null;
  return OPENAI_PAGES.has(id) ? `https://developers.openai.com/api/docs/models/${id}` : null;
}

/** The model's own page when we know it exists, else the provider's overview page; null for a model we cannot place. */
export function modelLink(model: string): { url: string; label: string } | null {
  const id = model.toLowerCase();
  const provider =
    entryFor(id)?.provider ??
    (id.startsWith("claude") ? "Anthropic" : id.startsWith("gemini") ? "Google" : id.startsWith("gpt-") ? "OpenAI" : null);
  if (!provider) return null;
  return { url: ownPage(provider, id) ?? OVERVIEW[provider], label: `Read about it on ${SITE[provider]} site` };
}
