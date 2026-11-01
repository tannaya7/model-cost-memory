import { delay, http, HttpResponse } from "msw";
import type {
  UsageLimit,
  LabelCreate,
  Job,
  Model,
  Run,
  RunDetail,
  Recommendation,
  SpendInsight,
  Alert,
  AuthConfig,
  JobInsights,
  History,
  HistoryEntry,
  RetestStatus,
  RetestLimits,
  User,
  Project,
} from "../shared/api/types";
import initialJobs from "./jobs.sample.json";
import sampleRunsData from "./runs.sample.json";
import sampleModelsData from "./models.sample.json";
import sampleRecommendation from "./recommendation.sample.json";

const models: Model[] = [...(sampleModelsData.items as Model[])];

function isAuthorized(request: Request): boolean {
  const apiKey = request.headers.get("x-api-key") || "";
  const auth = request.headers.get("authorization") || "";
  const bearerKey = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const key = apiKey || bearerKey;
  return key === "demo-key" || key.startsWith("mcm_");
}

// The mock "signed in" flag lives in localStorage (in-browser mock) and in a cookie,
// because the Vite fallback mock runs in Node and can only see the request's cookies.
function isMockSignedIn(request?: Request): boolean {
  const cookie = request?.headers.get("cookie") ?? "";
  if (/(?:^|;\s*)mcm_mock_signed_in=true(?:;|$)/.test(cookie)) return true;
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
    webhook_secret: "whsec_mock_secret",
    retest_monthly_cap_usd: 10,
    retest_allowed: true,
    key_prefix: "mcm_live_prod",
    created_at: "2026-09-01T00:00:00Z",
  },
  {
    project_id: "00000000-0000-0000-0000-000000000002",
    name: "staging",
    webhook_url: null,
    webhook_secret: "whsec_mock_secret",
    retest_monthly_cap_usd: 50,
    retest_allowed: false,
    key_prefix: "mcm_live_stag",
    created_at: "2026-09-15T00:00:00Z",
  },
];

// In-memory jobs list seeded from jobs.sample.json
const jobs: Job[] = [...(initialJobs as Job[])];
const retests = new Map<string, RetestStatus>();
let mockProviderKey: RetestLimits["provider_key"] = null;

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

