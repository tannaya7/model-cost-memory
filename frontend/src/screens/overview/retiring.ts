/** How a model on the "being shut down" list reads on the overview: by whether its date has already passed. */
export interface RetiringModel {
  model: string;
  status: string;
  shutdown_date: string | null;
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });

export function retiringView(m: RetiringModel, now: Date = new Date()): { title: string; sub: string } {
  const date = m.shutdown_date ? new Date(m.shutdown_date) : null;
  const past = date !== null && !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime();
  if (past) return { title: `${m.model} was shut down on ${fmt(m.shutdown_date!)}`, sub: "Move any AI task still using it to another model" };
  const retired = m.status === "RETIRED";
  return {
    title: `${m.model} ${retired ? "has been retired" : "is being retired"}`,
    sub: m.shutdown_date ? `Shuts down ${fmt(m.shutdown_date)}` : "No shutdown date published",
  };
}
