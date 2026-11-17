/** The numbers the overview widgets show, worked out from the daily points. Pure, so they can be tested. */
import type { DayPoint as ApiDayPoint } from "../../shared/api/types";

/** A daily point with the two fields the backend now adds (optional until the API types are regenerated):
 * `unpriced_runs` (runs whose cost is unknown, not in spend) and `failed_spend_usd` (actual cost of failed runs). */
export type DayPoint = ApiDayPoint & { unpriced_runs?: number; failed_spend_usd?: number };

/** Runs in these points whose cost could not be priced, so they are not in any spend total. */
export function unpricedRuns(points: DayPoint[]): number {
  return points.reduce((s, p) => s + (Number(p.unpriced_runs) || 0), 0);
}

export type Metric = "spend_usd" | "runs" | "passed" | "failed";

const DAY = 86_400_000;
const utcMidnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The last `days` days (today included) and the `days` before them. */
export function periods(points: DayPoint[], days: number, today: Date = new Date()): { cur: DayPoint[]; prev: DayPoint[] } {
  const end = utcMidnight(today);
  const curFrom = end - (days - 1) * DAY;
  const prevFrom = curFrom - days * DAY;
  const cur: DayPoint[] = [];
  const prev: DayPoint[] = [];
  for (const p of points) {
    const t = dayStart(p.day);
    if (t >= curFrom && t <= end) cur.push(p);
    else if (t >= prevFrom && t < curFrom) prev.push(p);
  }
  return { cur, prev };
}

export function sum(points: DayPoint[], metric: Metric): number {
  return points.reduce((s, p) => s + (Number(p[metric]) || 0), 0);
}

/** Share of checked answers that passed, or null when nothing was checked. */
export function passRate(points: DayPoint[]): number | null {
  const passed = sum(points, "passed");
  const checked = passed + sum(points, "failed");
  return checked ? passed / checked : null;
}

/** Relative change from the previous value, or null when there is nothing to compare with. */
export function delta(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / prev;
}

export interface CompareRow {
  day: string;
  cur: number;
  prev: number;
  prevDay: string;
}

/** One row per day of the current period, with the same day of the previous period beside it. */
export function compareSeries(points: DayPoint[], days: number, metric: Metric, today: Date = new Date()): CompareRow[] {
  const end = utcMidnight(today);
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(p.day, (byDay.get(p.day) ?? 0) + (Number(p[metric]) || 0));
  const rows: CompareRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * DAY).toISOString().slice(0, 10);
    const prevDay = new Date(end - (i + days) * DAY).toISOString().slice(0, 10);
    rows.push({ day, cur: byDay.get(day) ?? 0, prev: byDay.get(prevDay) ?? 0, prevDay });
  }
  return rows;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Runs on each weekday (Sunday first). */
export function byWeekday(points: DayPoint[], metric: Metric = "runs"): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const p of points) out[new Date(dayStart(p.day)).getUTCDay()] += Number(p[metric]) || 0;
  return out;
}

