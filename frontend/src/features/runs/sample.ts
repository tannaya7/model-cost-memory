/** A spread across the current calendar month (UTC): the earliest, the middle and the latest call. No randomness. */
export function pickMonthlySample<T extends { created_at: string }>(items: T[], now: Date = new Date(), max = 3): T[] {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const inMonth = items
    .filter((r) => {
      const d = new Date(r.created_at);
      return d.getUTCFullYear() === y && d.getUTCMonth() === m;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (inMonth.length <= max) return inMonth;
  return [inMonth[0], inMonth[Math.floor((inMonth.length - 1) / 2)], inMonth[inMonth.length - 1]];
}
