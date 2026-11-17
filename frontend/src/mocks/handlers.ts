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
  NewsItem,
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

/** The "staging" project is brand new: it has no jobs, runs or alerts, so the first-visit tour shows there. */
const EMPTY_PROJECT_ID = "00000000-0000-0000-0000-000000000002";
function isEmptyProject(request: Request): boolean {
  return request.headers.get("x-project-id") === EMPTY_PROJECT_ID;
}
/** What the mock "account" has saved about which first-visit guides it has seen (nothing else is kept). */
const mockUiFlags: { tour_seen?: boolean; first_results_seen?: boolean } = {};

const projects: Project[] = [
  {
    project_id: "00000000-0000-0000-0000-000000000001",
    slug: "production",
    name: "production",
    webhook_url: "https://alerts.example.com/webhook",
    webhook_secret: "whsec_mock_secret",
    retest_monthly_cap_usd: 10,
    retest_allowed: true,
    content_retention_days: 90,
    store_tool_arguments: false,
    billing_mode: "per_use",
    key_prefix: "mcm_live_prod",
    created_at: "2026-09-01T00:00:00Z",
  },
  {
    project_id: "00000000-0000-0000-0000-000000000002",
    slug: "staging",
    name: "staging",
    webhook_url: null,
    webhook_secret: "whsec_mock_secret",
    retest_monthly_cap_usd: 50,
    retest_allowed: false,
    content_retention_days: 90,
    store_tool_arguments: false,
    billing_mode: "subscription",
    key_prefix: "mcm_live_stag",
    created_at: "2026-09-15T00:00:00Z",
  },
  {
    project_id: "00000000-0000-0000-0000-000000000003",
    slug: "research",
    name: "research",
    webhook_url: null,
    webhook_secret: "whsec_mock_secret",
    retest_monthly_cap_usd: 10,
    retest_allowed: true,
    content_retention_days: 90,
    store_tool_arguments: false,
    billing_mode: "both",
    key_prefix: "mcm_live_rese",
    created_at: "2026-10-01T00:00:00Z",
  },
  {
    project_id: "00000000-0000-0000-0000-000000000004",
    slug: "assistant",
    name: "assistant",
    webhook_url: null,
    webhook_secret: "whsec_mock_secret",
    retest_monthly_cap_usd: 10,
    retest_allowed: true,
    content_retention_days: 90,
    store_tool_arguments: false,
    billing_mode: "subscription",
    key_prefix: "mcm_live_assi",
    created_at: "2026-10-05T00:00:00Z",
  },
];

/** Same rules as the server: lowercase a-z, 0-9, single hyphens, 3 to 40 characters; -2, -3 on a clash. */
const RESERVED_SLUGS = new Set(["new", "key", "use-key", "settings", "api", "admin", "www", "demo"]);
function uniqueMockSlug(name: string): string {
  const folded = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let base = folded.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  if (base.length < 3) base = "project";
  let slug = base;
  for (let n = 2; RESERVED_SLUGS.has(slug) || projects.some((p) => p.slug === slug); n++) slug = `${base.slice(0, 40 - String(n).length - 1).replace(/-+$/g, "")}-${n}`;
  return slug;
}

// In-memory jobs list seeded from jobs.sample.json
const extraJobs = [
  { check_config: { fields: ["clauses"] }, check_kind: "ANSWER_KEY", description: "Summarise a contract in plain words", job_id: "00000000-0000-0000-0000-000000001004", name: "contract-summary", retest_consent: true, run_count: 640, runs_by_state: { CHECKED: 420, INDEXED: 220 } },
  { check_config: { fields: ["category"] }, check_kind: "ANSWER_KEY", description: "Sort incoming email into folders", job_id: "00000000-0000-0000-0000-000000001005", name: "email-triage", retest_consent: true, run_count: 300, runs_by_state: { CHECKED: 140, INDEXED: 160 } },
] as unknown as Job[];
const jobs: Job[] = [...(initialJobs as Job[]), ...extraJobs];

