import { delay, http, HttpResponse } from "msw";
import type {
  Job,
  Model,
  Run,
  RunDetail,
  Recommendation,
  SpendInsight,
  RegressionAlert,
  HistoryEntry,
  RetestStatus,
  RetestLimits,
  User,
  Project,
} from "../shared/api/types";
import initialJobs from "./jobs.sample.json";
import sampleRunsData from "./runs.sample.json";
import sampleModelsData from "./models.sample.json";

const models: Model[] = [...(sampleModelsData.items as Model[])];

function isAuthorized(request: Request): boolean {
  const apiKey = request.headers.get("x-api-key") || "";
  const auth = request.headers.get("authorization") || "";
  const bearerKey = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const key = apiKey || bearerKey;
  return key === "demo-key" || key.startsWith("mcm_");
}

function isMockSignedIn(): boolean {
  try {
    return localStorage.getItem("mcm_mock_signed_in") === "true";
  } catch {
    return false;
  }
}

function generateApiKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 24; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `mcm_live_${suffix}`;
}

const projects: Project[] = [
  {
    project_id: "00000000-0000-0000-0000-000000000001",
    name: "production",
    webhook_url: "https://alerts.example.com/webhook",
    retest_monthly_cap_usd: 10,
    retest_allowed: true,
    key_prefix: "mcm_live_prod",
    created_at: "2026-09-01T00:00:00Z",
  },
  {
    project_id: "00000000-0000-0000-0000-000000000002",
    name: "staging",
    webhook_url: null,
    retest_monthly_cap_usd: 50,
    retest_allowed: false,
    key_prefix: "mcm_live_stag",
    created_at: "2026-09-15T00:00:00Z",
  },
];

