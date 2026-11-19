import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPayload, createRecorder, legacyColumns, readOutput, readUsage } from "../src/index.js";

const cases = JSON.parse(readFileSync(fileURLToPath(new URL("../../fixtures/usage_cases.json", import.meta.url)), "utf8"));

// Parity: the same usage blocks, read by the Python reader (the reference) and this one, give the same numbers.
for (const c of cases) {
  test(`reads usage like the Python recorder: ${c.name}`, () => {
    const ledger = readUsage(c.usage);
    assert.equal(ledger.shape, c.expected.shape);
    assert.deepEqual(legacyColumns(ledger), c.expected.columns);
    assert.equal(ledger.fields.reasoning ?? null, c.expected.reasoning);
    assert.equal(ledger.fields.tool_use_input ?? null, c.expected.tool_use_input);
  });
}

const openai = {
  model: "my-model-2026-08-01",
  usage: { prompt_tokens: 1000, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 400 } },
  choices: [{ message: { content: "hello" } }],
};

test("builds the payload the server accepts from a response, leaving out what is unknown", () => {
  const body = buildPayload("read-invoices", { prompt: "p", response: openai, provider: "openai", latencyMs: 420 });
  assert.match(body.run_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { ...body, run_id: undefined },
    {
      run_id: undefined, job: "read-invoices", prompt: "p", output: "hello", model: "my-model-2026-08-01", model_version: "my-model-2026-08-01",
      provider: "openai", latency_ms: 420, usage_shape: "openai_chat", tokens_in: 600, tokens_out: 90, cache_read_tokens: 400, cache_write_tokens: 0,
    },
  );
});

test("a model name the app asked for is kept apart from the version the provider returned", () => {
  const body = buildPayload("t", { prompt: "p", response: openai, model: "my-model", provider: "openai" });
  assert.equal(body.model, "my-model");
  assert.equal(body.model_version, "my-model-2026-08-01");
});

test("no response means no usage shape and no invented zeros", () => {
  const body = buildPayload("t", { prompt: "p", output: "a", model: "m", modelVersion: "m-1" });
  assert.ok(!("usage_shape" in body) && !("tokens_in" in body));
});

test("a response with no usage block is marked none, so zero is not mistaken for 'free'", () => {
  const body = buildPayload("t", { prompt: "p", response: { model: "m-1", choices: [{ message: { content: "x" } }] } });
  assert.equal(body.usage_shape, "none");
  assert.ok(!("tokens_in" in body));
});

test("agent and ids are trimmed to the lengths the server allows", () => {
  const body = buildPayload("t", { prompt: "p", output: "a", model: "m", modelVersion: "m-1", agent: "a".repeat(300), traceId: "t".repeat(300) });
  assert.equal(body.agent.length, 100);
  assert.equal(body.trace_id.length, 200);
});

test("reads the answer text from the common response shapes", () => {
  assert.equal(readOutput(openai), "hello");
  assert.equal(readOutput({ content: [{ type: "text", text: "{\"a\": " }, { type: "text", text: "1}" }] }), '{"a": 1}');
  assert.equal(readOutput({ output_text: "direct" }), "direct");
  assert.equal(readOutput({ candidates: [{ content: { parts: [{ text: "thought", thought: true }, { text: "answer" }] } }] }), "answer");
  assert.equal(readOutput({}), undefined);
});

function fakeFetch(statuses) {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, init });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (status === "throw") throw new Error("down");
    return { ok: status < 300, status };
  };
  return { send, calls };
}

test("sends to /v1/runs with the key, once, and says it worked", async () => {
  const { send, calls } = fakeFetch([202]);
  const mcm = createRecorder({ apiUrl: "https://mcm.example.com/", apiKey: "mcm_live_testkey", fetch: send });
  assert.equal(await mcm.record("read-invoices", { prompt: "p", response: openai }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://mcm.example.com/v1/runs");
  assert.equal(calls[0].init.headers["X-API-Key"], "mcm_live_testkey");
  assert.equal(JSON.parse(calls[0].init.body).job, "read-invoices");
});

test("retries a server error and then succeeds, but never retries a rejection", async () => {
  const flaky = fakeFetch([503, 202]);
  assert.equal(await createRecorder({ apiUrl: "http://x", apiKey: "k", fetch: flaky.send }).record("t", { prompt: "p", response: openai }), true);
  assert.equal(flaky.calls.length, 2);
  const rejected = fakeFetch([422, 202]);
  assert.equal(await createRecorder({ apiUrl: "http://x", apiKey: "k", fetch: rejected.send }).record("t", { prompt: "p", response: openai }), false);
  assert.equal(rejected.calls.length, 1);
});

test("never rejects or throws, even when the dashboard is down for good or the call is malformed", async () => {
  const errors = [];
  const down = fakeFetch(["throw"]);
  const mcm = createRecorder({ apiUrl: "http://x", apiKey: "k", fetch: down.send, retries: 1, onError: (e) => errors.push(e) });
  assert.equal(await mcm.record("t", { prompt: "p", response: openai }), false);
  assert.equal(down.calls.length, 2);
  assert.ok(errors.length >= 1);
  assert.equal(await mcm.record("t", undefined), false); // a malformed call is dropped quietly
});

test("a slow dashboard is cut off by the timeout instead of hanging the app", async () => {
  const slow = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const mcm = createRecorder({ apiUrl: "http://x", apiKey: "k", fetch: slow, timeoutMs: 30, retries: 0 });
  const started = Date.now();
  assert.equal(await mcm.record("t", { prompt: "p", response: openai }), false);
  assert.ok(Date.now() - started < 1000);
});

test("reads MCM_API_URL and MCM_API_KEY from the environment", async () => {
  process.env.MCM_API_URL = "https://env.example.com";
  process.env.MCM_API_KEY = "mcm_live_fromenv";
  const { send, calls } = fakeFetch([202]);
  await createRecorder({ fetch: send }).record("t", { prompt: "p", response: openai });
  assert.equal(calls[0].url, "https://env.example.com/v1/runs");
  assert.equal(calls[0].init.headers["X-API-Key"], "mcm_live_fromenv");
});
