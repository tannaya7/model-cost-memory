/** Chart colours. A colour follows its entity (a model or a job), never its rank, so filtering a chart
 * never repaints the survivors: the slot comes from the entity's place in the full, sorted set.
 * The eight slots are validated for each theme's surface (dataviz validator; see theme.css). */

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

export const OTHER = "var(--series-other)";

export function colorMap(names: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(names)].sort();
  return new Map(sorted.map((name, i) => [name, i < SERIES.length ? SERIES[i] : OTHER]));
}

export const CHART = {
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  tick: "var(--chart-tick)",
  tickFont: { fontSize: 11, fill: "var(--chart-tick)", fontFamily: "var(--font-mono)" },
} as const;
