/** The JavaScript function the Connect guide gives a developer is a real file. This runs that exact file in Node with a stand-in
 *  for `fetch`, so what a customer is shown is what was tested. No network is used. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SNIPPET = join(__dirname, "recordAiCall.mjs");

function run(callSource: string, env: Record<string, string> = { MCM_API_URL: "https://mcm.example.com/", MCM_API_KEY: "mcm_live_testkey" }) {
  const dir = mkdtempSync(join(tmpdir(), "mcm-snippet-"));
  copyFileSync(SNIPPET, join(dir, "recordAiCall.mjs"));
  writeFileSync(
    join(dir, "run.mjs"),
    `const sent = [];
globalThis.fetch = async (url, init) => { if (globalThis.__fail) throw new Error("down"); sent.push({ url, init }); return { ok: true }; };
const { recordAiCall } = await import("./recordAiCall.mjs");
${callSource}
console.log(JSON.stringify(sent.map((s) => ({ url: s.url, method: s.init.method, key: s.init.headers["X-API-Key"], body: JSON.parse(s.init.body) }))));`,
  );
  const out = execFileSync(process.execPath, [join(dir, "run.mjs")], { env: { ...env, PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop() as string);
}

describe("the JavaScript function from the Connect guide", () => {
  it("sends the fields the server needs, with cached tokens taken out of the full-price count", () => {
    const [sent] = run(`await recordAiCall("read-invoices", { prompt: "p", answer: "a", model: "my-model", modelVersion: "my-model-2026-01-01", provider: "openai",
      usage: { prompt_tokens: 1500, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1000 } }, latencyMs: 420, promptVersion: "v2" });`);
    expect(sent.url).toBe("https://mcm.example.com/v1/runs");
    expect(sent.method).toBe("POST");
    expect(sent.key).toBe("mcm_live_testkey");
    expect(sent.body).toMatchObject({ job: "read-invoices", prompt: "p", output: "a", model: "my-model", model_version: "my-model-2026-01-01", provider: "openai", tokens_in: 500, tokens_out: 80, cache_read_tokens: 1000, latency_ms: 420, prompt_version: "v2" });
    expect(sent.body.run_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads Anthropic-style usage as it is, and leaves out what it was not given", () => {
    const [sent] = run(`await recordAiCall("t", { prompt: "p", answer: "a", model: "m", modelVersion: "m-1", provider: "anthropic",
      usage: { input_tokens: 700, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } });`);
    expect(sent.body).toMatchObject({ tokens_in: 700, tokens_out: 40, cache_read_tokens: 300, cache_write_tokens: 50 });
    expect("latency_ms" in sent.body).toBe(false);
    expect("prompt_version" in sent.body).toBe(false);
  });

  it("uses a new id for every call and counts missing usage as zero", () => {
    const sent = run(`await recordAiCall("t", { prompt: "p", answer: "a", model: "m", modelVersion: "m-1", provider: "x" });
      await recordAiCall("t", { prompt: "p", answer: "a", model: "m", modelVersion: "m-1", provider: "x" });`);
    expect(sent).toHaveLength(2);
    expect(sent[0].body.run_id).not.toBe(sent[1].body.run_id);
    expect([sent[0].body.tokens_in, sent[0].body.tokens_out]).toEqual([0, 0]);
  });

  it("never throws when the dashboard is down or the settings are missing", () => {
    expect(run(`globalThis.__fail = true; await recordAiCall("t", { prompt: "p", answer: "a", model: "m", modelVersion: "m-1", provider: "x" });`)).toEqual([]);
    expect(run(`await recordAiCall("t", { prompt: "p", answer: "a", model: "m", modelVersion: "m-1", provider: "x" });`, {})).toEqual([]);
  });

  it("imports nothing but Node's own crypto", () => {
    const imports = [...require("node:fs").readFileSync(SNIPPET, "utf8").matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
  });
});
