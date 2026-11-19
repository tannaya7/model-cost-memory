import { randomUUID } from "node:crypto";

// Token counts from an OpenAI-style or Anthropic-style usage block. A missing number counts as 0.
function tokens(usage = {}) {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  if (usage.prompt_tokens !== undefined) {
    // OpenAI style: cached tokens are counted inside prompt_tokens
    return [Math.max(usage.prompt_tokens - cached, 0), usage.completion_tokens ?? 0, cached, written];
  }
  return [usage.input_tokens ?? 0, usage.output_tokens ?? 0, cached, written]; // Anthropic style
}

// Call this after each AI call your app already makes. It never throws, so it cannot break your app.
export async function recordAiCall(task, { prompt, answer, model, modelVersion, provider, usage, latencyMs, promptVersion }) {
  try {
    const [tokensIn, tokensOut, cacheRead, cacheWrite] = tokens(usage);
    await fetch(`${process.env.MCM_API_URL.replace(/\/$/, "")}/v1/runs`, {
      method: "POST",
      headers: { "X-API-Key": process.env.MCM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: randomUUID(), // a new id for each call
        job: task, // the task name from the list
        prompt,
        output: answer,
        model,
        model_version: modelVersion, // the exact model name the provider returned
        provider, // for example "openai"
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        latency_ms: latencyMs,
        prompt_version: promptVersion,
      }),
    });
  } catch {
    // the dashboard being unreachable must never break your app
  }
}
