/** Token figures for the overview and the job workspace, worked out from the daily points. Pure, so they can be tested. */
import type { DayPoint } from "../../shared/api/types";
import { periods } from "./metrics";

/** A daily point whose token fields may be missing (older servers, or hand-built test data); missing counts as 0. */
export type TokenPoint = Omit<DayPoint, "tokens_in" | "tokens_out" | "cache_read_tokens" | "cache_write_tokens" | "failed_spend_usd" | "unpriced_runs"> & { tokens_in?: number; tokens_out?: number; cache_read_tokens?: number; cache_write_tokens?: number; failed_spend_usd?: number; unpriced_runs?: number };

/** Hint thresholds. */
export const BLOAT_RATIO = 20; // input tokens per output token above which the prompt looks bloated
export const GROWTH_LIMIT = 0.25; // average input per run up this much on the period before
export const CACHE_MIN_AVG_INPUT = 1500; // below this, caching is not worth suggesting
export const CACHE_MAX_SHARE = 0.1; // cache share under this counts as "barely cached"

const DAY = 86_400_000;
const HOUR = 3_600_000;
const n = (v: number | undefined) => Number(v) || 0;

export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  runs: number;
  /** Every token counted: uncached input, output and cache reads and writes. */
  all: number;
}

export function totals(points: TokenPoint[]): Totals {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 0, all: 0 };
  for (const p of points) {
    t.input += n(p.tokens_in);
    t.output += n(p.tokens_out);
    t.cacheRead += n(p.cache_read_tokens);
    t.cacheWrite += n(p.cache_write_tokens);
    t.runs += n(p.runs);
  }
  t.all = t.input + t.output + t.cacheRead + t.cacheWrite;
  return t;
}

export interface TokenPeriods {
  cur: Totals;
  prev: Totals;
  /** Relative change of all tokens, or null with nothing to compare. */
  change: number | null;
}

export function tokenPeriods(points: TokenPoint[], days: number, today: Date = new Date()): TokenPeriods {
  const { cur, prev } = periods(points as DayPoint[], days, today);
  const c = totals(cur as TokenPoint[]);
  const p = totals(prev as TokenPoint[]);
  return { cur: c, prev: p, change: p.all > 0 ? (c.all - p.all) / p.all : null };
}

/** True when any point carries token counts (older servers send none). */
export const hasTokens = (points: TokenPoint[]) => points.some((p) => totals([p]).all > 0);

export interface TokenDay {
  day: string;
  input: number;
  output: number;
  cached: number;
}

/** One row per day of the last `days` days, zeros included. */
export function dailySeries(points: TokenPoint[], days: number, today: Date = new Date()): TokenDay[] {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const by = new Map<string, TokenDay>();
  for (const p of points) {
    const r = by.get(p.day) ?? { day: p.day, input: 0, output: 0, cached: 0 };
    r.input += n(p.tokens_in);
    r.output += n(p.tokens_out);
    r.cached += n(p.cache_read_tokens);
    by.set(p.day, r);
  }
  const rows: TokenDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * DAY).toISOString().slice(0, 10);
    rows.push(by.get(day) ?? { day, input: 0, output: 0, cached: 0 });
  }
  return rows;
}

/** cache_read / (cache_read + uncached input), or null with no input at all. */
export function cacheShare(t: Totals): number | null {
  const d = t.cacheRead + t.input;
  return d > 0 ? t.cacheRead / d : null;
}

/** Input tokens per output token (uncached input plus cache reads), or null with no output. */
export function inputToOutput(t: Totals): number | null {
  return t.output > 0 ? (t.input + t.cacheRead) / t.output : null;
}

/** Average input tokens per run (uncached input plus cache reads), or null with no runs. */
export function avgInputPerRun(t: Totals): number | null {
  return t.runs > 0 ? (t.input + t.cacheRead) / t.runs : null;
}

export interface Consumer {
  name: string;
  tokens: number;
  share: number;
}

