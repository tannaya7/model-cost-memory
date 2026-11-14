import { entryFor } from "./modelCatalog";

const SITE = { Anthropic: "Anthropic's", Google: "Google's", OpenAI: "OpenAI's" } as const;
const OVERVIEW = {
  Anthropic: "https://platform.claude.com/docs/en/models/overview",
  Google: "https://aistudio.google.com/docs/models",
  OpenAI: "https://developers.openai.com/api/docs/models",
} as const;

/** The provider's own model overview page for a model id, or null for a model we cannot place. */
export function modelLink(model: string): { url: string; label: string } | null {
  const id = model.toLowerCase();
  const provider =
    entryFor(id)?.provider ??
    (id.startsWith("claude") ? "Anthropic" : id.startsWith("gemini") ? "Google" : id.startsWith("gpt-") ? "OpenAI" : null);
  if (!provider) return null;
  return { url: OVERVIEW[provider], label: `Read about it on ${SITE[provider]} site` };
}
