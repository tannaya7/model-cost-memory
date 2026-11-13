/** Chart colours. A colour follows its entity (a model or a job), never its rank, so filtering a chart
 * never repaints the survivors: the slot comes from the entity's place in the full, sorted set.
 * The eight slots are validated for the dark surface (dataviz validator, all checks pass). */

export const SERIES = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
  "var(--series-8)",
] as const;

export const OTHER = "#5d6380";

export function colorMap(names: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(names)].sort();
  return new Map(sorted.map((name, i) => [name, i < SERIES.length ? SERIES[i] : OTHER]));
}

export const CHART = {
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  tick: "#7d83a6",
  tickFont: { fontSize: 11, fill: "#7d83a6", fontFamily: "var(--font-mono)" },
} as const;