const mockAlerts: Alert[] = [
  {
    alert_id: "00000000-0000-0000-0004-000000000001",
    job: "invoice-extract",
    kind: "VERSION_REGRESSION",
    summary: "acme-large: pass rate fell from 97.5% to 90.9% after acme-large-2026-01-10 was replaced by acme-large-2026-06-01",
    detail: {
      model: "acme-large",
      old_version: "acme-large-2026-01-10",
      new_version: "acme-large-2026-06-01",
      old_pass_rate: 0.975,
      new_pass_rate: 0.909,
      n_old: 360,
      n_new: 450,
      drop: 0.066,
      p_value: 0.0004,
      failing_run_ids: [],
    },
    created_at: "2026-10-15T09:00:00Z",
    delivered_at: "2026-10-15T09:01:00Z",
    delivery_attempts: 1,
    resolved_at: null,
  },
  {
    alert_id: "00000000-0000-0000-0004-000000000002",
    job: "invoice-extract",
    kind: "SILENT_DROP",
    summary: "acme-mini-2026-08-15: pass rate fell from 99.0% to 92.0% with no version change",
    detail: {
      model: "acme-mini",
      model_version: "acme-mini-2026-08-15",
      before_pass_rate: 0.99,
      after_pass_rate: 0.92,
      n_before: 300,
      n_after: 300,
      drop: 0.07,
      p_value: 0.0001,
    },
    created_at: "2026-09-15T10:00:00Z",
    delivered_at: null,
    delivery_attempts: 3,
    resolved_at: "2026-09-18T14:00:00Z",
  },
];

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

  // POST /v1/runs/:run_id/label (same rules as the backend's ingest.label_run)
  http.post("/v1/runs/:run_id/label", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const run = runs.find((r) => r.run_id === params.run_id);
    if (!run) {
      return HttpResponse.json({ detail: "Run not found" }, { status: 404 });
    }
    if (run.outcome !== "UNKNOWN") {
      return HttpResponse.json({ detail: "This run already has an outcome" }, { status: 409 });
    }

    const { outcome, reason } = (await request.json()) as LabelCreate;
    run.outcome = outcome;
    run.outcome_reason = `labelled ${outcome}` + (reason ? `: ${reason}` : "");
    if (run.state === "CAPTURED") run.state = "CHECKED";
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

    const base = sampleRecommendation as Recommendation;

    if (jobName === "invoice-extract") {
      // The contract sample, produced by the backend's own engine.
      return HttpResponse.json(base);
    }

    if (jobName === "ticket-classify") {
      const mini = {
        ...base.models[1],
        model: "mini",
        model_version: "mini-2026-09",
        n_runs: 12,
        failures: 1,
        evidence_weight: 11.0,
        effective_n: 11.0,
        weighted_pass_rate: 0.917,
        pass_rate_low: 0.646,
        pass_rate_high: 0.985,
        mean_cost_usd: 0.003,
        cost_per_success_usd: 0.00327,
        status: "BELOW_FLOOR" as const,
        eligible: false,
        why: "Evidence 11.0 of the 25 needed to judge it",
      };
      const rec: Recommendation = {
        ...base,
        job: "ticket-classify",
        verdict: "INSUFFICIENT_EVIDENCE",
        current: { model: "mini", model_version: "mini-2026-09" },
        recommended: null,
        reference: null,
        models: [mini],
        evidence: { n_runs: 12, evidence_weight: 11.0, floor: 25, failing_runs: [] },
        progress: 0.44,
        retest_candidates: [],
        warnings: [],
        next_step: "Record more runs, or run a re-test to gather evidence sooner",
      };
      return HttpResponse.json(rec);
    }

    if (jobName === "receipt-scan") {
      const mini = { ...base.models[1], why: "Highest pass rate we can be sure of" };
      const rec: Recommendation = {
        ...base,
        job: "receipt-scan",
        verdict: "HOLD",
        current: { model: mini.model, model_version: mini.model_version },
        recommended: { model: mini.model, model_version: mini.model_version },
        reference: mini.model,
        models: [mini],
        evidence: { ...base.evidence, failing_runs: [] },
        retest_candidates: [],
        warnings: [],
        next_step: null,
      };
      return HttpResponse.json(rec);
    }

    return HttpResponse.json({ detail: "Job not found" }, { status: 404 });
  }),

  // GET /auth/config
  http.get("/auth/config", () =>
    HttpResponse.json({ google: true, dev_login: false, demo_project_id: null } satisfies AuthConfig),
  ),

  // GET /v1/jobs/:job/insights
  http.get("/v1/jobs/:job/insights", async ({ request, params }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const row = (model: string, group: string, runs: number, rate: number, cost: number) => ({
      model, group, runs, passed: Math.round(runs * rate), pass_rate: rate,
      pass_rate_low: Math.max(0, rate - 0.04), pass_rate_high: Math.min(1, rate + 0.03),
      mean_cost_usd: cost, cost_per_success_usd: cost / rate,
    });
    const insights: JobInsights = {
      job: decodeURIComponent(String(params.job)),
      days: 90,
      overall: [row("acme-large", "all", 640, 0.991, 0.0347), row("acme-mini", "all", 420, 0.99, 0.0031)],
      by_input_size: [
        row("acme-large", "under 8k", 500, 0.994, 0.03), row("acme-large", "8k to 32k", 140, 0.98, 0.05),
        row("acme-mini", "under 8k", 330, 0.997, 0.0025), row("acme-mini", "8k to 32k", 90, 0.92, 0.0052),
      ],
      by_prompt_version: [row("acme-large", "v1", 300, 0.99, 0.0347), row("acme-large", "v2", 340, 0.992, 0.0347),
        row("acme-mini", "v2", 420, 0.99, 0.0031)],
    };
    return HttpResponse.json(insights);
  }),

  // GET /v1/insights/spend
  http.get("/v1/insights/spend", async ({ request }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const spendData: SpendInsight[] = [
      { job: "invoice-extract", runs: 964, spend_usd: 18.42, share: 0.785, unpriced_runs: 0 },
      { job: "ticket-classify", runs: 120, spend_usd: 3.85, share: 0.164, unpriced_runs: 0 },
      { job: "receipt-scan", runs: 180, spend_usd: 1.18, share: 0.051, unpriced_runs: 12 },
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
    const all = new URL(request.url).searchParams.get("include_resolved") === "true";
    return HttpResponse.json(mockAlerts.filter((a) => a.job === jobName && (all || a.resolved_at === null)));
  }),

  // GET /v1/alerts
  http.get("/v1/alerts", async ({ request }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const all = new URL(request.url).searchParams.get("include_resolved") === "true";
    return HttpResponse.json(mockAlerts.filter((a) => all || a.resolved_at === null));
  }),

  // POST /v1/alerts/:alert_id/resolve
  http.post("/v1/alerts/:alert_id/resolve", async ({ request, params }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const alert = mockAlerts.find((a) => a.alert_id === params.alert_id);
    if (!alert) {
      return HttpResponse.json({ detail: "Alert not found" }, { status: 404 });
    }
    alert.resolved_at ??= new Date().toISOString();
    return HttpResponse.json(alert);
  }),

  // GET /v1/jobs/:job/history
  http.get("/v1/jobs/:job/history", async ({ request, params }) => {
    await delay(350);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }

    const jobName = decodeURIComponent(String(params.job));

    const entry = (
      id: number,
      verdict: HistoryEntry["verdict"],
      model: string,
      version: string,
      current: string,
      passRate: number,
      cost: number,
      runs: number,
      validAt: string,
      invalidAt: string | null,
      supersededBy: number | null,
      reason: HistoryEntry["supersession_reason"],
    ): HistoryEntry => ({
      recommendation_id: `00000000-0000-0000-0003-${String(id).padStart(12, "0")}`,
      verdict,
      model,
      model_version: version,
      current_model: current,
      weighted_pass_rate: passRate,
      mean_cost_usd: cost,
      cost_per_success_usd: cost / passRate,
      n_runs: runs,
      evidence_weight: runs * 0.95,
      valid_at: validAt,
      invalid_at: invalidAt,
      superseded_by_id: supersededBy ? `00000000-0000-0000-0003-${String(supersededBy).padStart(12, "0")}` : null,
      supersession_reason: reason,
    });
    const version = (v: string, runs: number, first: string, last: string) => ({
      model: v.split("-20")[0],
      model_version: v,
      runs,
      first_seen: first,
      last_seen: last,
    });

    if (jobName === "invoice-extract") {
      const history: History = {
        job: jobName,
        entries: [
          entry(3, "DOWNGRADE", "acme-mini", "acme-mini-2026-08-15", "acme-large", 0.99, 0.0031, 1084,
            "2026-10-15T09:30:00Z", null, null, null),
          entry(2, "HOLD", "acme-large", "acme-large-2026-06-01", "acme-large", 0.909, 0.0347, 450,
            "2026-09-01T12:00:00Z", "2026-10-15T09:30:00Z", 3, "NEW_EVIDENCE"),
          entry(1, "HOLD", "acme-large", "acme-large-2026-01-10", "acme-large", 0.975, 0.0347, 360,
            "2026-06-15T08:00:00Z", "2026-09-01T12:00:00Z", 2, "MODEL_UPGRADE"),
        ],
        versions: [
          version("acme-large-2026-01-10", 360, "2026-02-01T00:00:00Z", "2026-06-01T00:00:00Z"),
          version("acme-large-2026-06-01", 640, "2026-06-01T00:00:00Z", "2026-10-14T00:00:00Z"),
          version("acme-mini-2026-08-15", 420, "2026-09-10T00:00:00Z", "2026-10-14T00:00:00Z"),
        ],
      };
      return HttpResponse.json(history);
    }

    if (jobName === "receipt-scan") {
      const history: History = {
        job: jobName,
        entries: [
          entry(4, "HOLD", "acme-mini", "acme-mini-2026-08-15", "acme-mini", 0.972, 0.0028, 180,
            "2026-09-20T10:00:00Z", null, null, null),
        ],
        versions: [version("acme-mini-2026-08-15", 180, "2026-09-01T00:00:00Z", "2026-10-14T00:00:00Z")],
      };
      return HttpResponse.json(history);
    }

    if (jobName === "ticket-classify") {
      return HttpResponse.json({ job: jobName, entries: [], versions: [] } satisfies History);
    }

    return HttpResponse.json({ detail: "Job not found" }, { status: 404 });
  }),

  // GET /v1/limits: one plan limit about to run out, with a proven cheaper option
  http.get("/v1/limits", async ({ request }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const now = Date.now();
    const limits: UsageLimit[] = [
      {
        limit_id: "11111111-1111-4111-8111-111111111111",
        name: "Weekly",
        window_hours: 168,
        measure: "PERCENT",
        size: null,
        model: null,
        window_start: new Date(now - 144 * 3_600_000).toISOString(),
        resets_at: new Date(now + 24 * 3_600_000).toISOString(),
        used: 33.6,
        share_used: 0.84,
        rate_per_hour: 0.62,
        hours_to_reset: 24,
        hours_to_full: 10.3,
        state: "AT_RISK",
        message: "At this pace Weekly runs out in 10 h, 14 h before it resets. With the suggested changes it lasts until the reset",
        suggestions: [
          {
            job: "invoice-extract",
            current: "opus-5-5@medium",
            suggested: "sonnet-5@low",
            share_of_use: 0.72,
            reduction: 0.81,
            note: "Shown within 3 points of opus-5-5@medium at 99% confidence; it uses 81% less of this limit per run",
          },
        ],
        hours_to_full_after: null,
        lasts_after: true,
      },
    ];
    return HttpResponse.json(limits);
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
      retest_allowed: true,
      provider_key: mockProviderKey,
    };
    return HttpResponse.json(limits);
  }),

  // PUT /v1/provider-key
  http.put("/v1/provider-key", async ({ request }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const body = (await request.json()) as { provider: string; api_key: string; base_url?: string | null };
    mockProviderKey = {
      provider: body.provider,
      base_url: body.base_url || "https://generativelanguage.googleapis.com/v1beta/openai/",
      key_hint: body.api_key.slice(-4),
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(mockProviderKey);
  }),

  // DELETE /v1/provider-key
  http.delete("/v1/provider-key", async ({ request }) => {
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    mockProviderKey = null;
    return new HttpResponse(null, { status: 204 });
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
        { detail: { code: "consent_off", message: `Re-tests are off for '${jobName}': turn on its re-test consent first` } },
        { status: 409 },
      );
    }
    if (mockProviderKey === null) {
      return HttpResponse.json(
        { detail: { code: "provider_key_required", message: "Add the provider key re-tests should use" } },
        { status: 409 },
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
      trigger: "MANUAL",
      created_at: new Date().toISOString(),
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
  http.get("/v1/me", async ({ request }) => {
    await delay(350);
    if (!isMockSignedIn(request)) {
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
    if (typeof document !== "undefined") {
      document.cookie = "mcm_mock_signed_in=; Max-Age=0; path=/";
    }
    // The Set-Cookie header clears the cookie when the Vite fallback mock answers.
    return new HttpResponse(null, {
      status: 204,
      headers: { "Set-Cookie": "mcm_mock_signed_in=; Max-Age=0; Path=/" },
    });
  }),

  // GET /v1/projects
  http.get("/v1/projects", async ({ request }) => {
    await delay(350);
    if (!isMockSignedIn(request)) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    return HttpResponse.json(projects);
  }),

  // GET /v1/projects/:project_id
  http.get("/v1/projects/:project_id", async ({ request, params }) => {
    await delay(350);
    if (!isMockSignedIn(request)) {
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
    if (!isMockSignedIn(request)) {
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
      webhook_secret: "whsec_mock_secret",
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
    if (!isMockSignedIn(request)) {
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
  http.post("/v1/projects/:project_id/key", async ({ request, params }) => {
    await delay(350);
    if (!isMockSignedIn(request)) {
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
