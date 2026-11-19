/**
 * The Model & Cost Memory recorder for JavaScript and TypeScript apps (Node 18 or newer, no dependencies).
 *
 *   import { createRecorder } from "mcm-recorder";
 *   const mcm = createRecorder(); // reads MCM_API_URL and MCM_API_KEY
 *   const response = await openai.chat.completions.create({ model: "my-model", messages });
 *   void mcm.record("read-invoices", { prompt, response, provider: "openai" }); // never throws, never waits for the network
 *
 * It copies one finished call to POST /v1/runs. It reads usage the same way the Python recorder does (the two are compared on
 * shared test cases in sdk/fixtures/usage_cases.json), sends in the background and never throws into your app.
 * Tool calls and raw usage blocks are not sent by this version.
 */
import { randomUUID } from "node:crypto";

export const SHAPES = ["anthropic_messages", "openai_responses", "openai_chat", "deepseek_chat", "gemini", "none"];

const MAX_INT = 2_000_000_000;

function get(obj, ...path) {
  let cur = obj;
  for (const name of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[name];
  }
  return cur;
}

/** A provider count as an int, or undefined when absent, null, negative, boolean or not a number. Zero stays 0. */
function num(value) {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > MAX_INT) return undefined;
  return Math.trunc(value);
}

function first(usage, ...names) {
  for (const name of names) {
    const n = num(get(usage, name));
    if (n !== undefined) return n;
  }
  return undefined;
}

function sub(total, ...parts) {
  if (total === undefined) return undefined;
  return Math.max(total - parts.reduce((a, p) => a + (p ?? 0), 0), 0);
}

/** Reads one provider usage block into the canonical ledger: { shape, fields }. No usage block gives shape "none". */
export function readUsage(usage) {
  const f = {
    input_total: undefined, uncached_input: undefined, cache_read: undefined, cache_write: undefined, cache_write_1h: undefined,
    tool_use_input: undefined, reasoning: undefined, output_billed: undefined,
  };
  if (usage === null || usage === undefined || typeof usage !== "object") return { shape: "none", fields: f };
  let shape = "none";
  if (num(get(usage, "input_tokens")) !== undefined && get(usage, "input_tokens_details") !== undefined && get(usage, "input_tokens_details") !== null) {
    shape = "openai_responses";
    f.input_total = num(usage.input_tokens);
    f.cache_read = num(get(usage, "input_tokens_details", "cached_tokens"));
    f.cache_write = num(get(usage, "input_tokens_details", "cache_write_tokens"));
    f.uncached_input = sub(f.input_total, f.cache_read, f.cache_write);
    f.output_billed = num(get(usage, "output_tokens"));
    f.reasoning = num(get(usage, "output_tokens_details", "reasoning_tokens"));
  } else if (num(get(usage, "input_tokens")) !== undefined || num(get(usage, "cache_read_input_tokens")) !== undefined) {
    shape = "anthropic_messages";
    f.uncached_input = num(get(usage, "input_tokens"));
    f.cache_read = num(get(usage, "cache_read_input_tokens"));
    f.cache_write = num(get(usage, "cache_creation_input_tokens"));
    const oneHour = num(get(usage, "cache_creation", "ephemeral_1h_input_tokens"));
    if (oneHour !== undefined && f.cache_write !== undefined) {
      f.cache_write_1h = Math.min(oneHour, f.cache_write);
    } else if (oneHour !== undefined) {
      f.cache_write = oneHour + (num(get(usage, "cache_creation", "ephemeral_5m_input_tokens")) ?? 0);
      f.cache_write_1h = oneHour;
    }
    f.output_billed = num(get(usage, "output_tokens"));
  } else if (num(get(usage, "prompt_cache_hit_tokens")) !== undefined) {
    shape = "deepseek_chat";
    const hit = num(usage.prompt_cache_hit_tokens);
    const miss = num(get(usage, "prompt_cache_miss_tokens"));
    f.input_total = num(get(usage, "prompt_tokens"));
    f.cache_read = hit;
    f.uncached_input = miss !== undefined ? miss : sub(f.input_total, hit);
    f.output_billed = num(get(usage, "completion_tokens"));
    f.reasoning = num(get(usage, "completion_tokens_details", "reasoning_tokens"));
  } else if (num(get(usage, "prompt_tokens")) !== undefined || num(get(usage, "completion_tokens")) !== undefined) {
    shape = "openai_chat";
    f.input_total = num(get(usage, "prompt_tokens"));
    f.cache_read = num(get(usage, "prompt_tokens_details", "cached_tokens"));
    f.cache_write = num(get(usage, "prompt_tokens_details", "cache_write_tokens"));
    f.uncached_input = sub(f.input_total, f.cache_read, f.cache_write);
    f.output_billed = num(get(usage, "completion_tokens"));
    f.reasoning = num(get(usage, "completion_tokens_details", "reasoning_tokens"));
  } else if (first(usage, "prompt_token_count", "promptTokenCount") !== undefined || first(usage, "candidates_token_count", "candidatesTokenCount") !== undefined) {
    shape = "gemini";
    const prompt = first(usage, "prompt_token_count", "promptTokenCount");
    f.input_total = prompt;
    f.cache_read = first(usage, "cached_content_token_count", "cachedContentTokenCount");
    f.uncached_input = sub(prompt, f.cache_read);
    f.tool_use_input = first(usage, "tool_use_prompt_token_count", "toolUsePromptTokenCount");
    f.reasoning = first(usage, "thoughts_token_count", "thoughtsTokenCount");
    const candidates = first(usage, "candidates_token_count", "candidatesTokenCount");
    if (candidates !== undefined || f.reasoning !== undefined) f.output_billed = (candidates ?? 0) + (f.reasoning ?? 0);
  }
  return { shape, fields: f };
}

