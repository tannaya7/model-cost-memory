import { delay, http, HttpResponse } from "msw";
import type { Job, Run, RunDetail } from "../shared/api/types";
import initialJobs from "./jobs.sample.json";
import sampleRunsData from "./runs.sample.json";

function isAuthorized(request: Request): boolean {
  const apiKey = request.headers.get("x-api-key") || "";
  const auth = request.headers.get("authorization") || "";
  const bearerKey = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const key = apiKey || bearerKey;
  return key === "demo-key" || key.startsWith("mcm_");
}

// In-memory jobs list seeded from jobs.sample.json
const jobs: Job[] = [...(initialJobs as Job[])];

// Generate ~300 mock runs seeded with realistic data
const outcomes: Array<"PASS" | "FAIL" | "UNKNOWN"> = [
  "PASS", "PASS", "PASS", "PASS", "FAIL", "PASS", "PASS", "FAIL", "UNKNOWN", "PASS"
];

const failReasons = [
  "total: expected 1250.00, got 1205.00",
  "schema validation failed: missing required property 'category'",
  "date: expected 2026-10-14, got null",
  "category: expected 'billing', got 'hardware'",
  "vendor: expected 'ShopCo', got 'Shop LLC'",
  "schema validation failed: property 'price' is not a number",
];

const now = Date.now();
const runs: RunDetail[] = [];

// First seed sample runs if any
for (const sample of sampleRunsData.items) {
  const r = sample as Run;
  runs.push({
    ...r,
    prompt: `${r.prompt_preview}\n\nPlease output valid JSON with all required fields.`,
    output: r.output_preview ? `${r.output_preview}\n}` : null,
    tool_calls: null,
  });
}

// Generate the remaining runs up to ~300
for (let i = 0; i < 297; i++) {
  const isInvoice = i % 2 === 0;
  const jobName = isInvoice ? "invoice-extract" : "ticket-classify";
  const jobId = isInvoice
    ? "00000000-0000-0000-0000-000000001001"
    : "00000000-0000-0000-0000-000000001002";
  const model = i % 3 === 0 ? "max" : "mini";
  const modelVersion = i % 4 === 0 ? "2026-10" : "2026-09";
  const outcome = outcomes[i % outcomes.length];
  const outcomeReason = outcome === "FAIL" ? failReasons[i % failReasons.length] : null;
  const timeOffsetMs = (i + 1) * 35 * 60 * 1000; // spread backwards over several days
  const createdAt = new Date(now - timeOffsetMs).toISOString();
  const runId = `00000000-0000-0000-0001-${String(i + 1).padStart(12, "0")}`;
  const tokensIn = 600 + (i * 17) % 600;
  const tokensOut = 80 + (i * 13) % 250;
  const cacheRead = (i % 5 === 0) ? 120 : 0;
  const costUsd = Number(((model === "max" ? 0.03 : 0.003) + (tokensIn * 0.000001) + (tokensOut * 0.000003)).toFixed(4));
  const latencyMs = outcome === "UNKNOWN" ? null : 450 + (i * 29) % 800;

  let prompt = "";
  let output: string | null = null;
  let toolCalls: Array<Record<string, unknown>> | null = null;

  if (isInvoice) {
    prompt = `Extract the vendor, invoice number, date and total from this invoice:\n\nINVOICE #INV-${1040 + i}\nVendor: ${i % 3 === 0 ? "Acme Logistics" : "ShopCo"}\nDate: 2026-10-${String((i % 28) + 1).padStart(2, "0")}\nTotal: $${(1000 + i * 5).toFixed(2)}\n\nPlease extract structured JSON.`;
    if (outcome === "PASS") {
      output = JSON.stringify(
        {
          vendor: i % 3 === 0 ? "Acme Logistics" : "ShopCo",
          invoice_number: `INV-${1040 + i}`,
          date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
          total: Number((1000 + i * 5).toFixed(2)),
        },
        null,
        2,
      );
    } else if (outcome === "FAIL") {
      output = JSON.stringify(
        {
          vendor: "Wrong Vendor",
          invoice_number: `INV-${1040 + i}`,
          date: null,
          total: 999.0,
        },
        null,
        2,
      );
    }
    if (i % 10 === 0) {
      toolCalls = [{ name: "lookup_currency_rates", id: `call_${i}_fx` }];
    }
  } else {
    prompt = `Classify the following customer ticket:\n\n"I was charged twice for subscription renewal on my credit card. Please refund the duplicate transaction."\n\nClassify category into: billing, hardware, software, general.`;
    if (outcome === "PASS") {
      output = JSON.stringify({ category: "billing", confidence: 0.98 }, null, 2);
    } else if (outcome === "FAIL") {
      output = JSON.stringify({ category: "hardware", confidence: 0.42 }, null, 2);
    }
  }

  const promptPreview = prompt.slice(0, 180) + "...";
  const outputPreview = output ? output.slice(0, 180) + "..." : null;

  runs.push({
    run_id: runId,
    job_id: jobId,
    job: jobName,
    model,
    model_version: modelVersion,
    prompt_version: i % 2 === 0 ? "v2" : "v1",
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
    cost_usd: costUsd,
    latency_ms: latencyMs,
    outcome,
    outcome_reason: outcomeReason,
    run_kind: i % 7 === 0 ? "SHADOW" : i % 11 === 0 ? "RETEST" : "PRODUCTION",
    state: "INDEXED",
    created_at: createdAt,
    prompt_preview: promptPreview,
    output_preview: outputPreview,
    prompt,
    output,
    tool_calls: toolCalls,
  });
}

