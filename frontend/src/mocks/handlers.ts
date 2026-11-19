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

/** What the real API adds to each model: where its price and links come from, and the check against the maker's own page. */
const MAKERS: Record<string, { name: string; docs: string; pricing: string; dep: string }> = {
  anthropic: { name: "Anthropic", docs: "https://platform.claude.com/docs/en/models/overview", pricing: "https://platform.claude.com/docs/en/about-claude/pricing", dep: "https://platform.claude.com/docs/en/about-claude/model-deprecations" },
};
const BASIS = "List price in US dollars per million tokens, standard rate for text. Batch discounts, cached-input rates, long-context tiers and a price that changes on a date are not shown, so your bill can differ.";
const CATALOG_SOURCE = "LiteLLM community price list (not the provider)";
const READ_AT = new Date(Date.now() - 6 * 3_600_000).toISOString();
function mockReference(m: { model: string; provider: string; source: string; price_in_per_mtok: number | null; price_out_per_mtok: number | null }): Model["reference"] {
  const base = { kind: "api_model" as const, price_basis: BASIS, catalog_source: m.source === "MANUAL" ? "Entered by hand" : CATALOG_SOURCE, catalog_synced_at: READ_AT, price_check_stale: false, official_input_per_mtok: null, official_output_per_mtok: null };
  const maker = MAKERS[m.provider];
  if (!maker) return { ...base, maker: null, docs_url: null, pricing_url: null, deprecations_url: null, price_check: "not_checked", price_check_note: "We do not read this provider's own pages yet, so this price is not confirmed against them.", price_checked_at: null };
  const links = { maker: maker.name, docs_url: maker.docs, pricing_url: maker.pricing, deprecations_url: maker.dep, price_checked_at: READ_AT };
  if (m.model.includes("opus")) return { ...base, ...links, price_check: "differs", price_check_note: "The maker's pricing page states a different price. The maker's page is the authority.", official_input_per_mtok: (m.price_in_per_mtok ?? 0) * 0.5, official_output_per_mtok: (m.price_out_per_mtok ?? 0) * 0.5 };
  if (m.model.includes("haiku")) return { ...base, ...links, price_check: "not_readable", price_check_note: "The maker lists this model, but the page lists more than one price for this model (for example by prompt length), so no single price is read. Shown as unknown." };
  if (m.model === "claude-2-1") return { ...base, ...links, price_check: "not_listed", price_check_note: "The maker's pricing page does not list this model." };
  return { ...base, ...links, price_check: "confirmed", price_check_note: "The maker's pricing page states the same price.", official_input_per_mtok: m.price_in_per_mtok, official_output_per_mtok: m.price_out_per_mtok };
}
const models: Model[] = (sampleModelsData.items as unknown as Model[]).map((m) => ({ ...m, reference: mockReference(m) }));

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
const mockUiFlags: { tour_seen?: boolean; first_results_seen?: boolean; welcome_seen?: boolean } = { welcome_seen: true };

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
    budget_timezone: "UTC",
    budget_alert_levels: [85, 95],
    budget_alert_projected: true,
    budget_alert_webhook: false,
    notice_alert_webhook: false,
    ai_summary_consent: false,
    ai_summary_host: "generativelanguage.googleapis.com",
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
    budget_timezone: "UTC",
    budget_alert_levels: [85, 95],
    budget_alert_projected: true,
    budget_alert_webhook: false,
    notice_alert_webhook: false,
    ai_summary_consent: false,
    ai_summary_host: "generativelanguage.googleapis.com",
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
    budget_timezone: "UTC",
    budget_alert_levels: [85, 95],
    budget_alert_projected: true,
    budget_alert_webhook: false,
    notice_alert_webhook: false,
    ai_summary_consent: false,
    ai_summary_host: "generativelanguage.googleapis.com",
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
    budget_timezone: "UTC",
    budget_alert_levels: [85, 95],
    budget_alert_projected: true,
    budget_alert_webhook: false,
    notice_alert_webhook: false,
    ai_summary_consent: false,
    ai_summary_host: "generativelanguage.googleapis.com",
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
/** Tasks made in the empty demo project: it starts with none, and a new one must show up in its list. */
const emptyProjectJobs: Job[] = [];

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

/** What the real API adds next to the counts: where pass/fail came from, the window, the state and the limits. */
const EVIDENCE_NOTES = {
  state: "enough" as const,
  state_note: "Keep the current model. No other model is proven cheaper at the same quality.",
  check: { kind: "deterministic" as const, label: "A saved correct answer", text: "Each answer was compared with a saved correct answer by a fixed rule." },
  window_from: new Date(Date.now() - 16 * 86_400_000).toISOString(),
  window_to: new Date(Date.now() - 3_600_000).toISOString(),
  comparison: "unpaired" as const,
  paired: null,
  limitations: [
    "The models answered different requests, so they are compared as two separate groups (a wider, safer range than comparing the same prompts).",
    "Ranges are statistical approximations at the stated confidence. They describe your past checked answers, not a promise about future ones.",
  ],
};

const MOCK_ORG = "00000000-0000-0000-0000-0000000000aa";

