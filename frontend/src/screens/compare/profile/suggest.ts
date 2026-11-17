/** Suggests up to three models to READ ABOUT, from the user's answers and the usage the product already has.
 * It measures nothing about answer quality and never says one model is better than another.
 *
 * The rules (a transparent table; points only order the options, they are not a quality score):
 *  R1  Candidates are the families in modelCatalog. Each is tied to the newest-sorting ACTIVE model of the
 *      price catalog that matches its pattern. A family the catalog has no active model for stays a candidate
 *      by family name, with no cost. Retired or deprecated models are never suggested.
 *  R2  Each chosen kind of work earns +2 when the provider's published positioning (bestFor) names it:
 *        heavy coding -> coding | data extraction -> extraction | support chat, summarising -> fast-cheap or balanced
 *        classification -> classification | agents (MCP) -> agents or tool-use | reasoning -> reasoning or complex-work
 *        long documents -> a published context window of 500k tokens or more
 *  R3  Priority. cost: order by estimated monthly cost, lowest first (no price goes last), among families that
 *      match the work when any do. quality or balanced: +2 large, +1 mid, +0 small family (a size class by name).
 *      speed: +2 when the provider positions the family as fast-cheap.
 *  R4  Needs. Images and tool use: a family whose published information confirms the need is shown with that
 *      confirmation; one we could not confirm is KEPT, ordered after confirmed ones, with a note to check the
 *      provider's page. A gap in what we verified is never treated as proof a provider lacks the feature.
 *      Very long inputs: dropped when the published window is under 500k; an unpublished window is kept with a note.
 *      Always: dropped when a published window is smaller than the typical input of one run.
 *      Privacy or data location: never changes the order; the text points to the provider's terms.
 *  R5  Budget. estimated cost = (tokensIn * priceIn + tokensOut * priceOut) / 1e6 from the catalog's prices per
 *      1M tokens. Without both prices, or without recorded tokens, the cost is null, never a guess. A cost above
 *      the budget flags the option; it does not remove it.
 *  R6  People: changes only the wording about overlapping requests and sharing the cost, never the ranking.
 *  Ties: broken by name, so the same inputs always give the same output. */
import { MODEL_CATALOG, type CatalogEntry } from "./modelCatalog";
import { modelLink } from "./modelLinks";
import { PRIORITIES, TASKS } from "./answers";
import type { Answers, ProfileUsage, Suggestion, Tag, Task } from "./types";

export type CatalogModel = { model: string; provider: string; status: string; price_in_per_mtok: number | null; price_out_per_mtok: number | null };

const LONG_WINDOW = 500_000;
const TASK_TAGS: Record<Task, Tag[]> = {
  coding: ["coding"],
  extraction: ["extraction"],
  support: ["fast-cheap", "balanced"],
  summarising: ["fast-cheap", "balanced"],
  classification: ["classification"],
  agents: ["agents", "tool-use"],
  "long-documents": [],
  reasoning: ["reasoning", "complex-work"],
};
const label = <T extends string>(list: { value: T; label: string }[], v: T) => list.find((x) => x.value === v)?.label ?? v;
const n = (v: number) => Math.round(v).toLocaleString("en");
const money = (v: number) => `$${v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString("en")}`;

function matches(task: Task, e: CatalogEntry): boolean {
  if (task === "long-documents") return (e.contextWindow ?? 0) >= LONG_WINDOW;
  return TASK_TAGS[task].some((t) => e.bestFor.includes(t));
}

export function estimateMonthlyUsd(usage: ProfileUsage, priceIn: number | null, priceOut: number | null): number | null {
  if (priceIn === null || priceOut === null) return null;
  if (usage.monthlyTokensIn <= 0 && usage.monthlyTokensOut <= 0) return null;
  return (usage.monthlyTokensIn * priceIn + usage.monthlyTokensOut * priceOut) / 1e6;
}

/** Tokens in one typical run, from the monthly volume and the run rate; null when there is nothing to divide. */
function typicalInput(usage: ProfileUsage): number | null {
  if (usage.runs <= 0 || usage.daysOfHistory <= 0 || usage.monthlyTokensIn <= 0) return null;
  const runsPerMonth = (usage.runs / usage.daysOfHistory) * 30;
  return runsPerMonth > 0 ? usage.monthlyTokensIn / runsPerMonth : null;
}

type Candidate = { entry: CatalogEntry; model: string; priceIn: number | null; priceOut: number | null };

function candidates(catalog: CatalogModel[]): Candidate[] {
  return MODEL_CATALOG.map((entry) => {
    const re = new RegExp(entry.pattern);
    const found = catalog.filter((m) => m.status === "ACTIVE" && re.test(m.model.toLowerCase())).sort((a, b) => b.model.localeCompare(a.model))[0];
    return found
      ? { entry, model: found.model, priceIn: found.price_in_per_mtok, priceOut: found.price_out_per_mtok }
      : { entry, model: entry.name, priceIn: null, priceOut: null };
  });
}

