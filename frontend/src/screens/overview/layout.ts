/** Which widgets the overview shows, in what order: chosen per project, remembered in this browser. */
import { useCallback, useEffect, useState } from "react";

export type WidgetId =
  | "kpis"
  | "savings"
  | "spend-trend"
  | "projection"
  | "tokens"
  | "tokens-went"
  | "agents"
  | "wasted-spend"
  | "unit-cost"
  | "pass-gauge"
  | "spend-split"
  | "busiest-day"
  | "jobs-table"
  | "attention"
  | "spend-by-job"
  | "pipeline"
  | "news";

export type Thumb = "kpi" | "line" | "gauge" | "split" | "pills" | "table" | "list" | "area" | "steps" | "hero";

/** Every widget there is. `span` is its width in a three-column grid. */
export const WIDGETS: Record<WidgetId, { title: string; text: string; tag: string; span: 1 | 2 | 3; thumb: Thumb }> = {
  kpis: { title: "Key numbers", text: "The four numbers to check first: what you spent, how many answers were correct, how many AI calls were made and how much you could save. Each is compared with the period before.", tag: "Performance", span: 3, thumb: "kpi" },
  savings: { title: "What you could save", text: "How much you could save each month if you follow our recommendations, and where to act on them.", tag: "Savings", span: 3, thumb: "hero" },
  "spend-trend": { title: "This period against the last", text: "What you spent, or how many AI calls were made, each day, with the period before as a dashed line.", tag: "Trends", span: 2, thumb: "line" },
  projection: { title: "Where this month's spending is heading", text: "An estimate of your bill at month end, with an optional monthly budget and a warning as you near it.", tag: "Budget", span: 1, thumb: "gauge" },
  tokens: { title: "Token usage", text: "Tokens are the small pieces of text AI models read and write. See how many you use each day, who uses the most, and how fast a usage limit is filling.", tag: "Usage", span: 2, thumb: "area" },
  agents: { title: "What is using your tokens", text: "Which agents use the most tokens, their heaviest tasks, what tools they use, and how big your tool list is. Worked out from your calls.", tag: "Usage", span: 2, thumb: "split" },
  "tokens-went": { title: "Where your tokens went", text: "Which prompts use the most tokens, how much of each is the same in every call, and plain tips to make them cheaper.", tag: "Usage", span: 2, thumb: "split" },
  "unit-cost": { title: "What 1,000 correct answers cost you", text: "Spending divided by correct answers, for each AI task, so a cheap model that is often wrong cannot hide.", tag: "Unit cost", span: 2, thumb: "table" },
  "wasted-spend": { title: "Money spent on wrong answers", text: "How much of your spending went on answers that were checked and found wrong, and which AI tasks they came from.", tag: "Waste", span: 1, thumb: "split" },
  "pass-gauge": { title: "Correct answers", text: "The share of checked answers that were correct, against a target you set.", tag: "Quality", span: 1, thumb: "gauge" },
  "spend-split": { title: "Where the money goes", text: "Which AI tasks or models take the biggest share of your spending or AI calls.", tag: "Spend", span: 2, thumb: "split" },
  "busiest-day": { title: "Busiest day", text: "AI calls on each day of the week, so you know when your app asks an AI the most.", tag: "Traffic", span: 1, thumb: "pills" },
  "jobs-table": { title: "Your AI tasks", text: "Every AI task with its AI calls, spending, change since the last period, correct answers and our recommendation.", tag: "Operations", span: 2, thumb: "table" },
  attention: { title: "Needs your attention", text: "Answers getting worse, models being shut down and usage limits about to run out.", tag: "Alerts", span: 1, thumb: "list" },
  "spend-by-job": { title: "Spend per day by AI task", text: "What you paid each day, stacked by AI task.", tag: "Spend", span: 2, thumb: "area" },
  pipeline: { title: "How it works", text: "The four steps every AI call goes through: record, check, remember and advise.", tag: "Overview", span: 2, thumb: "steps" },
  news: { title: "In the news", text: "Recent stories about the AI models you use.", tag: "News", span: 1, thumb: "list" },
};

export const DEFAULT_LAYOUT: WidgetId[] = ["kpis", "savings", "spend-trend", "projection", "unit-cost", "wasted-spend", "tokens", "tokens-went", "agents", "pass-gauge", "spend-split", "busiest-day", "jobs-table", "attention"];

const key = (project: string) => `mcm_layout_${project}`;

function read(project: string): WidgetId[] {
  try {
    const raw = localStorage.getItem(key(project));
    if (!raw) return DEFAULT_LAYOUT;
    const ids = (JSON.parse(raw) as unknown[]).filter((id): id is WidgetId => typeof id === "string" && id in WIDGETS);
    return [...new Set(ids)];
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function useLayout(project: string) {
  const [ids, setIds] = useState<WidgetId[]>(() => read(project));
  useEffect(() => setIds(read(project)), [project]);
  const save = useCallback(
    (next: WidgetId[]) => {
      setIds(next);
      try {
        localStorage.setItem(key(project), JSON.stringify(next));
      } catch {
        /* storage blocked: the layout lasts until the page closes */
      }
    },
    [project],
  );
  return {
    ids,
    add: (id: WidgetId) => !ids.includes(id) && save([...ids, id]),
    remove: (id: WidgetId) => save(ids.filter((x) => x !== id)),
    move: (id: WidgetId, by: -1 | 1) => {
      const i = ids.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= ids.length) return;
      const next = [...ids];
      [next[i], next[j]] = [next[j], next[i]];
      save(next);
    },
    reset: () => save(DEFAULT_LAYOUT),
  };
}
