/** Pure reshaping of API data into chart rows. Kept apart from the charts so it can be tested. */
import type { DayPoint } from "../../shared/api/types";

export interface Row {
  day: string; // YYYY-MM-DD
  [series: string]: number | string | null;
}

/** Every day from the first to the last in the data, so gaps show as zero rather than a slope. */
export function dayRange(points: DayPoint[], days?: number, today: Date = new Date()): string[] {
  if (points.length === 0 && !days) return [];
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const first = days
    ? new Date(end.getTime() - (days - 1) * 86_400_000)
    : new Date(`${points.reduce((m, p) => (p.day < m ? p.day : m), points[0].day)}T00:00:00Z`);
  const out: string[] = [];
  for (let t = first.getTime(); t <= end.getTime(); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Spend (or runs) per day, one column per job or model, missing days as 0. */
export function pivot(
  points: DayPoint[],
  by: "job" | "model",
  metric: "spend_usd" | "runs",
  days?: number,
  today?: Date,
): { rows: Row[]; names: string[] } {
  const names = [...new Set(points.map((p) => p[by]))].sort();
  const rows = new Map<string, Row>(
    dayRange(points, days, today).map((day) => [day, Object.fromEntries([["day", day], ...names.map((n) => [n, 0])]) as Row]),
  );
  for (const p of points) {
    const row = rows.get(p.day);
    if (row) row[p[by]] = (row[p[by]] as number) + p[metric];
  }
  return { rows: [...rows.values()], names };
}

/** Pass rate per model per day over a trailing window (7 days by default), null until a model has
 * `minChecked` checked runs in the window: daily rates on a handful of runs only add noise. */
export function rollingPassRate(
  points: DayPoint[],
  { window = 7, minChecked = 10, days, today }: { window?: number; minChecked?: number; days?: number; today?: Date } = {},
): { rows: Row[]; names: string[] } {
  const names = [...new Set(points.map((p) => p.model))].sort();
  const range = dayRange(points, days, today);
  const byDay = new Map<string, Map<string, { passed: number; checked: number }>>();
  for (const p of points) {
    const day = byDay.get(p.day) ?? new Map();
    const cur = day.get(p.model) ?? { passed: 0, checked: 0 };
    day.set(p.model, { passed: cur.passed + p.passed, checked: cur.checked + p.passed + p.failed });
    byDay.set(p.day, day);
  }
  const rows = range.map((day, i) => {
    const row: Row = { day };
    for (const name of names) {
      let passed = 0;
      let checked = 0;
      for (let k = Math.max(0, i - window + 1); k <= i; k++) {
        const v = byDay.get(range[k])?.get(name);
        if (v) {
          passed += v.passed;
          checked += v.checked;
        }
      }
      row[name] = checked >= minChecked ? passed / checked : null;
    }
    return row;
  });
  return { rows, names };
}

export function total(points: DayPoint[], metric: "spend_usd" | "runs" | "passed" | "failed"): number {
  return points.reduce((sum, p) => sum + p[metric], 0);
}

/** The last `days` days' total against the `days` before them, as a fraction (0.12 = up 12%). */
export function change(points: DayPoint[], metric: "spend_usd" | "runs", days: number, today: Date = new Date()): number | null {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const sum = (from: number, to: number) =>
    points
      .filter((p) => {
        const t = Date.parse(`${p.day}T00:00:00Z`);
        return t > end - to * 86_400_000 && t <= end - from * 86_400_000;
      })
      .reduce((s, p) => s + p[metric], 0);
  const recent = sum(0, days);
  const before = sum(days, 2 * days);
  return before > 0 ? (recent - before) / before : null;
}