export function suggestFromProfile(answers: Answers, usage: ProfileUsage, catalogModels: CatalogModel[]): Suggestion[] {
  const typical = typicalInput(usage);
  const rows: { s: Suggestion; score: number; taskHits: number; name: string }[] = [];

  for (const c of candidates(catalogModels)) {
    const e = c.entry;
    const window = e.contextWindow;
    const imagesOk = e.bestFor.includes("multimodal");
    const toolsOk = e.bestFor.includes("tool-use") || e.bestFor.includes("agents");
    if (answers.needs.includes("long-inputs") && window !== undefined && window < LONG_WINDOW) continue;
    if (window !== undefined && typical !== null && window < typical) continue;

    const why: string[] = [];
    const hits = answers.tasks.filter((t) => matches(t, e));
    for (const t of hits) {
      why.push(
        t === "long-documents"
          ? `You said the work is "${label(TASKS, t)}"; ${e.provider} publishes a ${n(window ?? 0)}-token context window for this family.`
          : `You said the work is "${label(TASKS, t)}"; ${e.provider} describes this family as suited to ${e.bestFor.filter((b) => TASK_TAGS[t].includes(b)).join(" and ")} work.`,
      );
    }
    let score = hits.length * 2;
    const prio = `You said ${label(PRIORITIES, answers.priority).toLowerCase()} matters most`;
    if (answers.priority === "quality" || answers.priority === "balanced") {
      score += e.tier;
      why.push(`${prio}; this is ${e.tier === 2 ? "one of the larger" : e.tier === 1 ? "a mid-sized" : "one of the smaller"} families from ${e.provider}, which only sets the order here and is not a measured result.`);
    } else if (answers.priority === "speed" && e.bestFor.includes("fast-cheap")) {
      score += 2;
      why.push(`${prio}; ${e.provider} positions this family for speed and low cost.`);
    } else if (answers.priority === "cost") {
      why.push(`${prio}; the options are ordered by estimated monthly cost.`);
    }
    if (answers.needs.includes("images")) {
      if (!imagesOk) score -= 1;
      why.push(imagesOk ? `You need images; ${e.provider} lists image input for this family.` : `You need images; we have not confirmed this for this family from ${e.provider}'s published page, so check it there before relying on it.`);
    }
    if (answers.needs.includes("tool-use")) {
      if (!toolsOk) score -= 1;
      why.push(toolsOk ? `You need tool use; ${e.provider} lists it for this family.` : `You need tool use; we have not confirmed this for this family from ${e.provider}'s published page, so check it there before relying on it.`);
    }
    if (answers.needs.includes("long-inputs")) {
      why.push(window !== undefined ? `You need very long inputs; ${e.provider} publishes a ${n(window)}-token window.` : `You need very long inputs; we have not confirmed this family's window, so read the provider's page.`);
    }
    if (answers.needs.includes("privacy")) why.push(`You care about privacy or data location; check ${e.provider}'s terms, which this list does not judge.`);

    const cost = estimateMonthlyUsd(usage, c.priceIn, c.priceOut);
    const fits = cost === null || answers.budgetUsd === null ? null : cost <= answers.budgetUsd;
    if (cost === null) {
      why.push(c.priceIn === null || c.priceOut === null ? "No price for this model is in the catalog, so no cost is estimated." : "No usage with tokens is recorded yet, so no cost is estimated.");
    } else {
      why.push(`At your recent volume (${n(usage.monthlyTokensIn)} tokens in and ${n(usage.monthlyTokensOut)} out a month) it would cost ${usage.daysOfHistory < 7 ? `a rough guess of ${money(cost)} a month (we have only ${usage.daysOfHistory} ${usage.daysOfHistory === 1 ? "day" : "days"} of use, so this is not reliable yet)` : `an estimated ${money(cost)} a month`}.`);
      if (answers.budgetUsd !== null) why.push(fits ? `That is within your ${money(answers.budgetUsd)} monthly budget.` : `That is over your ${money(answers.budgetUsd)} monthly budget.`);
    }
    if (answers.people !== "1") {
      why.push(`${label(PEOPLE_LABEL, answers.people)} people share this, so requests can overlap (check the provider's rate limits)${cost !== null ? " and the estimated cost is shared between them" : ""}.`);
    }
    rows.push({
      s: { model: c.model, provider: e.provider, why, estimatedMonthlyUsd: cost, fitsBudget: fits, link: modelLink(c.model) ?? { url: e.officialUrl, label: "Read about it on the provider's site" }, confidence: "profile" },
      score,
      taskHits: hits.length,
      name: c.model,
    });
  }

  const cost = (r: (typeof rows)[number]) => r.s.estimatedMonthlyUsd ?? Number.POSITIVE_INFINITY;
  const anyHit = answers.tasks.length > 0 && rows.some((r) => r.taskHits > 0);
  rows.sort((a, b) => {
    if (answers.priority === "cost") {
      if (anyHit && (a.taskHits > 0) !== (b.taskHits > 0)) return a.taskHits > 0 ? -1 : 1;
      if (cost(a) !== cost(b)) return cost(a) < cost(b) ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
    } else {
      if (a.score !== b.score) return b.score - a.score;
      if (cost(a) !== cost(b)) return cost(a) < cost(b) ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return rows.slice(0, 3).map((r) => r.s);
}

const PEOPLE_LABEL: { value: string; label: string }[] = [
  { value: "2-10", label: "2 to 10" },
  { value: "11-50", label: "11 to 50" },
  { value: "50+", label: "More than 50" },
];