/** Totals per job or model, largest first. */
export function splitBy(points: DayPoint[], by: "job" | "model", metric: Metric): Array<{ name: string; value: number }> {
  const totals = new Map<string, number>();
  for (const p of points) totals.set(p[by], (totals.get(p[by]) ?? 0) + (Number(p[metric]) || 0));
  return [...totals].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

/** The points as a CSV file's text, for Export. */
export function toCsv(points: DayPoint[]): string {
  const cols = ["day", "job", "model", "runs", "passed", "failed", "spend_usd"] as const;
  const text = new Set<string>(["day", "job", "model"]);
  // Text columns that start with = + - @ tab or CR are prefixed with ' so a spreadsheet never runs them
  // as a formula (OWASP CSV injection). Numeric columns are left alone so negatives stay numbers.
  const cell = (v: unknown, guard: boolean) => {
    let s = String(v ?? "");
    if (guard && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...points.map((p) => cols.map((c) => cell(p[c], text.has(c))).join(","))].join("\n") + "\n";
}

/** "14 Oct – 13 Nov 2026" for the period ending today. */
export function rangeLabel(days: number, today: Date = new Date()): string {
  const end = new Date(utcMidnight(today));
  const start = new Date(end.getTime() - (days - 1) * DAY);
  const f = (d: Date, year: boolean) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  return `${f(start, start.getUTCFullYear() !== end.getUTCFullYear())} – ${f(end, true)}`;
}

/* ----------------------------------------------------------------------------------------------- */
/* Month-end projection, wasted spend, and the cost of a good answer                                */

export type BudgetStatus = "none" | "ok" | "close" | "over";

/** Where the calendar month is heading: the spend so far, plus the last full 7 days' daily average for
 * each day still to come. An estimate; the first days of a month lean on the previous month's tail.
 * `low` and `high` use the cheapest and the dearest of those 7 days for the days still to come (a plain
 * empirical range, not a statistical interval), and `learning` is true until 7 full days of history exist. */
export function monthProjection(points: DayPoint[], today: Date = new Date(), budget: number | null = null) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = today.getUTCDate();
  const end = utcMidnight(today);
  const monthStart = Date.UTC(y, m, 1);
  let mtd = 0;
  let recent = 0;
  let recentRuns = 0;
  let unpriced = 0;
  let earliest = end;
  const recentDays = new Array<number>(7).fill(0); // spend on each of the last 7 full days
  for (const p of points) {
    const t = dayStart(p.day);
    const spend = Number(p.spend_usd) || 0;
    if (t < earliest) earliest = t;
    if (t >= monthStart && t <= end) {
      mtd += spend;
      unpriced += Number(p.unpriced_runs) || 0;
    }
    if (t >= end - 7 * DAY && t < end) {
      recent += spend;
      recentRuns += Number(p.runs) || 0;
      recentDays[Math.round((end - t) / DAY) - 1] += spend;
    }
  }
  const fullDays = Math.round((end - earliest) / DAY); // full days of history before today
  const dailyRate = recentRuns > 0 ? recent / 7 : mtd / day;
  const projected = mtd + dailyRate * (daysInMonth - day);
  let status: BudgetStatus = "none";
  if (budget !== null && budget > 0) {
    status = projected > budget ? "over" : mtd >= 0.8 * budget || projected >= 0.8 * budget ? "close" : "ok";
  }
  const last = new Date(Date.UTC(y, m, daysInMonth));
  const left = daysInMonth - day;
  return {
    mtd,
    projected,
    low: mtd + Math.min(...recentDays) * left,
    high: mtd + Math.max(...recentDays) * left,
    learning: fullDays < 7,
    unpriced,
    dailyRate,
    day,
    daysInMonth,
    status,
    usedShare: budget !== null && budget > 0 ? mtd / budget : null,
    overBy: budget !== null && projected > budget ? projected - budget : 0,
    monthLabel: new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
    lastDayLabel: last.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
  };
}

/** Money spent on answers that failed their check. Uses the recorded cost of the failed runs
 * (`failed_spend_usd`) where the API gives it. For a point without it, the job-day's spend is split by its
 * share of failed runs instead; `estimated` says whether any figure still came from that split. */
export function wastedSpend(points: DayPoint[]) {
  let spend = 0;
  let wasted = 0;
  let failedRuns = 0;
  let estimated = false;
  const byJob = new Map<string, { wasted: number; spend: number }>();
  for (const p of points) {
    const runs = Number(p.runs) || 0;
    const s = Number(p.spend_usd) || 0;
    const failed = Math.min(Number(p.failed) || 0, runs);
    spend += s;
    failedRuns += failed;
    let w: number;
    if (p.failed_spend_usd !== undefined && p.failed_spend_usd !== null) {
      w = Math.min(Number(p.failed_spend_usd) || 0, s);
    } else {
      w = runs > 0 ? (s * failed) / runs : 0;
      if (failed > 0) estimated = true;
    }
    wasted += w;
    const j = byJob.get(p.job) ?? { wasted: 0, spend: 0 };
    j.wasted += w;
    j.spend += s;
    byJob.set(p.job, j);
  }
  return {
    spend,
    wasted,
    failedRuns,
    estimated,
    unpriced: unpricedRuns(points),
    share: spend > 0 ? wasted / spend : null,
    byJob: [...byJob].map(([name, v]) => ({ name, ...v })).filter((j) => j.wasted > 0).sort((a, b) => b.wasted - a.wasted),
  };
}

export interface UnitCost {
  job: string;
  spend: number;
  passed: number;
  unpriced: number;
  per1k: number | null;
  prevPer1k: number | null;
  change: number | null;
}

const per1k = (spend: number, passed: number) => (passed > 0 ? (spend / passed) * 1000 : null);

/** What 1,000 successful answers cost: spend divided by answers that passed. A cheap model that fails
 * often is not cheap, and this is the figure that shows it. */
export function unitCosts(cur: DayPoint[], prev: DayPoint[]): { all: UnitCost; jobs: UnitCost[] } {
  const make = (job: string, c: DayPoint[], p: DayPoint[]): UnitCost => {
    const spend = sum(c, "spend_usd");
    const passed = sum(c, "passed");
    const now = per1k(spend, passed);
    const before = per1k(sum(p, "spend_usd"), sum(p, "passed"));
    return { job, spend, passed, unpriced: unpricedRuns(c), per1k: now, prevPer1k: before, change: delta(now, before) };
  };
  const names = [...new Set(cur.map((x) => x.job))];
  const jobs = names
    .map((name) => make(name, cur.filter((x) => x.job === name), prev.filter((x) => x.job === name)))
    .sort((a, b) => (b.per1k ?? Infinity) - (a.per1k ?? Infinity) || b.spend - a.spend);
  return { all: make("All jobs", cur, prev), jobs };
}