export const handlers = [
  // GET /v1/jobs
  http.get("/v1/jobs", async ({ request }) => {
    await delay(400);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    return HttpResponse.json(isEmptyProject(request) ? emptyProjectJobs : jobs);
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

    const target = isEmptyProject(request) ? emptyProjectJobs : jobs;
    const duplicate = target.some((j) => j.name.toLowerCase() === name.toLowerCase());
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

    target.unshift(newJob);
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
      catalog: { source: CATALOG_SOURCE, last_synced_at: READ_AT, note: "Prices come from a community-maintained list and refresh daily. Where a maker's own pricing page can be read, it is compared with this and shown beside it." },
      official_sources: [
        { source_id: "anthropic", name: "Anthropic: Pricing", provider: "anthropic", url: MAKERS.anthropic.pricing, status: "OK", last_checked_at: READ_AT, last_ok_at: READ_AT, detail: null, model_count: 18, stale: false },
        { source_id: "google", name: "Google: Gemini API pricing", provider: "google", url: "https://aistudio.google.com/docs/pricing", status: "OK", last_checked_at: READ_AT, last_ok_at: READ_AT, detail: null, model_count: 31, stale: false },
        { source_id: "openai", name: "OpenAI: Pricing", provider: "openai", url: "https://developers.openai.com/api/docs/pricing", status: "FETCH_FAILED", last_checked_at: READ_AT, last_ok_at: null, detail: "TimeoutError", model_count: 0, stale: false },
      ],
      kind_note: "This is a list of API models you can call. Coding tools and subscription apps, such as Cursor or Copilot, are not API endpoints, so they are not listed or ranked here.",
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
        // Counts and call-cost percentiles the real API adds: acme-nano has a heavy cost tail and some unpriced calls.
        models: base.models.map((m) => ({
          ...m,
          priced_runs: m.model === "acme-nano" ? Math.round(m.n_runs * 0.8) : m.n_runs,
          unpriced_runs: m.model === "acme-nano" ? m.n_runs - Math.round(m.n_runs * 0.8) : 0,
          retest_runs: m.model === "acme-large" ? 0 : Math.round(m.n_runs * 0.3),
          cost_p50_usd: m.mean_cost_usd != null ? m.mean_cost_usd * 0.8 : null,
          cost_p90_usd: m.mean_cost_usd != null ? m.mean_cost_usd * (m.model === "acme-nano" ? 3.4 : 1.5) : null,
        })),
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
        evidence: { ...EVIDENCE_NOTES, state: "not_enough" as const, state_note: "Not enough checked answers yet to judge the models. This is a valid answer, not a failure.", n_runs: 12, evidence_weight: 11.0, floor: 25, failing_runs: [] },
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
        evidence: { ...EVIDENCE_NOTES, n_runs: big.n_runs + small.n_runs, evidence_weight: 490, floor: 25, failing_runs: [] },
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
    ].map((g) => ({ ...g, total_tokens: g.tokens_in + g.tokens_out + g.cache_read_tokens + g.cache_write_tokens, spend_usd: fixtureTotals(g.job).spend as number | null, unpriced_calls: fixtureTotals(g.job).unpriced }));
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
    // The newer fields: what each total is made of, the exact period, how it was grouped, and prompt text only when asked for.
    const groupBy = url.searchParams.get("group_by") ?? "task_version";
    const showText = url.searchParams.get("show_text") === "true";
    const agentOf = (g: { job: string }) => (g.job === "ticket-classify" ? null : "extractor");
    type Row = Omit<(typeof groups)[number], "prompt_version"> & { prompt_version: string | null; label?: string };
    const rows = groups as Row[];
    const merge = (rows: Row[], key: (r: Row) => string | null, label: (k: string | null) => string): Row[] => {
      const by = new Map<string | null, Row>();
      for (const r of rows) {
        const k = key(r);
        const m = by.get(k);
        by.set(k, m ? { ...m, calls: m.calls + r.calls, tokens_in: m.tokens_in + r.tokens_in, tokens_out: m.tokens_out + r.tokens_out, cache_read_tokens: m.cache_read_tokens + r.cache_read_tokens, cache_write_tokens: m.cache_write_tokens + r.cache_write_tokens, total_tokens: m.total_tokens + r.total_tokens, spend_usd: (m.spend_usd ?? 0) + (r.spend_usd ?? 0), unpriced_calls: m.unpriced_calls + r.unpriced_calls, share: Math.round((m.share + r.share) * 1000) / 1000 } : { ...r, job: groupBy === "task" ? r.job : "", prompt_version: groupBy === "prompt_version" ? r.prompt_version : null, label: label(k) });
      }
      return [...by.values()].sort((x, y) => y.total_tokens - x.total_tokens);
    };
    const grouped: Row[] = groupBy === "agent" ? merge(rows, (r) => agentOf(r), (k) => k ?? "(no agent named)")
      : groupBy === "prompt_version" ? merge(rows, (r) => r.prompt_version, (k) => k ?? "(no version tagged)")
      : groupBy === "task" ? merge(rows, (r) => r.job, (k) => k ?? "")
      : groupBy === "template" ? rows.map((g) => ({ ...g, label: `${agentOf(g) ?? "(no agent named)"} · ${g.job} · ${g.prompt_version ? `version ${g.prompt_version}` : "untagged"}` }))
      : rows.map((g) => ({ ...g, label: g.prompt_version ? `${g.job} · version ${g.prompt_version}` : g.job }));
    const part = (key: string, label: string, tokens: number | null, state: string, calls: number | null = null, note: string | null = null) => ({ key, label, tokens, state, calls, note });
    const totalSpend = rows.reduce((sum, r) => sum + (r.spend_usd ?? 0), 0);
    const rich = grouped.map((g) => ({
      ...g,
      group_by: groupBy,
      agent: groupBy === "agent" ? (g.label === "(no agent named)" ? null : g.label) : groupBy === "template" ? agentOf(g) : null,
      spend_usd: g.spend_usd !== null && g.spend_usd !== undefined && g.spend_usd > 0 ? Math.round(g.spend_usd * 100) / 100 : null,
      priced_calls: g.calls - (g.unpriced_calls ?? 0),
      cost_share: g.spend_usd && totalSpend > 0 ? Math.round((g.spend_usd / totalSpend) * 1000) / 1000 : null,
      grouping_basis: (groupBy === "agent" && g.label === "(no agent named)") || (["task_version", "prompt_version", "template"].includes(groupBy) && !g.prompt_version) ? "untagged" : "named_by_your_code",
      breakdown: [
        part("input", "Input (not cached)", g.tokens_in, "measured"),
        part("cached_input", "Cached input read", g.cache_read_tokens || null, g.cache_read_tokens ? "measured" : "not_reported", g.cache_read_tokens ? g.calls : null),
        part("cache_write", "Cache writes", g.cache_write_tokens || null, g.cache_write_tokens ? "measured" : "not_reported", g.cache_write_tokens ? g.calls : null),
        part("output", "Output", g.tokens_out, "measured", null, "includes reasoning where the provider counts it as output"),
        part("reasoning", "of which reasoning", null, "not_reported"),
        part("tool_use_input", "Tool-use input", null, "not_reported"),
      ],
      ledger_calls: g.calls, no_usage_calls: 0, legacy_calls: 0,
      text_calls: ["task_version", "template"].includes(groupBy) ? g.text_samples * 8 : 0,
      text_samples: ["task_version", "template"].includes(groupBy) ? g.text_samples : 0,
      repeated_start_share: ["task_version", "template"].includes(groupBy) ? g.repeated_start_share : null,
      repeated_end_share: ["task_version", "template"].includes(groupBy) ? g.repeated_end_share : null,
      text_note: ["task_version", "template"].includes(groupBy) ? null : "The repeated-text split is only worked out for one task and prompt version at a time.",
      repeated_start_preview: showText && ["task_version", "template"].includes(groupBy) ? g.repeated_start_preview : null,
    }));
    const end = new Date();
    const notes: Record<string, string> = { task_version: "Grouped by AI task and the prompt version your code tagged.", task: "Grouped by AI task, all prompt versions together.", agent: "Grouped by the agent name your code sent. Calls with no agent name are grouped together.", prompt_version: "Grouped by the prompt version your code tagged, across all tasks.", template: "Grouped by the agent, the AI task and the prompt version your code sent. Only those labels are used: prompt text is never read to decide a group, and no fingerprint of it is stored. Calls with no version are grouped by agent and task only (an estimated grouping)." };
    return HttpResponse.json({
      days, total_tokens: total, groups: rich, period_start: new Date(end.getTime() - days * 86_400_000).toISOString(), period_end: end.toISOString(),
      timezone: "UTC", total_calls: all.reduce((sum, g) => sum + g.calls, 0), group_by: groupBy, grouping_note: notes[groupBy] ?? notes.task_version,
    });
  }),

  // GET /v1/insights/agent-tasks and /v1/insights/agent-task: tasks as trees of calls (analysis only).
  http.get("/v1/insights/agent-tasks", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const q = new URL(request.url).searchParams;
    const days = Number(q.get("days") ?? 30);
    const repeats = Number(q.get("repeats") ?? 5);
    const window = Number(q.get("window") ?? 7);
    const empty = isEmptyProject(request);
    const now = Date.now();
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    const polling = repeats <= 6;
    return HttpResponse.json({
      days, repeats, window, mode: "per_use", repeat_choices: [3, 4, 5, 6, 8, 10], window_choices: [5, 7, 10, 15], min_cohort: 10,
      tasks: empty ? [] : [
        { trace_id: "task-8841", jobs: ["invoice-extract"], agents: ["orchestrator", "planner", "coder", "reviewer"], models: ["acme-large"], first_at: at(50), last_at: at(44),
          totals: { calls: 7, tokens: 15_180, cost_usd: 0.52, unpriced_calls: 0 }, structure: { roots: 1, linked_children: 4, unlinked: 1, no_structure: 1 }, repeated_step: null, repeated_times: null,
          notes: ["1 call names a parent that was not recorded (or points at itself, or forms a cycle), so it is shown apart.", "1 call in this task sent no span ids, so its place in the tree is unknown."] },
        { trace_id: "task-7702", jobs: ["ticket-classify"], agents: ["worker"], models: ["acme-mini"], first_at: at(30), last_at: at(26),
          totals: { calls: 8, tokens: 2_400, cost_usd: 0.012, unpriced_calls: 0 }, structure: { roots: 0, linked_children: 0, unlinked: 0, no_structure: 8 },
          repeated_step: polling ? "the get_status tool" : null, repeated_times: polling ? 6 : null, notes: [] },
      ],
      cohorts: empty ? [] : [
        { job: "invoice-extract", models: ["acme-large"],
          single_agent: { tokens: { tasks: 41, median: 4_200, p25: 3_100, p75: 5_600 }, cost_usd: { tasks: 41, median: 0.14, p25: 0.1, p75: 0.19 } },
          multi_agent: { tokens: { tasks: 18, median: 13_800, p25: 9_900, p75: 17_400 }, cost_usd: { tasks: 18, median: 0.46, p25: 0.33, p75: 0.58 } } },
      ],
      notes: empty ? ["No task with a trace id was recorded in this period. Send a trace_id with each call to see a task as a whole."] : ["2 groups of equivalent tasks have fewer than 10 single-agent or 10 multi-agent tasks, so they are not compared."],
      method: [
        "Structure comes only from the span ids your app sends. A call whose parent was never recorded is shown as 'parent not recorded', never attached to a guess.",
        "Each recorded call is counted once. A call's subtree total is its own usage plus its children's; the task total is every call once, so it never counts a call twice.",
        "A possible repeated call is the same tool and arguments (or the same prompt, when arguments are not stored) at least N times within M consecutive calls. N and M are your choice here, not a measured limit.",
        "Cohorts compare only tasks that are equivalent: the same AI task and the same models, single-agent against multi-agent. They show measured medians in this project. They state no multiplier and do not say multi-agent causes a difference.",
      ],
    });
  }),
  http.get("/v1/insights/agent-task", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const q = new URL(request.url).searchParams;
    const trace = q.get("trace_id") ?? "";
    const now = Date.now();
    const at = (min: number, sec = 0) => new Date(now - min * 60_000 + sec * 1000).toISOString();
    const uid = (n: number) => `00000000-0000-0000-0000-0000000${String(n).padStart(5, "0")}`;
    const tot = (calls: number, tokens: number, cost: number) => ({ calls, tokens, cost_usd: cost, unpriced_calls: 0 });
    const node = (n: number, over: Record<string, unknown>) => ({
      run_id: uid(n), parent_run_id: null, depth: 0, section: "tree", link: "root", reason: null, missing_parent: null, duplicate_span: false, child_count: 0,
      agent: "orchestrator", model: "acme-large", job: "invoice-extract", span_id: `s${n}`, parent_span_id: null, started_at: at(50 - n), latency_ms: 2100, tools: [],
      own: tot(1, 1000, 0.05), subtree: tot(1, 1000, 0.05), ...over,
    });
    if (trace === "task-7702") {
      const calls = Array.from({ length: 6 }, (_, i) => ({ run_id: uid(100 + i), at: at(30 - i * 0.5), gap_seconds: i === 0 ? null : 30, cost_usd: 0.0015, tokens: 300, agent: "worker", model: "acme-mini", failed: null, in_window: true }));
      return HttpResponse.json({
        trace_id: trace, jobs: ["ticket-classify"], agents: ["worker"], models: ["acme-mini"], first_at: at(30), last_at: at(26), totals: tot(8, 2400, 0.012),
        structure: { roots: 0, linked_children: 0, unlinked: 0, no_structure: 8 },
        nodes: Array.from({ length: 8 }, (_, i) => node(100 + i, { section: "no_structure", link: "no_structure", span_id: null, agent: "worker", model: "acme-mini", job: "ticket-classify", tools: ["get_status"], own: tot(1, 300, 0.0015), subtree: tot(1, 300, 0.0015) })),
        repeated: { label: "possible_repeated_call", step: "the get_status tool", basis: "arguments", repeats: 6, in_window: 6, threshold: Number(q.get("repeats") ?? 5), window: Number(q.get("window") ?? 7), calls,
          median_gap_seconds: 30, results_stored: true, distinct_results: 1, failed_calls: 0, cost_usd: 0.009,
          hints: ["This can be valid: polling and retries repeat on purpose. Check the calls before deciding anything.", "The calls are about 30 seconds apart, which is how polling often looks.", "Stored results were mostly the same each time."] },
        notes: [], truncated: false, method: [],
      });
    }
    const nodes = [
      node(1, { depth: 0, child_count: 2, agent: "orchestrator", own: tot(1, 2000, 0.1), subtree: tot(5, 13_000, 0.45), tools: ["delegate"] }),
      node(2, { depth: 1, parent_run_id: uid(1), link: "child", parent_span_id: "s1", child_count: 1, agent: "planner", own: tot(1, 3000, 0.1), subtree: tot(3, 8000, 0.28) }),
      node(3, { depth: 2, parent_run_id: uid(2), link: "child", parent_span_id: "s2", agent: "coder", own: tot(1, 4000, 0.12), subtree: tot(1, 4000, 0.12), tools: ["write_file", "run_tests"] }),
      node(4, { depth: 2, parent_run_id: uid(2), link: "child", parent_span_id: "s2", agent: "reviewer", own: tot(1, 1000, 0.06), subtree: tot(1, 1000, 0.06) }),
      node(5, { depth: 1, parent_run_id: uid(1), link: "child", parent_span_id: "s1", agent: "tester", own: tot(1, 3000, 0.07), subtree: tot(1, 3000, 0.07) }),
      node(6, { section: "unlinked", link: "unlinked", reason: "parent not recorded", missing_parent: "s-41-missing", parent_span_id: "s-41-missing", agent: "summariser", own: tot(1, 1700, 0.05), subtree: tot(1, 1700, 0.05) }),
      node(7, { section: "no_structure", link: "no_structure", span_id: null, agent: null, own: tot(1, 480, 0.02), subtree: tot(1, 480, 0.02) }),
    ];
    return HttpResponse.json({
      trace_id: trace, jobs: ["invoice-extract"], agents: ["orchestrator", "planner", "coder", "reviewer", "tester", "summariser"], models: ["acme-large"], first_at: at(50), last_at: at(44),
      totals: tot(7, 15_180, 0.52), structure: { roots: 1, linked_children: 4, unlinked: 1, no_structure: 1 }, nodes, repeated: null,
      notes: ["1 call names a parent that was not recorded (or points at itself, or forms a cycle), so it is shown apart.", "1 call in this task sent no span ids, so its place in the tree is unknown."],
      truncated: false, method: [],
    });
  }),

  // GET /v1/insights/tool-servers: MCP and tool-server calls from the project's own recorded calls (analysis only).
  http.get("/v1/insights/tool-servers", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
    const empty = isEmptyProject(request);
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000);
    const t = (hoursAgo: number) => new Date(until.getTime() - hoursAgo * 3_600_000).toISOString();
    return HttpResponse.json({
      days, since: since.toISOString(), until: until.toISOString(), job: null, mode: "per_use",
      servers: empty ? [] : [
        { server: "github", certainty: "provider_reported", calls: 412, failed_calls: 9, failure_known_calls: 380, requests: 260, task_runs: 118, first_seen: t(24 * 20), last_seen: t(2),
          request_time_ms: 4200, request_tokens_in: 1_240_000, request_tokens_out: 96_000, request_cache_read_tokens: 410_000, request_cost_usd: 18.42, unpriced_requests: 0,
          tools: [{ name: "search_issues", calls: 240 }, { name: "create_issue", calls: 120 }, { name: "get_file", calls: 52 }], tasks: [{ name: "invoice-extract", calls: 300 }, { name: "ticket-classify", calls: 112 }], providers: ["anthropic"] },
        { server: "slack", certainty: "likely", calls: 38, failed_calls: 0, failure_known_calls: 0, requests: 31, task_runs: 0, first_seen: t(24 * 9), last_seen: t(30),
          request_time_ms: 2600, request_tokens_in: 96_000, request_tokens_out: 7_400, request_cache_read_tokens: 0, request_cost_usd: 1.1, unpriced_requests: 4,
          tools: [{ name: "post_message", calls: 38 }], tasks: [{ name: "ticket-classify", calls: 38 }], providers: ["gemini"] },
      ],
      own_tools: { calls: empty ? 0 : 96, requests: empty ? 0 : 70, tools: empty ? [] : [{ name: "lookup_customer", calls: 60 }, { name: "calculate_total", calls: 36 }] },
      totals: { requests: empty ? 0 : 280, requests_with_several_servers: empty ? 0 : 11, tokens_in: empty ? 0 : 1_300_000, tokens_out: empty ? 0 : 101_000, cache_read_tokens: empty ? 0 : 410_000, cost_usd: empty ? null : 19.3, unpriced_requests: empty ? 0 : 4 },
      support: [
        { key: "anthropic", label: "Anthropic", native: "supported", seen_as: "anthropic", checked_on: "2026-11-18",
          we_read: ["`mcp_tool_use` blocks: the server's name and the tool's name", "`mcp_tool_result.is_error`, to mark a failed call"],
          we_do_not_read: ["`mcp_tool_listing` blocks (the tools a server offered, in the 2026-09-15 beta): not recorded yet, so the size of each server's tool list is unknown"],
          not_reported_by_provider: ["tokens per tool or per server: the response has one `usage` object for the whole request"],
          limits: ["The MCP connector is a beta (`mcp-client-2025-11-20`, `mcp-client-2026-09-15`).", "The token-counting endpoint returns an error for requests that use the MCP connector, so the size of such a request cannot be checked before it is sent; only the response's usage reports it."],
          sources: ["https://platform.claude.com/docs/en/agents-and-tools/mcp-connector", "https://platform.claude.com/docs/en/build-with-claude/token-counting"] },
        { key: "google", label: "Google (Gemini)", native: "unknown", seen_as: "gemini", checked_on: "2026-11-18",
          we_read: ["`functionCall` parts of generateContent answers: a plain tool name. MCP is recognised only if the name carries the server (`mcp__server__tool`), and is then labelled likely"],
          we_do_not_read: ["Interactions API steps, where Remote MCP (`mcp_server` tools) is documented: not recorded yet"],
          not_reported_by_provider: ["tokens per tool or per server", "On the pages checked, a response shape for MCP calls and any per-tool usage are not documented, so they are unknown, not assumed"],
          limits: ["Remote MCP is documented for the Interactions API only, over Streamable HTTP; SSE servers are not supported, and a server name should not contain `-`."],
          sources: ["https://ai.google.dev/gemini-api/docs/function-calling"] },
      ],
      unreadable_calls: 0, truncated: false,
      notes: empty ? ["No tool calls were recorded in this period."] : ["A server marked 'likely MCP' is only guessed from its tool names.",],
      method: [
        "Counts are exact: every tool call the recorder read from a response, once each.",
        "A server is 'provider reported' when the provider's own response named it. When only a tool's name looks like mcp__server__tool it is 'likely MCP': an app can use that spelling for any tool, and a real MCP tool can be named anything.",
        "Request usage is the whole recorded usage of the requests that called the server, shared with everything else in them. Providers report one usage total per request, never tokens per tool, so this is not the tool's own cost.",
        "A request that called two servers is shown under both with its full usage. The total counts each request once, so the rows do not add up to it.",
        "Request time is the median time of those requests. A tool call's own duration is not reported.",
        "The size of a server's tool list is not attributed: providers load it themselves and report one total, so it cannot be split by server here. It is shown as unknown, not estimated.",
      ],
      tool_list_size: "unknown",
    });
  }),

  // GET /v1/insights/changes: what changed against the period before, with coverage and what else was recorded.
  http.get("/v1/insights/changes", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const iso = (offset: number) => new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    const empty = isEmptyProject(request);
    const mk = (start: string, end: string, calls: number, tin: number, tout: number, spend: number | null) => ({
      start, end, days, calls, tokens_in: tin, tokens_out: tout, cache_read_tokens: Math.round(tin * 0.2), priced_calls: Math.round(calls * 0.94),
      spend_usd: spend, calls_with_usage: calls, calls_with_task_id: Math.round(calls * 0.6), days_with_calls: empty ? 0 : days,
    });
    const sub = (request.headers.get("x-mock-billing") ?? "") === "subscription";
    return HttpResponse.json({
      days, mode: "per_use", comparable: !empty,
      current: mk(iso(days), iso(0), empty ? 0 : 5316, empty ? 0 : 6_400_000, empty ? 0 : 900_000, empty || sub ? null : 118.4),
      previous: mk(iso(2 * days), iso(days), empty ? 0 : 3510, empty ? 0 : 4_900_000, empty ? 0 : 700_000, empty || sub ? null : 96.1),
      observations: empty ? [] : [
        { key: "calls", label: "AI calls", unit: "count", before: 3510, after: 5316, change: 1806, change_pct: 51.5, size: "notable", note: null },
        { key: "tokens_in_per_call", label: "Input tokens per call", unit: "tokens", before: 1396, after: 1204, change: -192, change_pct: -13.8, size: "small", note: null },
        { key: "cache_share", label: "Share of input read from the cache", unit: "share", before: 17.2, after: 24.8, change: 7.6, change_pct: null, size: "notable", note: null },
        { key: "repeated_calls", label: "Calls that repeat an earlier call in the same task", unit: "share", before: 2.1, after: 6.4, change: 4.3, change_pct: null, size: "small", note: "Often a retry, but a repeat is all the data can show." },
        { key: "spend_usd", label: "Spend on calls with a known price", unit: "usd", before: 96.1, after: 118.4, change: 22.3, change_pct: 23.2, size: "notable", note: null },
      ],
      model_mix: empty ? [] : [
        { name: "acme-mini", before_share: 12, after_share: 40, change_points: 28, calls_before: 421, calls_after: 2126 },
        { name: "acme-large", before_share: 88, after_share: 60, change_points: -28, calls_before: 3089, calls_after: 3190 },
      ],
      task_mix: [],
      splits: empty ? [] : [{ what: "spend_usd", total_change: 22.3, from_calls: 49.5, from_mix: -31.2, from_per_call: 4.0 }],
      events: empty ? [] : [
        { kind: "new_model", on: iso(4), label: "acme-mini appeared in your calls for the first time", link: "same_time", evidence: null, relates_to: ["model_mix", "calls"] },
        { kind: "prompt_version", on: iso(3), label: "Prompt version v3 of invoice-extract appeared", link: "concentrated", evidence: "In this period, calls on v3 sent 980 input tokens on average and the other invoice-extract calls 1,410. That fits the change. It does not show the wording is the reason for it.", relates_to: ["tokens_in_per_call"] },
      ],
      notes: empty ? [`There were no calls in the ${days} days before, so there is nothing to compare with yet.`] : ["Repeated calls can only be found among the 3,190 calls that carry a task id.", "318 calls in the last 7 days have no known price, so spend leaves them out."],
      not_recorded: ["Changes to this project's settings and to your own code or prompts outside what you tag are not recorded here, so they cannot be listed."],
      basis: "Measured from this project's own calls, whole UTC days only, the last period against the same number of days before it. This shows what changed and what else was recorded at the same time. It cannot show why: a recorded change can coincide with a difference without causing it.",
    });
  }),

  // GET /v1/notices: what the providers' own pages say about models the project uses (information only).
  http.get("/v1/notices", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const checked = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const empty = isEmptyProject(request);
    return HttpResponse.json({
      notices: empty ? [] : [
        {
          notice_id: "00000000-0000-0000-0000-00000000a001", provider: "anthropic", provider_name: "Anthropic", model: "claude-3-5-sonnet-20241022",
          status: "Deprecated", listed_date: "2026-12-20", date_wording: "tentative", deprecated_on: "2026-10-20", replacement: "claude-sonnet-5-5",
          section: "2026-10-20: Claude Sonnet 3.5 model", notice_url: "https://platform.claude.com/docs/en/about-claude/model-deprecations#2026-10-20-claude-sonnet-3-5-model",
          source_name: "Anthropic: Model deprecations", checked_at: checked, informational: true, served_by_known: true, stale_note: null,
          text: "Anthropic lists a tentative retirement date of 20 Dec 2026 for claude-3-5-sonnet-20241022.",
        },
        {
          notice_id: "00000000-0000-0000-0000-00000000a002", provider: "google", provider_name: "Google", model: "gemini-2.5-flash",
          status: "Scheduled", listed_date: "2026-12-01", date_wording: "earliest_possible", deprecated_on: null, replacement: "gemini-3.5-flash-lite",
          section: "Gemini 2.5 Flash models", notice_url: "https://aistudio.google.com/docs/deprecations#gemini-2.5-flash-models",
          source_name: "Google: Gemini deprecations", checked_at: checked, informational: true, served_by_known: false, stale_note: null,
          text: "Google lists 1 Dec 2026 as the earliest possible shutdown date for gemini-2.5-flash, and says it will give advance notice of the exact date.",
        },
      ],
      hosted_elsewhere: [],
      sources: [
        { source_id: "anthropic", name: "Anthropic: Model deprecations", provider: "anthropic", url: "https://platform.claude.com/docs/en/about-claude/model-deprecations", status: "OK", last_checked_at: checked, last_ok_at: checked, detail: null, notice_count: 25, stale: false, covers: "Applies to Anthropic-operated platforms. Amazon Bedrock and Google-managed Google Cloud set their own retirement schedules, so their dates can differ." },
        { source_id: "google", name: "Google: Gemini deprecations", provider: "google", url: "https://aistudio.google.com/docs/deprecations", status: "OK", last_checked_at: checked, last_ok_at: checked, detail: null, notice_count: 56, stale: false, covers: "Applies to the Gemini API. Dates are the earliest possible shutdown dates; other platforms are not covered." },
        { source_id: "openai", name: "OpenAI: Deprecations", provider: "openai", url: "https://developers.openai.com/api/docs/deprecations", status: "OK", last_checked_at: checked, last_ok_at: checked, detail: null, notice_count: 136, stale: false, covers: "Applies to the OpenAI API. Partner platforms are not covered." },
      ],
      note: "Notices are information only. Nothing is changed, replaced or switched for you. Dates are the provider's own wording: 'not sooner than', 'tentative' and 'earliest possible' are never promised dates.",
    });
  }),

  // GET /v1/insights/projection: the month so far (a fact) and a month-end forecast (an estimate), from the fixture history.
  http.get("/v1/insights/projection", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const first = new Date(Date.UTC(y, m, 1));
    const last = new Date(Date.UTC(y, m + 1, 0));
    const next = new Date(Date.UTC(y, m + 1, 1));
    const rows = isEmptyProject(request) ? [] : DAILY_FIXTURE;
    const monthRows = rows.filter((r) => r.day >= first.toISOString().slice(0, 10));
    const actual = Math.round(monthRows.reduce((a, r) => a + r.spend_usd, 0) * 100) / 100;
    const unpriced = monthRows.reduce((a, r) => a + r.unpriced_runs, 0);
    const recent = [1, 2, 3, 4, 5, 6, 7].map((k) => {
      const day = new Date(Date.UTC(y, m, now.getUTCDate() - k)).toISOString().slice(0, 10);
      return { day, spend_usd: Math.round(rows.filter((r) => r.d === k).reduce((a, r) => a + r.spend_usd, 0) * 100) / 100 };
    });
    const values = recent.map((r) => r.spend_usd);
    const active = values.filter((v) => v > 0).length;
    const history = rows.length ? Math.max(...rows.map((r) => r.d)) : 0;
    const left = Math.max(0, (next.getTime() - now.getTime()) / 86_400_000);
    const ok = rows.length > 0 && history >= 7 && active >= 5;
    const round = (v: number) => Math.round(v * 100) / 100;
    const mean = values.reduce((a, v) => a + v, 0) / 7;
    return HttpResponse.json({
      state: rows.length === 0 ? "no_spend" : ok ? "ok" : "not_enough_history",
      reason: rows.length === 0 || ok ? null : history < 7 ? "too_new" : "sparse",
      currency: "USD", timezone: "UTC", month: `${y}-${String(m + 1).padStart(2, "0")}`,
      period_start: first.toISOString(), period_end: next.toISOString(),
      first_day: first.toISOString().slice(0, 10), last_day: last.toISOString().slice(0, 10),
      days_in_month: last.getUTCDate(), day_of_month: now.getUTCDate(), days_left: Math.round(left * 10_000) / 10_000,
      actual_usd: actual, unpriced_runs: unpriced,
      projected_low_usd: ok ? round(actual + Math.min(...values) * left) : null,
      projected_likely_usd: ok ? round(actual + mean * left) : null,
      projected_high_usd: ok ? round(actual + Math.max(...values) * left) : null,
      history_days: history, active_days: active, recent_days: recent,
      data_through: rows.length ? new Date(now.getTime() - 3_600_000).toISOString() : null,
      budget_usd: null, used_share: null, vs_budget: null,
      rule: "Forecast = spend so far this month + the spend per day over the last 7 full days, for each day left. The range uses your lowest and highest of those 7 days. There is no forecast until 7 full days have passed since your first priced call, and it needs priced spend on at least 5 of the last 7 days. It pauses if no call has been recorded for 48 hours. A projected-over warning needs even the low end of the range to be above your budget.",
      data_note: "Spend is counted from calls this app has recorded, at public list prices. A call counts once your app has sent it, so the newest calls, and any delay on your provider's own billing, can be missing. Budget alerts are checked every hour.",
    });
  }),

  // GET /v1/insights/cost-receipt: how the Overview's spend was worked out, from the same fixture history.
  http.get("/v1/insights/cost-receipt", async ({ request }) => {
    await delay(200);
    if (!isAuthorized(request)) {
      return HttpResponse.json({ detail: "Invalid API key" }, { status: 401 });
    }
    const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
    const rows = isEmptyProject(request) ? [] : DAILY_FIXTURE.filter((r) => r.d < days);
    const total = (f: (r: DailyRow) => number) => rows.reduce((a, r) => a + f(r), 0);
    const runs = total((r) => r.runs);
    const passed = total((r) => r.passed);
    const failed = total((r) => r.failed);
    const unpriced = total((r) => r.unpriced_runs);
    const spend = Math.round(total((r) => r.spend_usd) * 100) / 100;
    const failedSpend = Math.round(total((r) => r.failed_spend_usd) * 100) / 100;
    const end = new Date();
    const checkedPriced = Math.max(0, passed + failed - Math.round(unpriced * 0.5));
    return HttpResponse.json({
      currency: "USD", timezone: "UTC", period_start: new Date(end.getTime() - days * 86_400_000).toISOString(), period_end: end.toISOString(), period_days: days,
      runs, passed, failed, unchecked: Math.max(0, runs - passed - failed), excluded: 0, spend_usd: spend, spend_on_failed_checks_usd: failedSpend,
      unpriced_runs: unpriced, unpriced_note: unpriced > 0 ? `${unpriced} unpriced run${unpriced === 1 ? "" : "s"} excluded from this total` : null, partly_priced_runs: 0,
      basis: runs === 0 ? [] : [
        { status: "PRICED", label: "Calculated from the usage the provider reported and a dated list price", runs: runs - unpriced, spend_usd: spend },
        ...(unpriced > 0 ? [{ status: "UNPRICED_UNKNOWN_MODEL", label: "Not priced: no list price is known for this model name", runs: unpriced, spend_usd: null }] : []),
      ],
      price_versions: runs === 0 ? [] : [{
        version_id: "00000000-0000-0000-0000-0000000000a1", model: "acme-mini", provider: "acme", input_per_mtok: 0.25, output_per_mtok: 1.25,
        effective_from: new Date(end.getTime() - 120 * 86_400_000).toISOString(), effective_to: null, source_kind: "SYNC",
        source_url: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        checked_at: new Date(end.getTime() - 3_600_000).toISOString(), applicability: "Public list price from the source above; not a negotiated, discounted or invoice price",
        runs: runs - unpriced, spend_usd: spend,
      }],
      price_versions_checked_at: runs === 0 ? null : new Date(end.getTime() - 3_600_000).toISOString(),
      price_versions_oldest_effective: runs === 0 ? null : new Date(end.getTime() - 120 * 86_400_000).toISOString(),
      cost_per_success: {
        value_usd: passed > 0 ? Math.round((spend / passed) * 1e6) / 1e6 : null,
        formula: "Cost of the priced, checked calls ÷ number of those calls that passed. Unchecked calls and unpriced calls are left out of both numbers.",
        spend_usd: spend, passed, checked_priced_runs: checkedPriced, checked_unpriced_runs: Math.round(unpriced * 0.5), unchecked_runs: Math.max(0, runs - passed - failed),
        reason: passed > 0 ? null : "No call has been checked and priced yet", success_definition: "The answer matches your answer key",
      },
      jobs: [],
      notes: ["Amounts are US dollars at public list prices. They are an estimate from recorded calls, not your invoice, and not a negotiated or discounted price.", "Days are counted in UTC.", "A failed check can be a deliberate test, so spend on failed checks is not called wasted."],
    });
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
  http.post("/v1/jobs/:job/retest/preview", async ({ request, params }) => {
    const body = (await request.json()) as { candidate_model: string; budget_usd: number; sample_size?: number };
    const planned = body.sample_size ?? 40;
    return HttpResponse.json({
      job: String(params.job), candidate_model: body.candidate_model, budget_usd: body.budget_usd, sample_size_requested: planned, can_start: true, blocked: null,
      statements: ["Your live traffic is not touched. Nothing is routed, switched or changed in your app or source code.", "The candidate model is not added to your project or its settings. Only the replay results are recorded, as test runs.", "This runs once, after you confirm, and is not repeated or scheduled."],
      evaluator_kind: "ANSWER_KEY", evaluator: "The task's own answer key: each replayed answer is compared with the saved correct answer, the same rule used for live calls.",
      provider: "openai", destination_host: "api.openai.com", examples: { available: 120, planned, left_out_for_tool_use: 0 },
      data: [
        { kind: "sent", what: `The text of ${planned} past prompts from this task, chosen at random, one per distinct prompt.`, where: "Sent to api.openai.com, the provider behind the key you stored." },
        { kind: "stays", what: "The saved correct answers.", where: "Used here to check each replayed answer. Not sent to the provider." },
        { kind: "never", what: "Other tasks, other projects, labels, tool definitions, tool calls and your project key.", where: "Never sent." },
        { kind: "received", what: "The candidate model's answers.", where: "Stored in this project as test runs, kept for the project's retention (90 days), then deleted." },
      ],
      retention_note: "Your prompts are sent to api.openai.com. How long it keeps them, and whether it uses them to train models, depends on that provider and on your own account settings with it. This product does not know and cannot check that. Read their terms before you confirm.",
      cost: { low_usd: 0.04, high_usd: Math.min(body.budget_usd, 0.31), worst_case_usd: 0.31, budget_usd: body.budget_usd, monthly_cap_remaining_usd: 6.8, note: "Low assumes each answer is about as long as the original. High is the most the calls could cost at their output limits, capped by your budget and this month's cap.", estimated_from: `${planned} sampled prompts; the actual sample is drawn when it runs` },
      price_basis: { source: "this product's catalog list price (not your invoice)" },
      confirmation: "mock-confirmation-token-0123456789", expires_at: new Date(Date.now() + 600000).toISOString(), confirm_minutes: 10,
    });
  }),
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
      if ((k !== "tour_seen" && k !== "first_results_seen" && k !== "welcome_seen") || typeof v !== "boolean") {
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

  // GET /v1/workspaces: a person with no company has only their personal workspace
  http.get("/v1/workspaces", async ({ request }) => {
    if (!isMockSignedIn(request)) return HttpResponse.json({ detail: "Sign in first" }, { status: 401 });
    return HttpResponse.json([
      { kind: "personal", org_id: null, name: "Personal", role: "owner", project_count: 1, member_count: 1 },
      { kind: "company", org_id: MOCK_ORG, name: "Acme Co", role: "owner", project_count: 0, member_count: 2 },
    ]);
  }),
  http.get("/v1/organisations/:org/members", () => HttpResponse.json([
    { user_id: "u-me", email: "demo@example.com", name: "Demo", role: "owner", joined_at: "2026-11-01T00:00:00Z" },
    { user_id: "u-bo", email: "bo@example.com", name: "Bo", role: "member", joined_at: "2026-11-02T00:00:00Z" },
  ])),
  http.get("/v1/organisations/:org/notice", () => HttpResponse.json({
    version: "company-notice-1", min_group_size: 5, acknowledged: false, acknowledged_at: null, required_for_access: false,
    status_counts: { acknowledged: 1, members: 2 },
    sections: [
      { heading: "What the account records", body: ["For each AI call your company's apps send: the time, the model name, token counts and a list-price cost.", "Prompt and answer text are stored only if the app sends them, for each project's retention period (default 90 days)."] },
      { heading: "What it does not record", body: ["No individual employee identity is attached to a call, so there is no spend, usage or ranking for any one person."] },
      { heading: "Your acknowledgment", body: ["If you acknowledge this notice we record which version you were shown and when. It is not your consent."] },
    ],
  })),
  http.get("/v1/organisations/:org/me", () => HttpResponse.json({ role: "owner", job_role: null, job_roles: { engineering: "Engineering", product: "Product", finance: "Finance" }, notice_version: "company-notice-1", notice_acknowledged: false })),
  http.get("/v1/organisations/:org/rollups", () => HttpResponse.json({ min_group_size: 5, members: 2, shown: false, groups: [], not_shown: 2, reason: "A breakdown appears once the company has at least 5 members, so that no one can be picked out. 5 is our own design choice, not a standard.", usage_by_role: null, usage_by_role_note: "Usage or cost by role is not available. It would need each AI call attributed to a person, which this product does not collect." })),
  http.get("/v1/insights/export.csv", ({ request }) => {
    const days = new URL(request.url).searchParams.get("days") ?? "30";
    const body = "day,ai_task,model,runs,passed,failed,unchecked_runs,unpriced_runs,spend_usd,tokens_in,tokens_out,cache_read_tokens,cache_write_tokens,currency,cost_basis,pay_mode,period_start,period_end,filter_ai_task,filter_model\r\n";
    return new HttpResponse(body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="model-cost-memory-production-last-${days}-days.csv"`, "x-export-rows": "0", "x-export-neutralized": "0" } });
  }),
  http.get("/v1/organisations/:org/overview/export.csv", ({ request }) => {
    const days = new URL(request.url).searchParams.get("days") ?? "30";
    return new HttpResponse("section,name\r\n", { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="model-cost-memory-company-last-${days}-days.csv"`, "x-export-rows": "0", "x-export-neutralized": "0" } });
  }),
  http.get("/v1/insights/savings", () => HttpResponse.json({
    mode: "per_use", unit: "usd", as_of: "2026-11-19", jobs_checked: 3, counts: { saving: 1, waiting: 1 },
    entries: [
      { job: "invoice-extract", from_model: "gpt-5", to_model: "gpt-5-mini", switch_date: "2026-10-12", status: "saving", reason: null, reasons: [], window: { days: 28 },
        realized: { metric: "cost per correct answer", unit: "usd", unit_words: "US dollars at list price (not an invoice)", before: 0.0111, after: 0.0067, change: 0.0044, range_low: 0.0031, range_high: 0.0057,
          range_note: "90% range", pass_rate_before: 0.91, pass_rate_after: 0.9, pass_rate_change_low: -0.04, pass_rate_change_high: 0.03, checked_before: 1840, checked_after: 2010, correct_before: 1674, correct_after: 1809,
          price_basis: "billed cost", mix_compared: "96% of the later calls were compared like for like by prompt size" },
        estimated_avoided: { label: "ESTIMATED (a counterfactual, not money you can count)", unit: "usd", correct_answers: 2400, point: 10.56, low: 7.44, high: 13.68,
          what: "What the correct answers given since the change would have cost more or less on the old model, at the per-answer difference measured above.",
          assumptions: ["The same kinds of calls would have been made on the old model, in the same numbers.", "Both periods are priced with the same price table; a price change is not counted as a saving."] },
        data_notes: ["Cache use changed: 12% of input was read from the cache before and 31% after, which moves cost by itself."], progress: null, coverage: null },
      { job: "support-triage", from_model: "claude-sonnet", to_model: "claude-haiku", switch_date: "2026-11-12", status: "waiting",
        reason: "Waiting for 14 comparable days on each side of the change: 28 before, 6 after so far.", reasons: [], window: null, realized: null, estimated_avoided: null, data_notes: [], progress: { days_before: 28, days_after: 6, needed: 14 }, coverage: null },
    ],
    estimated_avoided_total: { label: "ESTIMATED counterfactuals added up. Not money you can count, and separate from the realized changes above", unit: "usd", point: 10.56, low: 7.44, high: 13.68, entries: 1 },
    notes: ["Recommendations, 'promising' labels and trials are never counted. Only calls your app actually made on each model are."],
    method: ["Each task's own cost per correct answer, before and after the day its model changed, over equal periods of whole weeks.", "A saving is shown only when even its cautious end is above zero."],
  })),
  http.get("/v1/organisations/:org/overview", ({ params, request }) => {
    const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
    return HttpResponse.json({
      org_id: params.org, name: "Acme Co", days, since: "2026-10-19T00:00:00Z", until: "2026-11-18T00:00:00Z", your_role: "owner", projects_shown: 3, members: 2,
      totals: { calls: 4200, tokens: 9_800_000, billable_usd: 61.4, billable_basis: "calculated: reported tokens x dated list price; not an invoice", mixed_mode_usd: 12.2, unpriced_calls: 37, has_data: true },
      by_mode: { per_use: { projects: 1, calls: 2500, tokens: 5_000_000, usd: 61.4, unpriced_calls: 12 }, both: { projects: 1, calls: 700, tokens: 1_800_000, usd: 12.2, unpriced_calls: 25 }, subscription: { projects: 1, calls: 1000, tokens: 3_000_000, usd: null, unpriced_calls: 0 } },
      coverage: { calls: 4200, calls_reporting_tokens: 4000, calls_without_token_counts: 200, token_report_share: 0.952, calls_in_money_projects: 3200, calls_priced: 3163, calls_with_task_id: 1500, calls_with_agent_label: 900, task_id_share: 0.357, agent_label_share: 0.214 },
      projects: [
        { project_id: "p-1", slug: "production", name: "Production", pay_mode: "per_use", calls: 2500, tokens: 5_000_000, cost_usd: 61.4, cost_kind: "billable_list_price", unpriced_calls: 12, calls_reporting_tokens: 2400 },
        { project_id: "p-2", slug: "support-bot", name: "Support bot", pay_mode: "both", calls: 700, tokens: 1_800_000, cost_usd: 12.2, cost_kind: "list_price_may_include_flat_plan", unpriced_calls: 25, calls_reporting_tokens: 600 },
        { project_id: "p-3", slug: "coding-assistant", name: "Coding assistant", pay_mode: "subscription", calls: 1000, tokens: 3_000_000, cost_usd: null, cost_kind: "none_flat_plan", unpriced_calls: 0, calls_reporting_tokens: 1000 },
      ],
      trend: Array.from({ length: Math.min(days, 14) }, (_, i) => ({ day: `2026-11-${String(5 + i).padStart(2, "0")}`, calls: 200 + ((i * 37) % 120), tokens: 450_000 + i * 9000, billable_usd: 3 + (i % 4) })),
      tasks: [
        { project: "Production", project_id: "p-1", task: "invoice-extract", calls: 1800, tokens: 3_600_000, cost_usd: 44.2, unpriced_calls: 8, pay_mode: "per_use", label_source: "caller_supplied" },
        { project: "Support bot", project_id: "p-2", task: "triage", calls: 700, tokens: 1_800_000, cost_usd: 12.2, unpriced_calls: 25, pay_mode: "both", label_source: "caller_supplied" },
        { project: null, project_id: null, task: "Other small groups", calls: 14, tokens: 20_000, cost_usd: 0.4, unpriced_calls: 0, pay_mode: null, label_source: "caller_supplied", folded_groups: 3 },
      ],
      models: [{ model: "gpt-5-mini", calls: 3000, tokens: 6_000_000, cost_usd: 50.1, unpriced_calls: 5, flat_plan_calls: 0, label_source: "caller_supplied" }],
      attribution: [
        { dimension: "project", source: "verified", detail: "Set by the project key the app used, which this product issued and can revoke.", coverage_share: 1 },
        { dimension: "task", source: "caller_supplied", detail: "The AI task name the app chose. It could be wrong or changed by anyone holding the project key.", coverage_share: 1 },
        { dimension: "model", source: "caller_supplied", detail: "The model name the app reported for the call. Cost uses that name's list price.", coverage_share: 1 },
        { dimension: "person", source: "not_recorded", detail: "No individual user identity is collected, so there are no per-person figures and none can be derived.", coverage_share: null },
      ],
      chargeback_grade: false,
      notes: ["These are counts and list-price calculations, not invoices.", "Task and model names come from the calling app and can be spoofed by anyone with a project key.", "No prompt or answer text is read for this view."],
    });
  }),
  http.get("/v1/organisations/:org/invites", () => HttpResponse.json([
    { invite_id: "i1", email: "new@example.com", role: "viewer", state: "pending", created_at: "2026-11-18T00:00:00Z", expires_at: "2026-11-25T00:00:00Z" },
  ])),

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
      budget_timezone: "UTC",
      budget_alert_levels: [85, 95],
      budget_alert_projected: true,
      budget_alert_webhook: false,
      notice_alert_webhook: false,
      ai_summary_consent: false,
      ai_summary_host: "generativelanguage.googleapis.com",
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
      budget_timezone?: string | null;
      budget_alert_levels?: number[] | null;
      budget_alert_projected?: boolean | null;
      budget_alert_webhook?: boolean | null;
      notice_alert_webhook?: boolean | null;
      ai_summary_consent?: boolean | null;
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
    if (body.budget_timezone !== undefined && body.budget_timezone !== null) {
      const known = body.budget_timezone === "UTC" || /^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(body.budget_timezone);
      if (!known) return HttpResponse.json({ detail: "budget_timezone: not a known timezone name (for example Europe/Berlin or UTC)" }, { status: 422 });
      project.budget_timezone = body.budget_timezone;
    }
    if (body.budget_alert_levels !== undefined && body.budget_alert_levels !== null) {
      const lv = body.budget_alert_levels;
      if (lv.length > 6 || lv.some((v: number) => !Number.isInteger(v) || v < 1 || v > 100) || new Set(lv).size !== lv.length) {
        return HttpResponse.json({ detail: "levels must be different whole numbers from 1 to 100" }, { status: 422 });
      }
      project.budget_alert_levels = [...lv].sort((a: number, b: number) => a - b);
    }
    if (body.budget_alert_projected !== undefined && body.budget_alert_projected !== null) {
      project.budget_alert_projected = Boolean(body.budget_alert_projected);
    }
    if (body.budget_alert_webhook !== undefined && body.budget_alert_webhook !== null) {
      if (body.budget_alert_webhook && !project.webhook_url) {
        return HttpResponse.json({ detail: "budget_alert_webhook: add a webhook address first, then turn this on" }, { status: 422 });
      }
      project.budget_alert_webhook = Boolean(body.budget_alert_webhook);
    }
    if (body.notice_alert_webhook !== undefined && body.notice_alert_webhook !== null) {
      if (body.notice_alert_webhook && !project.webhook_url) {
        return HttpResponse.json({ detail: "notice_alert_webhook: add a webhook address first, then turn this on" }, { status: 422 });
      }
      project.notice_alert_webhook = Boolean(body.notice_alert_webhook);
    }
    if (body.ai_summary_consent !== undefined && body.ai_summary_consent !== null) {
      project.ai_summary_consent = Boolean(body.ai_summary_consent);
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