// One demo history for every screen. The project is 30 days old; every number a screen shows for a task
// (calls on the AI tasks list, the task page, the spend list, the profile, the Overview) is a sum of
// these rows, so the same task always shows the same count.
const HISTORY_DAYS = 30;
const hash01 = (key: string) => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
};
type FixturePlan = { job: string; model: string; perDay: number; pass: number; cost: number; from: number; to: number; inTok: number; outTok: number; cache: number };
// invoice-extract moves from acme-large to acme-mini three weeks ago; acme-large's new version dips for a week.
const DAILY_PLAN: FixturePlan[] = [
  { job: "invoice-extract", model: "acme-large", perDay: 120, pass: 0.975, cost: 0.031, from: HISTORY_DAYS, to: 21, inTok: 3400, outTok: 520, cache: 0.35 },
  { job: "invoice-extract", model: "acme-large", perDay: 35, pass: 0.97, cost: 0.031, from: 21, to: 0, inTok: 3400, outTok: 520, cache: 0.35 },
  { job: "invoice-extract", model: "acme-mini", perDay: 90, pass: 0.962, cost: 0.003, from: 21, to: 0, inTok: 3300, outTok: 480, cache: 0.5 },
  { job: "invoice-extract", model: "acme-mini", perDay: 12, pass: 0.955, cost: 0.003, from: HISTORY_DAYS, to: 21, inTok: 3300, outTok: 480, cache: 0.5 },
  { job: "ticket-classify", model: "mini", perDay: 18, pass: 0.88, cost: 0.0011, from: 14, to: 0, inTok: 900, outTok: 130, cache: 0 },
  { job: "receipt-scan", model: "acme-mini", perDay: 26, pass: 0.985, cost: 0.0024, from: HISTORY_DAYS, to: 0, inTok: 1800, outTok: 260, cache: 0.2 },
  { job: "contract-summary", model: "acme-large", perDay: 24, pass: 0.96, cost: 0.02, from: HISTORY_DAYS, to: 0, inTok: 2600, outTok: 420, cache: 0.3 },
  { job: "email-triage", model: "acme-large", perDay: 14, pass: 0.9, cost: 0.012, from: HISTORY_DAYS, to: 0, inTok: 700, outTok: 60, cache: 0 },
];
type DailyRow = { d: number; day: string; job: string; model: string; runs: number; passed: number; failed: number; spend_usd: number; tokens_in: number; tokens_out: number; cache_read_tokens: number; cache_write_tokens: number; unpriced_runs: number; failed_spend_usd: number };
function buildDailyFixture(): DailyRow[] {
  const out: DailyRow[] = [];
  const today = new Date();
  for (let d = HISTORY_DAYS - 1; d >= 0; d--) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - d)).toISOString().slice(0, 10);
    const weekday = new Date(day).getUTCDay();
    const merged = new Map<string, DailyRow>();
    for (const p of DAILY_PLAN) {
      if (d >= p.from || d < p.to) continue;
      const r = (k: string) => hash01(`${p.job}|${p.model}|${p.from}|${d}|${k}`);
      const runs = Math.round(p.perDay * (weekday === 0 || weekday === 6 ? 0.55 : 1) * (0.85 + r("n") * 0.3));
      const dip = p.model === "acme-large" && p.job === "invoice-extract" && d < 12 && d >= 5 ? 0.06 : 0;
      const rate = Math.min(0.999, p.pass - dip + (r("p") - 0.5) * 0.02);
      const passed = Math.round(runs * rate);
      const unknown = Math.round(runs * 0.01);
      const failed = Math.max(0, runs - passed - unknown);
      const inputTotal = Math.round(runs * p.inTok * (0.9 + r("i") * 0.2));
      const cacheRead = Math.round(inputTotal * p.cache * (0.8 + r("c") * 0.4));
      const key = `${p.job}|${p.model}`;
      const prev = merged.get(key) ?? { d, day, job: p.job, model: p.model, runs: 0, passed: 0, failed: 0, spend_usd: 0, tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cache_write_tokens: 0, unpriced_runs: 0, failed_spend_usd: 0 };
      merged.set(key, {
        ...prev,
        runs: prev.runs + runs,
        passed: prev.passed + passed,
        failed: prev.failed + failed,
        spend_usd: Math.round((prev.spend_usd + runs * p.cost * (0.9 + r("s") * 0.2)) * 100) / 100,
        tokens_in: prev.tokens_in + inputTotal - cacheRead,
        tokens_out: prev.tokens_out + Math.round(runs * p.outTok * (0.9 + r("o") * 0.2)),
        cache_read_tokens: prev.cache_read_tokens + cacheRead,
        cache_write_tokens: prev.cache_write_tokens + (p.cache > 0 ? Math.round(inputTotal * 0.05) : 0),
        // receipt-scan runs on a model with no listed price part of the time: those runs have no cost.
        unpriced_runs: prev.unpriced_runs + (p.job === "receipt-scan" ? Math.round(runs * 0.05) : 0),
        failed_spend_usd: Math.round((prev.failed_spend_usd + failed * p.cost * 1.15) * 100) / 100,
      });
    }
    out.push(...merged.values());
  }
  return out;
}
const DAILY_FIXTURE = buildDailyFixture();
function fixtureTotals(job: string) {
  const mine = DAILY_FIXTURE.filter((r) => r.job === job);
  const sum = (f: (r: DailyRow) => number) => mine.reduce((a, r) => a + f(r), 0);
  return { calls: sum((r) => r.runs), spend: Math.round(sum((r) => r.spend_usd) * 100) / 100, checked: sum((r) => r.passed + r.failed), unpriced: sum((r) => r.unpriced_runs), tokensIn: sum((r) => r.tokens_in), tokensOut: sum((r) => r.tokens_out), cacheRead: sum((r) => r.cache_read_tokens), cacheWrite: sum((r) => r.cache_write_tokens) };
}
// The AI tasks list reads its call counts from the same history.
for (const j of jobs) {
  const t = fixtureTotals(j.name);
  j.run_count = t.calls;
  j.runs_by_state = t.calls ? { CHECKED: Math.min(t.checked, t.calls), INDEXED: Math.max(0, t.calls - t.checked) } : {};
}
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
    importance_score: outcome === "FAIL" ? 2.0 : 1.0,
    weight: Math.exp(-i / 30),
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