/** Tokens per job or model, largest first, each with its share of the whole. */
export function topConsumers(points: TokenPoint[], by: "job" | "model", limit = 3): Consumer[] {
  const m = new Map<string, number>();
  let whole = 0;
  for (const p of points) {
    const t = totals([p]).all;
    whole += t;
    m.set(p[by], (m.get(p[by]) ?? 0) + t);
  }
  return [...m]
    .filter(([, v]) => v > 0)
    .map(([name, tokens]) => ({ name, tokens, share: whole ? tokens / whole : 0 }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Tokens per hour since the start of yesterday (UTC): a window of 24 h plus the part of today gone. An estimate. */
export function burnRate(points: TokenPoint[], now: Date = new Date()): number | null {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterday = new Date(today - DAY).toISOString().slice(0, 10);
  const todayKey = new Date(today).toISOString().slice(0, 10);
  const recent = points.filter((p) => p.day === yesterday || p.day === todayKey);
  const hours = 24 + (now.getTime() - today) / HOUR;
  const all = totals(recent).all;
  return all > 0 ? all / hours : null;
}

export interface LimitLike {
  measure: string;
  used: number | null;
  size: number | null;
  hours_to_full: number | null;
  hours_to_reset: number;
  state: string;
  name: string;
}

export interface LimitRisk {
  name: string;
  /** Hours until full: the limit's own figure when it has one, else worked out from the burn rate. */
  hoursToFull: number | null;
  hoursToReset: number;
  ownEstimate: boolean;
  /** The biggest jobs of the period and the share of its tokens they account for. */
  topJobs: Consumer[];
  topShare: number;
}

/** The first token-measured limit, with how soon it fills and who is to blame. */
export function limitRisk(points: TokenPoint[], limits: LimitLike[], now: Date = new Date()): LimitRisk | null {
  const lim = limits.find((l) => l.measure === "TOKENS");
  if (!lim) return null;
  let hours = lim.hours_to_full;
  const own = hours !== null && hours !== undefined;
  if (!own) {
    const rate = burnRate(points, now);
    hours = rate && lim.size !== null && lim.used !== null ? Math.max(lim.size - lim.used, 0) / rate : null;
  }
  const top = topConsumers(points, "job", 3);
  return { name: lim.name, hoursToFull: hours, hoursToReset: lim.hours_to_reset, ownEstimate: own, topJobs: top, topShare: top.reduce((s, c) => s + c.share, 0) };
}

/* ---------------------------------- optimisation hints ---------------------------------------- */

export type HintId = "bloat" | "growth" | "caching" | "heavy-output";
export interface Hint {
  id: HintId;
  title: string;
  /** The numbers behind the suggestion. */
  facts: string;
  advice: string;
}

const fmt = (v: number) => Math.round(v).toLocaleString("en");

/** Rule-based suggestions from this period against the one before. All are estimates, not promises. */
export function hints(cur: Totals, prev: Totals): Hint[] {
  const out: Hint[] = [];
  const ratio = inputToOutput(cur);
  if (ratio !== null && ratio > BLOAT_RATIO) {
    out.push({
      id: "bloat",
      title: "The prompt may be heavier than the answer needs",
      facts: `${ratio.toFixed(1)} input tokens for each output token (threshold ${BLOAT_RATIO}:1).`,
      advice: "Look for instructions, examples or context that the answer does not use. Trimming them can lower cost; test that quality holds.",
    });
  }
  const a = avgInputPerRun(cur);
  const b = avgInputPerRun(prev);
  if (a !== null && b !== null && b > 0 && (a - b) / b >= GROWTH_LIMIT) {
    out.push({
      id: "growth",
      title: "Input per run is growing",
      facts: `${fmt(b)} to ${fmt(a)} input tokens per run, up ${(((a - b) / b) * 100).toFixed(0)}% on the period before.`,
      advice: "Check whether the prompt, the retrieved context or the documents sent have grown.",
    });
  }
  const share = cacheShare(cur);
  if (a !== null && a > CACHE_MIN_AVG_INPUT && (share === null || share < CACHE_MAX_SHARE)) {
    out.push({
      id: "caching",
      title: "Prompt caching may help",
      facts: `${fmt(a)} input tokens per run on average; ${share === null ? "no" : `${(share * 100).toFixed(1)}%`} of input is served from cache (threshold ${CACHE_MAX_SHARE * 100}%).`,
      advice: "Providers bill cached reads at a fraction of the normal input price, if a shared prompt prefix repeats between runs. The saving depends on how much of the prompt repeats; this is an estimate, not a promise.",
    });
  }
  if (cur.output > cur.input + cur.cacheRead && cur.output > 0) {
    out.push({
      id: "heavy-output",
      title: "Output outweighs input",
      facts: `${fmt(cur.output)} output tokens against ${fmt(cur.input + cur.cacheRead)} input tokens.`,
      advice: "Output tokens usually cost more than input. Ask for shorter answers, a fixed format, or a lower token cap, and check quality afterwards.",
    });
  }
  return out;
}