/** The integer columns the server stores: a count that was not reported becomes 0 once a usage block was read. */
export function legacyColumns(ledger) {
  if (ledger.shape === "none") return {};
  const f = ledger.fields;
  const out = {
    tokens_in: f.uncached_input || 0, tokens_out: f.output_billed || 0,
    cache_read_tokens: f.cache_read || 0, cache_write_tokens: f.cache_write || 0,
  };
  if (f.cache_write_1h) out.cache_write_1h_tokens = f.cache_write_1h;
  return out;
}

/** The answer text of a provider response, or undefined when it cannot be found. */
export function readOutput(response) {
  const chat = get(response, "choices", 0, "message", "content");
  if (typeof chat === "string") return chat;
  if (typeof get(response, "output_text") === "string") return response.output_text;
  const blocks = get(response, "content");
  if (Array.isArray(blocks)) {
    const text = blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
    if (text) return text;
  }
  const parts = get(response, "candidates", 0, "content", "parts");
  if (Array.isArray(parts)) {
    const text = parts.filter((p) => p && typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
    if (text) return text;
  }
  return undefined;
}

const clip = (value, n) => (typeof value === "string" && value ? value.slice(0, n) : undefined);

export function buildPayload(job, call) {
  const response = call.response;
  const usage = get(response, "usage") ?? get(response, "usageMetadata") ?? get(response, "usage_metadata");
  const ledger = readUsage(usage);
  const resolved = call.modelVersion ?? get(response, "model") ?? get(response, "modelVersion") ?? call.model ?? "unknown";
  const body = {
    run_id: randomUUID(),
    job,
    prompt: call.prompt,
    output: call.output ?? readOutput(response),
    model: call.model ?? resolved,
    model_version: resolved,
    provider: call.provider,
    prompt_version: call.promptVersion,
    effort: call.effort,
    agent: clip(call.agent, 100),
    trace_id: clip(call.traceId, 200),
    span_id: clip(call.spanId, 200),
    parent_span_id: clip(call.parentSpanId, 200),
    latency_ms: call.latencyMs,
    usage_shape: response === undefined || response === null ? undefined : ledger.shape, // "none" = the response carried no usage block
    reasoning_tokens: ledger.fields.reasoning,
    tool_use_input_tokens: ledger.fields.tool_use_input,
    ...legacyColumns(ledger),
    ...Object.fromEntries(Object.entries(call.explicit ?? {}).filter(([, v]) => v !== undefined && v !== null)),
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * @param {{ apiUrl?: string, apiKey?: string, fetch?: typeof fetch, timeoutMs?: number, retries?: number, onError?: (e: Error) => void }} [options]
 */
export function createRecorder(options = {}) {
  const env = typeof process !== "undefined" ? process.env : {};
  const apiUrl = (options.apiUrl ?? env.MCM_API_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
  const apiKey = options.apiKey ?? env.MCM_API_KEY ?? "";
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const retries = options.retries ?? 2;
  const onError = options.onError ?? (() => {});

  /** Copies one finished call to the dashboard. Resolves when done; never rejects, so `void mcm.record(...)` is safe. */
  async function record(job, call) {
    try {
      const body = JSON.stringify(buildPayload(job, call));
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let reply;
          try {
            reply = await send(`${apiUrl}/v1/runs`, {
              method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" }, body, signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
          if (reply.ok) return true;
          if (reply.status !== 429 && reply.status < 500) return false; // rejected: retrying will not help
        } catch (error) {
          onError(error);
        }
        if (attempt < retries) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
      return false;
    } catch (error) {
      onError(error);
      return false;
    }
  }

  return { record, apiUrl };
}