let summaryConsent = false;
let summaryDeleted = false;

export const handlers = [
  // GET /v1/jobs
  http.get("/v1/jobs", async ({ request }) => {
    await delay(400);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    return HttpResponse.json(isEmptyProject(request) ? [] : jobs);
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
    const recommendation = url.searchParams.get("recommendation");
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
    if (recommendation) {
      // The runs one verdict rests on: in the sample data, a stable half of the job's runs.
      filtered = filtered.filter((r) => parseInt(r.run_id.slice(-2), 16) % 2 === 0);
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
      importance_score: r.importance_score,
      weight: r.weight,
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
      // The contract sample, produced by the backend's own engine, with the saving forecast the real API
      // adds when both models are priced.
      return HttpResponse.json({
        ...base,
        forecast: base.forecast ?? {
          runs_per_month: 3640,
          monthly_saving_usd: 101.6,
          extra_failures_per_month: 10.9,
          extra_failures_low: 1.8,
          extra_failures_high: 21.4,
        },
      });
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
        next_step: "Record more AI calls, or start a trial to gather evidence sooner",
        sure_enough: { needed: 380, have: 11 },
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

    if (jobName === "contract-summary" || jobName === "email-triage") {
      // Same two models for both: the one in use, and a cheaper one. contract-summary is "worth a trial"
      // (close, not proven); email-triage is plainly unsure (the cheaper model may be a lot worse).
      const big = { ...base.models[0], model: "acme-large", model_version: "acme-large-2026-09", n_runs: 420, failures: 17, evidence_weight: 300, effective_n: 280, weighted_pass_rate: 0.96, pass_rate_low: 0.93, pass_rate_high: 0.977, mean_cost_usd: 0.03, cost_per_success_usd: 0.03125, status: "GOOD_ENOUGH" as const, eligible: true, why: "Highest pass rate we can be sure of" };
      const promisingJob = jobName === "contract-summary";
      const small = { ...base.models[1], model: "acme-mini", model_version: "acme-mini-2026-09", n_runs: promisingJob ? 260 : 120, failures: promisingJob ? 12 : 14, evidence_weight: promisingJob ? 190 : 100, effective_n: promisingJob ? 180 : 90, weighted_pass_rate: promisingJob ? 0.953 : 0.883, pass_rate_low: promisingJob ? 0.91 : 0.81, pass_rate_high: promisingJob ? 0.977 : 0.93, mean_cost_usd: 0.002, cost_per_success_usd: promisingJob ? 0.0021 : 0.00227, status: "UNSURE" as const, eligible: false, why: "Not yet sure it is within 3 points of acme-large, the model in use; a trial would settle it" };
      const rec: Recommendation = {
        ...base,
        job: jobName,
        verdict: "HOLD",
        current: { model: big.model, model_version: big.model_version },
        recommended: { model: big.model, model_version: big.model_version },
        reference: big.model,
        models: [big, small],
        evidence: { n_runs: big.n_runs + small.n_runs, evidence_weight: 490, floor: 25, failing_runs: [] },
        retest_candidates: [small.model],
        forecast: null,
        warnings: [`Not yet sure ${small.model} is within 3 points of ${big.model}, the model in use; a trial of ${small.model} would settle it`],
        next_step: `Try ${small.model} in a trial: not enough evidence yet`,
        promising: promisingJob ? { model: small.model, current: big.model, gap_points: -0.7, low_points: -4.8, high_points: 2.1, more_needed: 340 } : null,
      };
      return HttpResponse.json(rec);
    }

    return HttpResponse.json({ detail: "Job not found" }, { status: 404 });
  }),

  // GET /auth/config
  http.get("/auth/config", () =>
    HttpResponse.json({ google: true, dev_login: false, demo_project_id: null } satisfies AuthConfig),
  ),

  // GET /v1/jobs/:job/profile (what the calls prove, plus the optional AI summary)
  http.get("/v1/jobs/:job/profile", async ({ request, params }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const name = decodeURIComponent(String(params.job));
    const calls = fixtureTotals(name).calls;
    const summary = {
      state: !summaryConsent ? "off" : summaryDeleted ? "deleted" : "ready",
      text: summaryConsent && !summaryDeleted
        ? "This task reads an invoice and pulls out the total amount to pay. It is an extraction task: finding facts in text."
        : null,
      consent: summaryConsent,
      service: "generativelanguage.googleapis.com",
    };
    if (calls < 25) {
      return HttpResponse.json({
        calls, window_days: 30, enough_data: false, models: [], uses_tools: false, works_like_agent: null,
        tool_source: null, multi_agent: false, typical_tokens_in: null, typical_tokens_out: null, summary,
      });
    }
    return HttpResponse.json({
      calls, window_days: 30, enough_data: true, models: ["acme-large", "acme-mini"], uses_tools: false,
      works_like_agent: null, tool_source: null, multi_agent: false, typical_tokens_in: 1840, typical_tokens_out: 96, summary,
    });
  }),

  // PUT /v1/task-summary-consent
  http.put("/v1/task-summary-consent", async ({ request }) => {
    await delay(250);
    const body = (await request.json()) as { enabled: boolean };
    summaryConsent = body.enabled;
    summaryDeleted = false;
    return HttpResponse.json({ state: summaryConsent ? "ready" : "off", text: null, consent: summaryConsent, service: "generativelanguage.googleapis.com" });
  }),

  // DELETE /v1/jobs/:job/summary
  http.delete("/v1/jobs/:job/summary", async () => {
    await delay(200);
    summaryDeleted = true;
    return new HttpResponse(null, { status: 204 });
  }),

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

    const names = [...new Set(DAILY_FIXTURE.map((r) => r.job))];
    const grand = names.reduce((acc, n) => acc + fixtureTotals(n).spend, 0);
    const spendData: SpendInsight[] = names
      .map((n) => ({ job: n, t: fixtureTotals(n) }))
      .sort((x, y) => y.t.spend - x.t.spend)
      .map(({ job, t }) => ({ job, runs: t.calls, spend_usd: t.spend, share: grand ? Math.round((t.spend / grand) * 1000) / 1000 : 0, unpriced_runs: t.unpriced }));

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
    return HttpResponse.json(isEmptyProject(request) ? [] : mockAlerts.filter((a) => all || a.resolved_at === null));
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

  // GET /healthz and /healthz/scheduler: the API is up and the background jobs keep up.
  http.get("/healthz", () => HttpResponse.json({ status: "ok" })),
  http.get("/healthz/scheduler", () => HttpResponse.json({ status: "ok", overdue: {} })),

  // GET /v1/insights/agents: who uses the tokens, the heaviest runs, tool-list size and plain labels.
  http.get("/v1/insights/agents", async () => {
    await delay(250);
    return HttpResponse.json({
      agents: [
        { agent: "researcher", runs: 410, tokens_in: 3_900_000, tokens_out: 420_000, cache_read_tokens: 600_000, spend_usd: 41.2, share: 0.58, models: ["acme-large"], uses_tools: true, works_like_agent: "yes", tool_source: "mcp", tool_servers: ["github", "slack"], top_tools: [{ name: "mcp__github__search_code", calls: 310 }, { name: "mcp__slack__post_message", calls: 44 }], steps_per_task: 8.4 },
        { agent: "writer", runs: 190, tokens_in: 1_100_000, tokens_out: 380_000, cache_read_tokens: 0, spend_usd: 14.7, share: 0.2, models: ["acme-large", "acme-mini"], uses_tools: true, works_like_agent: "yes", tool_source: "tool_list", tool_servers: [], top_tools: [{ name: "search_docs", calls: 120 }], steps_per_task: 3.1 },
        { agent: "unlabelled", runs: 900, tokens_in: 1_200_000, tokens_out: 150_000, cache_read_tokens: 0, spend_usd: 9.9, share: 0.22, models: ["acme-mini"], uses_tools: false, works_like_agent: null, tool_source: null, tool_servers: [], top_tools: [], steps_per_task: null },
      ],
      traces: [
        { trace_id: "task-8841", calls: 38, tokens: 912_000, spend_usd: 11.4, agents: 2, repeated_prompts: true, agent_names: ["researcher", "writer"], multi_agent: true, possible_loop: { step: "the mcp__github__search_code tool", repeats: 6, cost_usd: 1.9, uses_arguments: false } },
        { trace_id: "task-8790", calls: 12, tokens: 240_000, spend_usd: 2.8, agents: 1, repeated_prompts: false, agent_names: ["researcher"], multi_agent: false, possible_loop: null },
      ],
      tools: [
        { job: "invoice-extract", runs: 600, avg_tools_tokens: 12_400, share_of_tokens_in: 0.46 },
        { job: "receipt-scan", runs: 120, avg_tools_tokens: 900, share_of_tokens_in: 0.05 },
      ],
      kinds: { calls: 1500, uses_tools: true, works_like_agent: "yes", tool_source: "mcp", tool_servers: ["github", "slack"], multi_agent: true },
    });
  }),

  // GET /v1/insights/prompt-versions: one task's prompt versions side by side.
  http.get("/v1/insights/prompt-versions", async ({ request }) => {
    await delay(250);
    const url = new URL(request.url);
    const job = url.searchParams.get("job") ?? "";
    const days = Number(url.searchParams.get("days") ?? 30);
    const v = (label: string, kind: "tagged" | "detected", from: number, to: number, o: Record<string, unknown>) => ({
      label, kind, first_seen: new Date(Date.now() - from * 86_400_000).toISOString(), last_seen: new Date(Date.now() - to * 86_400_000).toISOString(),
      calls: 0, typical_tokens_in: 0, typical_tokens_out: 0, cache_read_share: null, priced_calls: 0, unpriced_calls: 0, cost_per_call: null,
      checked: 0, correct_rate: null, rate_low: null, rate_high: null, start_preview: null, ...o,
    });
    if (job === "receipt-scan") {
      return HttpResponse.json({
        job, days, source: "tagged", reason: null,
        versions: [
          v("Version v1", "tagged", 28, 1, { calls: Math.round(fixtureTotals("receipt-scan").calls * 0.64), typical_tokens_in: 1840, typical_tokens_out: 210, cache_read_share: 0.41, priced_calls: Math.round(fixtureTotals("receipt-scan").calls * 0.64), cost_per_call: 0.0123, checked: 120, correct_rate: 0.93, rate_low: 0.87, rate_high: 0.96 }),
          v("Version v2", "tagged", 20, 0, { calls: fixtureTotals("receipt-scan").calls - Math.round(fixtureTotals("receipt-scan").calls * 0.64), typical_tokens_in: 1250, typical_tokens_out: 205, cache_read_share: 0.12, priced_calls: Math.round((fixtureTotals("receipt-scan").calls - Math.round(fixtureTotals("receipt-scan").calls * 0.64)) * 0.83), unpriced_calls: (fixtureTotals("receipt-scan").calls - Math.round(fixtureTotals("receipt-scan").calls * 0.64)) - Math.round((fixtureTotals("receipt-scan").calls - Math.round(fixtureTotals("receipt-scan").calls * 0.64)) * 0.83), cost_per_call: 0.0118, checked: 75, correct_rate: 0.92, rate_low: 0.84, rate_high: 0.96 }),
        ],
        comparison: {
          older: "Version v1", newer: "Version v2", side_by_side: true,
          summary: "Version v2 sends about 32% fewer input tokens than Version v1. It gets back about the same output tokens. The cached share went down from 41% to 12%. The list-price cost per call is about the same. Correct answers look about the same, but only 75 were checked.",
        },
      });
    }
    if (job === "invoice-extract") {
      return HttpResponse.json({
        job, days, source: "detected", reason: null,
        versions: [
          v("Detected version 1", "detected", 29, 12, { calls: Math.round(fixtureTotals("invoice-extract").calls * 0.53), typical_tokens_in: 1900, typical_tokens_out: 140, cache_read_share: 0, priced_calls: Math.round(fixtureTotals("invoice-extract").calls * 0.53), cost_per_call: 0.0061, checked: 18, start_preview: "You are an accounting assistant. Read the invoice below and return the vendor, invoice number, date and total as JSON." }),
          v("Detected version 2", "detected", 12, 0, { calls: fixtureTotals("invoice-extract").calls - Math.round(fixtureTotals("invoice-extract").calls * 0.53), typical_tokens_in: 2350, typical_tokens_out: 190, cache_read_share: 0, priced_calls: fixtureTotals("invoice-extract").calls - Math.round(fixtureTotals("invoice-extract").calls * 0.53), cost_per_call: 0.0079, checked: 14, start_preview: "You are an accounting assistant. Read the invoice carefully, think step by step, then return the vendor, invoice number, date and total as JSON." }),
        ],
        comparison: {
          older: "Detected version 1", newer: "Detected version 2", side_by_side: false,
          summary: "Detected version 2 sends about 24% more input tokens than Detected version 1. It gets back about 36% more output tokens. The list-price cost per call is about 30% higher. There are not enough checked answers yet to compare correct answers.",
        },
      });
    }
    return HttpResponse.json({ job, days, source: "none", reason: "no_change", versions: [], comparison: null });
  }),

  // GET /v1/insights/prompts: the prompts that use the most tokens, and how much of each is the same every call.
  http.get("/v1/insights/prompts", async ({ request }) => {
    await delay(250);
    const url = new URL(request.url);
    const job = url.searchParams.get("job");
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") ?? 3)));
    const days = Number(url.searchParams.get("days") ?? 30);
    const all = [
      { job: "invoice-extract", prompt_version: null, calls: fixtureTotals("invoice-extract").calls, tokens_in: fixtureTotals("invoice-extract").calls * 1835, tokens_out: fixtureTotals("invoice-extract").calls * 243, cache_read_tokens: 0, cache_write_tokens: 0, text_samples: 50, repeated_start_share: 0.62, repeated_end_share: 0.05, repeated_start_preview: "You are an accounting assistant. Read the invoice below and return the vendor, invoice number, date and total as JSON…" },
      { job: "receipt-scan", prompt_version: "v2", calls: fixtureTotals("receipt-scan").calls, tokens_in: fixtureTotals("receipt-scan").calls * 1422, tokens_out: fixtureTotals("receipt-scan").calls * 328, cache_read_tokens: fixtureTotals("receipt-scan").calls * 594, cache_write_tokens: fixtureTotals("receipt-scan").calls * 62, text_samples: 50, repeated_start_share: 0.18, repeated_end_share: 0.36, repeated_start_preview: null },
      { job: "ticket-classify", prompt_version: null, calls: fixtureTotals("ticket-classify").calls, tokens_in: fixtureTotals("ticket-classify").calls * 200, tokens_out: fixtureTotals("ticket-classify").calls * 31, cache_read_tokens: 0, cache_write_tokens: 0, text_samples: 3, repeated_start_share: null, repeated_end_share: null, repeated_start_preview: null },
    ].map((g) => ({ ...g, total_tokens: g.tokens_in + g.tokens_out + g.cache_read_tokens + g.cache_write_tokens }));
    const total = all.reduce((sum, g) => sum + g.total_tokens, 0);
    const groups = all
      .filter((g) => !job || g.job === job)
      .sort((x, y) => y.total_tokens - x.total_tokens)
      .slice(0, limit)
      .map((g) => ({
        ...g,
        share: total ? Math.round((g.total_tokens / total) * 1000) / 1000 : 0,
        avg_tokens_in: Math.round((g.tokens_in / g.calls) * 10) / 10,
        avg_tokens_out: Math.round((g.tokens_out / g.calls) * 10) / 10,
        cache_read_share: g.cache_read_tokens + g.tokens_in ? Math.round((g.cache_read_tokens / (g.cache_read_tokens + g.tokens_in)) * 1000) / 1000 : null,
      }));
    return HttpResponse.json({ days, total_tokens: total, groups });
  }),

  // GET /v1/insights/daily: 60 days per job and model, deterministic. invoice-extract moves from
  // acme-large to acme-mini three weeks ago; acme-large's new version dips for a week.
  http.get("/v1/insights/daily", async ({ request }) => {
    await delay(250);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? 30);
    const onlyJob = url.searchParams.get("job");
    const out = DAILY_FIXTURE.filter((r) => r.d < days && (!onlyJob || r.job === onlyJob)).map(({ d: _d, ...row }) => row);
    return HttpResponse.json(isEmptyProject(request) ? [] : out);
  }),

  // GET /v1/news: a few stories, one naming a model the demo project runs
  http.get("/v1/news", async ({ request }) => {
    await delay(300);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const url = new URL(request.url);
    const source = url.searchParams.get("source");
    const mine = url.searchParams.get("mine") === "true";
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const all: NewsItem[] = [
      {
        item_id: "n1", source: "Acme Labs", kind: "lab", published_at: hoursAgo(2),
        title: "acme-mini gets a new version and a lower price",
        link: "https://example.com/acme-mini", affects: ["acme-mini"],
        summary: "The 2026-11 snapshot cuts input prices by a third and changes default output length.",
      },
      {
        item_id: "n2", source: "Simon Willison", kind: "community", published_at: hoursAgo(5),
        title: "Notes on structured output across five providers",
        link: "https://example.com/structured", affects: [],
        summary: "Which models keep to a JSON schema under load, and which drift after a few thousand calls.",
      },
      {
        item_id: "n3", source: "The Verge", kind: "press", published_at: hoursAgo(26),
        title: "A new open-weight model tops the coding benchmarks",
        link: "https://example.com/open-weights", affects: [],
        summary: "Released under a permissive licence, with a small version that runs on a laptop.",
      },
    ];
    const model = url.searchParams.get("model");
    const job = url.searchParams.get("job");
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const about = (i: NewsItem) => (model ? i.title.includes(model) : i.affects.length > 0);
    const items = all.filter(
      (i) =>
        (!source || i.source === source) &&
        (!(mine || model || job) || about(i)) &&
        (!since || i.published_at >= since) &&
        (!until || i.published_at <= until),
    );
    return HttpResponse.json({
      items,
      sources: [
        { source: "Acme Labs", kind: "lab" },
        { source: "Simon Willison", kind: "community" },
        { source: "The Verge", kind: "press" },
      ],
      your_models: ["acme-large", "acme-mini"],
      updated_at: hoursAgo(0.3),
      next_refresh_at: hoursAgo(0.3 - 10 / 60),
    });
  }),

  // POST /v1/news/refresh
  http.post("/v1/news/refresh", async ({ request }) => {
    await delay(900);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const now = new Date();
    return HttpResponse.json({
      refreshed: true, added: 2, failed_sources: [], updated_at: now.toISOString(),
      next_refresh_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
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
            note: "Shown within 3 points of opus-5-5@medium with very high confidence (about 99.5%, one-sided); it uses 81% less of this limit per run",
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
      email: "demo@example.com",
      name: "Demo user (sample data)",
      picture_url: null,
      ui_flags: { ...mockUiFlags },
    };
    return HttpResponse.json(user);
  }),

  // PATCH /v1/me/ui-flags: only the two first-visit flags, only true or false
  http.patch("/v1/me/ui-flags", async ({ request }) => {
    if (!isMockSignedIn(request)) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if ((k !== "tour_seen" && k !== "first_results_seen") || typeof v !== "boolean") {
        return HttpResponse.json({ detail: "Unknown flag or not true/false" }, { status: 422 });
      }
      mockUiFlags[k] = v;
    }
    return HttpResponse.json({ ...mockUiFlags });
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
    const body = (await request.json().catch(() => ({}))) as { name?: string; billing_mode?: string };
    const name = (body.name || "").trim();
    if (body.billing_mode !== undefined && !["per_use", "subscription", "both"].includes(body.billing_mode)) {
      return HttpResponse.json({ detail: "billing_mode must be per_use, subscription or both" }, { status: 422 });
    }
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
      slug: uniqueMockSlug(name),
      name,
      webhook_url: null,
      webhook_secret: "whsec_mock_secret",
      retest_monthly_cap_usd: 10,
      retest_allowed: true,
      content_retention_days: 90,
      store_tool_arguments: false,
      billing_mode: (body.billing_mode as Project["billing_mode"]) ?? "per_use",
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
      content_retention_days?: number;
      store_tool_arguments?: boolean;
      billing_mode?: string | null;
      monthly_budget_usd?: number | null;
    };
    if (body.monthly_budget_usd !== undefined) {
      (project as unknown as { monthly_budget_usd: number | null }).monthly_budget_usd = body.monthly_budget_usd;
    }
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
    if (body.content_retention_days !== undefined) {
      const days = Number(body.content_retention_days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return HttpResponse.json(
          { detail: "content_retention_days must be between 1 and 3650" },
          { status: 422 },
        );
      }
      project.content_retention_days = days;
    }
    if (body.store_tool_arguments !== undefined) {
      if (typeof body.store_tool_arguments !== "boolean") {
        return HttpResponse.json({ detail: "store_tool_arguments must be true or false" }, { status: 422 });
      }
      project.store_tool_arguments = body.store_tool_arguments;
    }
    if (body.billing_mode !== undefined && body.billing_mode !== null) {
      if (!["per_use", "subscription", "both"].includes(body.billing_mode)) {
        return HttpResponse.json({ detail: "billing_mode must be per_use, subscription or both" }, { status: 422 });
      }
      project.billing_mode = body.billing_mode as Project["billing_mode"];
    }
    return HttpResponse.json(project);
  }),

  // DELETE /v1/projects/:project_id/tool-inputs
  http.delete("/v1/projects/:project_id/tool-inputs", async ({ request, params }) => {
    await delay(350);
    if (!isMockSignedIn(request)) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    if (!projects.some((p) => p.project_id === String(params.project_id))) {
      return HttpResponse.json({ detail: "Project not found" }, { status: 404 });
    }
    return HttpResponse.json({ runs_cleared: 12 });
  }),

  // DELETE /v1/projects/:project_id?confirm=<project_id>
  http.delete("/v1/projects/:project_id", async ({ request, params }) => {
    await delay(350);
    if (!isMockSignedIn(request)) {
      return HttpResponse.json({ detail: "Not signed in" }, { status: 401 });
    }
    const id = String(params.project_id);
    const index = projects.findIndex((p) => p.project_id === id);
    if (index === -1) {
      return HttpResponse.json({ detail: "Project not found" }, { status: 404 });
    }
    if (new URL(request.url).searchParams.get("confirm") !== id) {
      return HttpResponse.json({ detail: "confirm must equal the project id" }, { status: 422 });
    }
    projects.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
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