// In-memory jobs list seeded from jobs.sample.json
const jobs: Job[] = [...(initialJobs as Job[])];
const retests = new Map<string, RetestStatus>();

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

  // GET /v1/models
  http.get("/v1/models", async ({ request }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const usedParam = url.searchParams.get("used");
    const q = url.searchParams.get("q");
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");

    let filtered = models;

    if (status && status !== "ALL") {
      filtered = filtered.filter((m) => m.status.toUpperCase() === status.toUpperCase());
    }
    if (usedParam === "true") {
      filtered = filtered.filter((m) => m.used_by_project === true);
    }
    if (q) {
      const qLower = q.toLowerCase();
      filtered = filtered.filter((m) => m.model.toLowerCase().includes(qLower));
    }

    const limit = Math.min(500, Math.max(1, limitParam ? parseInt(limitParam, 10) : 100));
    const offset = cursorParam ? parseInt(cursorParam, 10) : 0;
    const safeOffset = isNaN(offset) || offset < 0 ? 0 : offset;

    const pageItems = filtered.slice(safeOffset, safeOffset + limit);
    const nextOffset = safeOffset + limit;
    const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;

    return HttpResponse.json({
      items: pageItems,
      next_cursor: nextCursor,
    });
  }),

  // GET /v1/jobs/:job/recommendation
  http.get("/v1/jobs/:job/recommendation", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const jobName = decodeURIComponent(String(params.job));

    if (jobName === "invoice-extract") {
      const rec: Recommendation = {
        job: "invoice-extract",
        current_model: "max",
        rules: { evidence_floor: 25.0, tolerance: 0.02 },
        verdict: "DOWNGRADE",
        recommended: { model: "mini", model_version: "2026-09" },
        comparison: {
          recommended: {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 820,
            failures: 31,
            evidence_weight: 812.5,
            weighted_pass_rate: 0.962,
            mean_cost_usd: 0.0031,
            cost_per_success_usd: 0.0032,
            eligible: true,
          },
          current: {
            model: "max",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 450,
            failures: 13,
            evidence_weight: 430.2,
            weighted_pass_rate: 0.971,
            mean_cost_usd: 0.0347,
            cost_per_success_usd: 0.0357,
            eligible: true,
          },
        },
        candidates: [
          {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 820,
            failures: 31,
            evidence_weight: 812.5,
            weighted_pass_rate: 0.962,
            mean_cost_usd: 0.0031,
            cost_per_success_usd: 0.0032,
            eligible: true,
          },
          {
            model: "max",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 450,
            failures: 13,
            evidence_weight: 430.2,
            weighted_pass_rate: 0.971,
            mean_cost_usd: 0.0347,
            cost_per_success_usd: 0.0357,
            eligible: true,
          },
        ],
        excluded: [
          {
            model: "acme-legacy-2024-01-01",
            latest_version: "v0.9-alpha",
            catalog_status: "RETIRED",
            shutdown_date: "2025-12-31",
            n_runs: 10,
            failures: 4,
            evidence_weight: 8.0,
            weighted_pass_rate: 0.6,
            mean_cost_usd: 0.02,
            cost_per_success_usd: 0.033333,
            why: "RETIRED by its provider on 2025-12-31, can't be called",
          },
        ],
        forecast: {
          runs_per_month: 960,
          monthly_saving_usd: 29.4,
          extra_failures_per_month: 8.6,
          note: "negative saving = costs more; negative extra failures = fewer failures",
        },
        warnings: [
          "acme-old-2025-01-01 is DEPRECATED and shuts down on 2026-11-05.",
          "Your current model regressed: accuracy dropped by 6.2% on invoice extraction.",
        ],
        evidence: {
          n_runs: 820,
          evidence_weight: 812.5,
          failures: 31,
          recent_failing_runs: [
            {
              run_id: "00000000-0000-0000-0001-000000000005",
              model_version: "2026-09",
              outcome_reason: "total: expected 1250.00, got 1205.00",
              created_at: "2026-10-15T18:30:00Z",
            },
            {
              run_id: "00000000-0000-0000-0001-000000000012",
              model_version: "2026-09",
              outcome_reason: "date: expected 2026-10-14, got null",
              created_at: "2026-10-15T14:15:00Z",
            },
            {
              run_id: "00000000-0000-0000-0001-000000000028",
              model_version: "2026-09",
              outcome_reason: "vendor: expected 'ShopCo', got 'Shop LLC'",
              created_at: "2026-10-14T20:45:00Z",
            },
            {
              run_id: "00000000-0000-0000-0001-000000000041",
              model_version: "2026-09",
              outcome_reason: "total: expected 850.50, got 850.00",
              created_at: "2026-10-14T11:00:00Z",
            },
          ],
        },
      };
      return HttpResponse.json(rec);
    }

    if (jobName === "ticket-classify") {
      const rec: Recommendation = {
        job: "ticket-classify",
        current_model: "mini",
        rules: { evidence_floor: 25.0, tolerance: 0.02 },
        verdict: "INSUFFICIENT_EVIDENCE",
        candidates: [
          {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 12,
            failures: 1,
            evidence_weight: 11.0,
            weighted_pass_rate: 0.9167,
            mean_cost_usd: 0.003,
            cost_per_success_usd: 0.003273,
          },
        ],
        excluded: [
          {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 12,
            failures: 1,
            evidence_weight: 11.0,
            weighted_pass_rate: 0.9167,
            mean_cost_usd: 0.003,
            cost_per_success_usd: 0.003273,
            why: "not enough evidence yet (11.0 of 25.0)",
          },
        ],
        progress: "11 of 25 weighted runs",
        next_step: "Record more runs, or start a re-test to gather evidence sooner",
      };
      return HttpResponse.json(rec);
    }

    if (jobName === "receipt-scan") {
      const rec: Recommendation = {
        job: "receipt-scan",
        current_model: "mini",
        rules: { evidence_floor: 25.0, tolerance: 0.02 },
        verdict: "HOLD",
        recommended: { model: "mini", model_version: "2026-09" },
        comparison: {
          recommended: {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 180,
            failures: 5,
            evidence_weight: 175.0,
            weighted_pass_rate: 0.972,
            mean_cost_usd: 0.0028,
            cost_per_success_usd: 0.0029,
            eligible: true,
          },
          current: {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 180,
            failures: 5,
            evidence_weight: 175.0,
            weighted_pass_rate: 0.972,
            mean_cost_usd: 0.0028,
            cost_per_success_usd: 0.0029,
            eligible: true,
          },
        },
        candidates: [
          {
            model: "mini",
            latest_version: "2026-09",
            catalog_status: "ACTIVE",
            shutdown_date: null,
            n_runs: 180,
            failures: 5,
            evidence_weight: 175.0,
            weighted_pass_rate: 0.972,
            mean_cost_usd: 0.0028,
            cost_per_success_usd: 0.0029,
            eligible: true,
          },
        ],
        excluded: [],
        evidence: {
          n_runs: 180,
          evidence_weight: 175.0,
          failures: 5,
          recent_failing_runs: [],
        },
        forecast: null,
      };
      return HttpResponse.json(rec);
    }

    return HttpResponse.json({ detail: "Job not found" }, { status: 404 });
  }),

  // GET /v1/insights/spend
  http.get("/v1/insights/spend", async ({ request }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const spendData: SpendInsight[] = [
      { job: "invoice-extract", runs: 964, spend_usd: 18.42, share: 0.785 },
      { job: "ticket-classify", runs: 120, spend_usd: 3.85, share: 0.164 },
      { job: "receipt-scan", runs: 180, spend_usd: 1.18, share: 0.051 },
    ];

    return HttpResponse.json(spendData);
  }),

  // GET /v1/jobs/:job/regressions
  http.get("/v1/jobs/:job/regressions", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const jobName = decodeURIComponent(String(params.job));

    if (jobName === "invoice-extract") {
      const alerts: RegressionAlert[] = [
        {
          alert_id: "alert_reg_001",
          job_id: "invoice-extract",
          kind: "VERSION_REGRESSION",
          detail: {
            model: "max",
            old_version: "2026-06",
            new_version: "2026-09",
            old_pass_rate: 0.975,
            new_pass_rate: 0.909,
            n_old: 360,
            n_new: 450,
            p_value: 0.0004,
            summary: "max dropped from 97.5% to 90.9% when 2026-06 → 2026-09 (p=0.0004)",
          },
          resolved_at: null,
          created_at: "2026-10-15T09:00:00Z",
        },
        {
          alert_id: "alert_reg_002",
          job_id: "invoice-extract",
          kind: "VERSION_REGRESSION",
          detail: {
            model: "turbo",
            old_version: "2026-07",
            new_version: "2026-08",
            old_pass_rate: 0.960,
            new_pass_rate: 0.885,
            n_old: 200,
            n_new: 210,
            p_value: 0.0012,
            summary: "turbo dropped from 96.0% to 88.5% when 2026-07 → 2026-08 (p=0.0012)",
          },
          resolved_at: "2026-09-18T14:00:00Z",
          created_at: "2026-09-15T10:00:00Z",
        },
      ];
      return HttpResponse.json(alerts);
    }

    return HttpResponse.json([]);
  }),

  // GET /v1/jobs/:job/history
  http.get("/v1/jobs/:job/history", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const jobName = decodeURIComponent(String(params.job));

    if (jobName === "invoice-extract") {
      const history: HistoryEntry[] = [
        {
          recommendation_id: "rec_ie_003",
          job_id: "invoice-extract",
          model: "mini",
          model_version: "2026-09",
          verdict: "DOWNGRADE",
          weighted_pass_rate: 0.962,
          cost_per_success: 0.0032,
          n_runs: 820,
          evidence_weight: 812.5,
          n_source_runs: 820,
          superseded_by_id: null,
          supersession_reason: null,
          valid_at: "2026-10-15T09:30:00Z",
          invalid_at: null,
        },
        {
          recommendation_id: "rec_ie_002",
          job_id: "invoice-extract",
          model: "max",
          model_version: "2026-09",
          verdict: "HOLD",
          weighted_pass_rate: 0.909,
          cost_per_success: 0.0382,
          n_runs: 450,
          evidence_weight: 430.2,
          n_source_runs: 450,
          superseded_by_id: "rec_ie_003",
          supersession_reason: "REGRESSION",
          valid_at: "2026-09-01T12:00:00Z",
          invalid_at: "2026-10-15T09:30:00Z",
        },
        {
          recommendation_id: "rec_ie_001",
          job_id: "invoice-extract",
          model: "max",
          model_version: "2026-06",
          verdict: "HOLD",
          weighted_pass_rate: 0.975,
          cost_per_success: 0.0356,
          n_runs: 360,
          evidence_weight: 350.0,
          n_source_runs: 360,
          superseded_by_id: "rec_ie_002",
          supersession_reason: "MODEL_UPGRADE",
          valid_at: "2026-06-15T08:00:00Z",
          invalid_at: "2026-09-01T12:00:00Z",
        },
      ];
      return HttpResponse.json(history);
    }

    if (jobName === "receipt-scan") {
      const history: HistoryEntry[] = [
        {
          recommendation_id: "rec_rs_001",
          job_id: "receipt-scan",
          model: "mini",
          model_version: "2026-09",
          verdict: "HOLD",
          weighted_pass_rate: 0.972,
          cost_per_success: 0.0029,
          n_runs: 180,
          evidence_weight: 175.0,
          n_source_runs: 180,
          superseded_by_id: null,
          supersession_reason: null,
          valid_at: "2026-09-20T10:00:00Z",
          invalid_at: null,
        },
      ];
      return HttpResponse.json(history);
    }

    if (jobName === "ticket-classify") {
      return HttpResponse.json([]);
    }

    return HttpResponse.json({ detail: "Job not found" }, { status: 404 });
  }),

  // GET /v1/retest/limits
  http.get("/v1/retest/limits", async ({ request }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const limits: RetestLimits = {
      monthly_cap_usd: 10.0,
      spent_this_month_usd: 3.2,
      cap_remaining_usd: 6.8,
    };
    return HttpResponse.json(limits);
  }),

  // POST /v1/jobs/:job/retest
  http.post("/v1/jobs/:job/retest", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const jobName = decodeURIComponent(String(params.job));
    const targetJob = jobs.find((j) => j.name === jobName);

    if (targetJob && targetJob.retest_consent === false) {
      return HttpResponse.json(
        { detail: "Re-tests are switched off for this job" },
        { status: 403 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      candidate_model?: string;
      budget_usd?: number;
    };

    if (
      !body.candidate_model ||
      typeof body.budget_usd !== "number" ||
      body.budget_usd <= 0 ||
      body.budget_usd > 6.8
    ) {
      return HttpResponse.json(
        {
          detail:
            "Budget must be greater than 0 and not exceed remaining cap of $6.80",
        },
        { status: 422 },
      );
    }

    const retestId = crypto.randomUUID();
    const newRetest: RetestStatus = {
      retest_id: retestId,
      job: jobName,
      candidate_model: body.candidate_model,
      status: "QUEUED",
      budget_usd: body.budget_usd,
      spent_usd: 0,
      monthly_cap_usd: 10.0,
      cap_remaining_usd: 6.8,
      runs_planned: 40,
      runs_done: 0,
      passed: 0,
      failed: 0,
      pass_rate: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      message: null,
    };

    retests.set(retestId, newRetest);
    return HttpResponse.json(newRetest, { status: 202 });
  }),

  // GET /v1/jobs/:job/retest/:retest_id
  http.get("/v1/jobs/:job/retest/:retest_id", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const retestId = String(params.retest_id);
    const record = retests.get(retestId);

    if (!record) {
      return HttpResponse.json({ detail: "Re-test not found" }, { status: 404 });
    }

    // Advance progress on each GET
    if (record.status === "QUEUED") {
      record.status = "RUNNING";
    } else if (record.status === "RUNNING") {
      const remainingBudget = record.budget_usd - record.spent_usd;
      const maxAffordableRuns = Math.floor(remainingBudget / 0.04);

      if (maxAffordableRuns <= 0) {
        record.status = "STOPPED_BUDGET";
        record.message = "Stopped: budget reached";
        record.spent_usd = record.budget_usd;
        record.finished_at = new Date().toISOString();
      } else {
        const runsRemaining = record.runs_planned - record.runs_done;
        const runsToAdd = Math.min(6, runsRemaining, maxAffordableRuns);

        const newPassed = Math.round(runsToAdd * 0.85);
        const newFailed = runsToAdd - newPassed;

        record.passed += newPassed;
        record.failed += newFailed;
        record.runs_done += runsToAdd;
        record.spent_usd = Math.min(
          record.budget_usd,
          Number((record.spent_usd + runsToAdd * 0.04).toFixed(4)),
        );
        record.pass_rate =
          record.runs_done > 0
            ? Number((record.passed / record.runs_done).toFixed(4))
            : null;

        if (record.runs_done >= record.runs_planned) {
          record.status = "DONE";
          record.finished_at = new Date().toISOString();
        } else if (record.spent_usd >= record.budget_usd || maxAffordableRuns < 6) {
          record.status = "STOPPED_BUDGET";
          record.message = "Stopped: budget reached";
          record.spent_usd = record.budget_usd;
          record.finished_at = new Date().toISOString();
        }
      }
    }

    return HttpResponse.json(record);
  }),

  // GET /v1/me
  http.get("/v1/me", async () => {
    await delay(350);
    if (!isMockSignedIn()) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const user: User = {
      user_id: "usr_demo_1001",
      email: "mahi@example.com",
      name: "Mahi Demo",
      picture_url: null,
    };
    return HttpResponse.json(user);
  }),

  // POST /auth/logout
  http.post("/auth/logout", async () => {
    await delay(350);
    try {
      localStorage.removeItem("mcm_mock_signed_in");
    } catch {
      /* storage unavailable: ignore */
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // GET /v1/projects
  http.get("/v1/projects", async () => {
    await delay(350);
    if (!isMockSignedIn()) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    return HttpResponse.json(projects);
  }),

  // GET /v1/projects/:project_id
  http.get("/v1/projects/:project_id", async ({ params }) => {
    await delay(350);
    if (!isMockSignedIn()) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const id = String(params.project_id);
    const project = projects.find((p) => p.project_id === id);
    if (!project) {
      return HttpResponse.json({ detail: "Project not found" }, { status: 404 });
    }
    return HttpResponse.json(project);
  }),

  // POST /v1/projects
  http.post("/v1/projects", async ({ request }) => {
    await delay(350);
    if (!isMockSignedIn()) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const body = (await request.json().catch(() => ({}))) as { name?: string };
    const name = (body.name || "").trim();
    if (name.length < 1 || name.length > 60) {
      return HttpResponse.json(
        { detail: "Name must be between 1 and 60 characters" },
        { status: 422 },
      );
    }
    const apiKey = generateApiKey();
    const keyPrefix = apiKey.slice(0, 12);
    const newProject: Project = {
      project_id: crypto.randomUUID(),
      name,
      webhook_url: null,
      retest_monthly_cap_usd: 10,
      retest_allowed: true,
      key_prefix: keyPrefix,
      created_at: new Date().toISOString(),
    };
    projects.push(newProject);
    return HttpResponse.json({ project: newProject, api_key: apiKey }, { status: 201 });
  }),

  // PATCH /v1/projects/:project_id
  http.patch("/v1/projects/:project_id", async ({ request, params }) => {
    await delay(350);
    if (!isMockSignedIn()) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const id = String(params.project_id);
    const project = projects.find((p) => p.project_id === id);
    if (!project) {
      return HttpResponse.json({ detail: "Project not found" }, { status: 404 });
    }
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      webhook_url?: string | null;
      retest_monthly_cap_usd?: number;
      retest_allowed?: boolean;
    };
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name.length < 1 || name.length > 60) {
        return HttpResponse.json(
          { detail: "Name must be between 1 and 60 characters" },
          { status: 422 },
        );
      }
      project.name = name;
    }
    if (body.webhook_url !== undefined) {
      const url = body.webhook_url ? body.webhook_url.trim() : null;
      if (url && !url.startsWith("https://")) {
        return HttpResponse.json(
          { detail: "Webhook URL must start with https://" },
          { status: 422 },
        );
      }
      project.webhook_url = url || null;
    }
    if (body.retest_monthly_cap_usd !== undefined) {
      const cap = Number(body.retest_monthly_cap_usd);
      if (isNaN(cap) || cap < 0 || cap > 500) {
        return HttpResponse.json(
          { detail: "Monthly re-test cap must be between 0 and 500" },
          { status: 422 },
        );
      }
      project.retest_monthly_cap_usd = cap;
    }
    if (body.retest_allowed !== undefined) {
      project.retest_allowed = Boolean(body.retest_allowed);
    }
    return HttpResponse.json(project);
  }),

  // POST /v1/projects/:project_id/key
  http.post("/v1/projects/:project_id/key", async ({ params }) => {
    await delay(350);
    if (!isMockSignedIn()) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const id = String(params.project_id);
    const project = projects.find((p) => p.project_id === id);
    if (!project) {
      return HttpResponse.json({ detail: "Project not found" }, { status: 404 });
    }
    const newApiKey = generateApiKey();
    project.key_prefix = newApiKey.slice(0, 12);
    return HttpResponse.json({ api_key: newApiKey });
  }),
];