// Ensure sorted newest first
runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

export const handlers = [
  // GET /v1/jobs
  http.get("/v1/jobs", async ({ request }) => {
    await delay(400);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    return HttpResponse.json(jobs);
  }),

  // POST /v1/jobs
  http.post("/v1/jobs", async ({ request }) => {
    await delay(400);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return HttpResponse.json({ detail: "Invalid JSON body" }, { status: 422 });
    }

    if (!body || typeof body !== "object") {
      return HttpResponse.json({ detail: "Request body is required" }, { status: 422 });
    }

    const { name, description, check_kind, check_config, retest_consent } = body;

    // Validation
    const nameRegex = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    if (!name || typeof name !== "string" || name.length < 1 || name.length > 100 || !nameRegex.test(name)) {
      return HttpResponse.json(
        { detail: "Job name must be 1-100 characters and match ^[A-Za-z0-9][A-Za-z0-9._-]*$" },
        { status: 422 },
      );
    }

    if (description && (typeof description !== "string" || description.length > 500)) {
      return HttpResponse.json({ detail: "Description must be under 500 characters" }, { status: 422 });
    }

    const duplicate = jobs.some((j) => j.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      return HttpResponse.json({ detail: "A job with this name already exists" }, { status: 422 });
    }

    const newJob: Job = {
      job_id: crypto.randomUUID(),
      name,
      description: description ?? null,
      check_kind,
      check_config: check_config ?? {},
      retest_consent: Boolean(retest_consent),
      run_count: 0,
      runs_by_state: {},
    };

    jobs.unshift(newJob);
    return HttpResponse.json(newJob, { status: 201 });
  }),

  // GET /v1/runs
  http.get("/v1/runs", async ({ request }) => {
    await delay(400);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const url = new URL(request.url);
    const job = url.searchParams.get("job");
    const model = url.searchParams.get("model");
    const outcome = url.searchParams.get("outcome");
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");

    let filtered = runs;

    if (job) {
      filtered = filtered.filter((r) => r.job === job);
    }
    if (model) {
      filtered = filtered.filter((r) => r.model.toLowerCase().includes(model.toLowerCase()));
    }
    if (outcome && outcome !== "All") {
      filtered = filtered.filter((r) => r.outcome === outcome);
    }

    const limit = Math.min(200, Math.max(1, limitParam ? parseInt(limitParam, 10) : 50));
    const offset = cursorParam ? parseInt(cursorParam, 10) : 0;
    const safeOffset = isNaN(offset) || offset < 0 ? 0 : offset;

    const pageItems = filtered.slice(safeOffset, safeOffset + limit);
    const nextOffset = safeOffset + limit;
    const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;

    // Convert RunDetail to RunOut
    const items: Run[] = pageItems.map((r) => ({
      run_id: r.run_id,
      job_id: r.job_id,
      job: r.job,
      model: r.model,
      model_version: r.model_version,
      prompt_version: r.prompt_version,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
      cache_read_tokens: r.cache_read_tokens,
      cache_write_tokens: r.cache_write_tokens,
      cost_usd: r.cost_usd,
      latency_ms: r.latency_ms,
      outcome: r.outcome,
      outcome_reason: r.outcome_reason,
      run_kind: r.run_kind,
      state: r.state,
      created_at: r.created_at,
      prompt_preview: r.prompt_preview,
      output_preview: r.output_preview,
    }));

    return HttpResponse.json({
      items,
      next_cursor: nextCursor,
    });
  }),

  // GET /v1/runs/:run_id
  http.get("/v1/runs/:run_id", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const runId = params.run_id;
    const run = runs.find((r) => r.run_id === runId);

    if (!run) {
      return HttpResponse.json({ detail: "Run not found" }, { status: 404 });
    }

    return HttpResponse.json(run);
  }),
];
