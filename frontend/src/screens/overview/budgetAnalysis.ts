/** What a monthly limit would mean, worked out from the recorded daily spend. Every figure is an estimate
 * from recorded calls at list prices, not a bill. Pure functions, so the rules are easy to test. */
import { BUDGET_FIRST_ALERT, monthProjection, type DayPoint } from "./metrics";

export const BUDGET_SECOND_ALERT = 0.95;
/** A typed limit shown exactly as typed ($1,200.50), not rounded to whole dollars like the spend figures. */
export const exactUsd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
export const ESTIMATE_LABEL = "Estimate from recorded calls at list prices, not your bill.";
/** The most days of history the daily endpoint is asked for here. */
export const HISTORY_DAYS = 90;

const DAY = 86_400_000;
const utcMidnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
const monthName = (t: number) => new Date(t).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });

export type Verdict = "under" | "close" | "over";

export type BudgetAnalysis = {
  limit: number;
  spent: number;
  spentShare: number;
  /** Null while there are fewer than 7 full days of history: no numbers at all then. */
  projection: { low: number; high: number; verdict: Verdict } | null;
  alert85: number;
  alert95: number;
  /** Null unless a projection exists and the limit is not yet reached. */
  daysToLimit: number | null;
  alreadyPassed: boolean;
  /** The recent complete calendar months the history covers, and how many of them went over this limit. */
  backtest: { months: { label: string; spend: number }[]; over: number } | null;
  topTasks: { job: string; spend: number; share: number }[];
  /** Last complete month's spend plus 20%, whole dollars; null with no complete month. */
  suggestion: number | null;
  /** The limit is below what is already spent this month. */
  belowSpent: boolean;
  lastMonthSpend: number | null;
};

export function analyseBudget(points: DayPoint[], limit: number, today: Date = new Date()): BudgetAnalysis {
  const p = monthProjection(points, today, limit);
  const end = utcMidnight(today);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const thisMonth = Date.UTC(y, m, 1);

  const projection = p.learning
    ? null
    : {
        low: p.low,
        high: p.high,
        verdict: (p.high < limit ? "under" : p.low > limit ? "over" : "close") as Verdict,
      };

  const alreadyPassed = p.mtd >= limit;
  const daysToLimit = !p.learning && !alreadyPassed && p.dailyRate > 0 ? Math.max(1, Math.round((limit - p.mtd) / p.dailyRate)) : null;

  // Complete calendar months inside the history: it starts after the window opens and at or before the month's first day.
  let earliest = Infinity;
  const byMonth = new Map<number, number>();
  const byJob = new Map<string, number>();
  for (const pt of points) {
    const t = dayStart(pt.day);
    const spend = Number(pt.spend_usd) || 0;
    if (t < earliest) earliest = t;
    const d = new Date(t);
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    byMonth.set(key, (byMonth.get(key) ?? 0) + spend);
    if (key === thisMonth && t <= end) byJob.set(pt.job, (byJob.get(pt.job) ?? 0) + spend);
  }
  const windowOpens = end - (HISTORY_DAYS - 1) * DAY;
  const months: { label: string; spend: number; start: number }[] = [];
  for (let back = 1; back <= 3; back++) {
    const start = Date.UTC(y, m - back, 1);
    if (earliest <= start && start >= windowOpens) months.push({ label: monthName(start), spend: byMonth.get(start) ?? 0, start });
  }
  months.sort((a, b) => a.start - b.start);
  const backtest = months.length === 0 ? null : { months: months.map(({ label, spend }) => ({ label, spend })), over: months.filter((x) => x.spend > limit).length };

  const lastStart = Date.UTC(y, m - 1, 1);
  const last = months.find((x) => x.start === lastStart);
  const suggestion = last && last.spend > 0 ? Math.max(1, Math.round(last.spend * 1.2)) : null;

  const topTasks = [...byJob.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([job, spend]) => ({ job, spend, share: p.mtd > 0 ? spend / p.mtd : 0 }));

  return {
    limit,
    spent: p.mtd,
    spentShare: p.mtd / limit,
    projection,
    alert85: BUDGET_FIRST_ALERT * limit,
    alert95: BUDGET_SECOND_ALERT * limit,
    daysToLimit,
    alreadyPassed,
    backtest,
    topTasks,
    suggestion,
    belowSpent: p.mtd > limit,
    lastMonthSpend: last ? last.spend : null,
  };
}
