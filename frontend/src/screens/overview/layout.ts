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
  | "news"
  | "spend-month"
  | "correct"
  | "next-step";

/** The three questions the default overview answers, one titled section each. */
export type SectionId = "spend" | "quality" | "next";
export const SECTIONS: Record<SectionId, string> = { spend: "What am I spending?", quality: "Are my answers still good?", next: "What should I do next?" };

export type Thumb = "kpi" | "line" | "gauge" | "split" | "pills" | "table" | "list" | "area" | "steps" | "hero";

/** Every widget there is. `span` is its width in a three-column grid. */
export const WIDGETS: Record<WidgetId, { title: string; text: string; tag: string; span: 1 | 2 | 3; thumb: Thumb; section?: SectionId; legacy?: boolean }> = {
  "spend-month": { title: "Spend", text: "What you spent, each day against the period before, AI calls, the month-end estimate and an optional monthly limit. For a subscription it shows your usage instead.", tag: "Spend", span: 3, thumb: "line", section: "spend" },
  correct: { title: "Correct answers", text: "The share of checked answers that were correct, against a target you set, and how it moved.", tag: "Quality", span: 1, thumb: "gauge", section: "quality" },
  "next-step": { title: "What you could save", text: "How much you could save each month by moving AI tasks to cheaper models, and where to act on it. For a subscription: ways to make your allowance last longer.", tag: "Savings", span: 3, thumb: "hero", section: "next" },
  kpis: { title: "Key numbers", text: "The four numbers to check first: what you spent, how many answers were correct, how many AI calls were made and how much you could save. Each is compared with the period before.", tag: "Performance", span: 3, thumb: "kpi" , legacy: true },
  savings: { title: "What you could save", text: "How much you could save each month if you follow our recommendations, and where to act on them.", tag: "Savings", span: 3, thumb: "hero" , legacy: true },
  "spend-trend": { title: "This period against the last", text: "What you spent, or how many AI calls were made, each day, with the period before as a dashed line.", tag: "Trends", span: 2, thumb: "line" , legacy: true },
  projection: { title: "Where this month's spending is heading", text: "An estimate of your bill at month end, with an optional monthly limit and a warning as you near it.", tag: "Limit", span: 1, thumb: "gauge" , legacy: true },
  tokens: { title: "Token usage", text: "Tokens are the small pieces of text AI models read and write. See how many you use each day, who uses the most, and how fast a usage limit is filling.", tag: "Usage", span: 2, thumb: "area" },
  agents: { title: "What is using your tokens", text: "Which agents use the most tokens, their heaviest tasks, what tools they use, and how big your tool list is. Worked out from your calls.", tag: "Usage", span: 2, thumb: "split" },
  "tokens-went": { title: "Where your tokens went", text: "Which prompts use the most tokens, how much of each is the same in every call, and plain tips to make them cheaper.", tag: "Usage", span: 2, thumb: "split" },
  "unit-cost": { title: "What 1,000 correct answers cost you", text: "Spending divided by correct answers, for each AI task, so a cheap model that is often wrong cannot hide.", tag: "Unit cost", span: 2, thumb: "table" },
  "wasted-spend": { title: "Money spent on wrong answers", text: "How much of your spending went on answers that were checked and found wrong, and which AI tasks they came from.", tag: "Waste", span: 1, thumb: "split" , section: "spend" },
  "pass-gauge": { title: "Correct answers", text: "The share of checked answers that were correct, against a target you set.", tag: "Quality", span: 1, thumb: "gauge" , legacy: true },
  "spend-split": { title: "Where the money goes", text: "Which AI tasks or models take the biggest share of your spending or AI calls.", tag: "Spend", span: 2, thumb: "split" , section: "spend" },
  "busiest-day": { title: "Busiest day", text: "AI calls on each day of the week, so you know when your app asks an AI the most.", tag: "Traffic", span: 1, thumb: "pills" },
  "jobs-table": { title: "Your AI tasks", text: "Every AI task with its AI calls, spending, change since the last period, correct answers and our recommendation.", tag: "Operations", span: 3, thumb: "table" , section: "next" },
  attention: { title: "Needs your attention", text: "Answers getting worse, models being shut down and usage limits about to run out.", tag: "Alerts", span: 2, thumb: "list" , section: "quality" },
  "spend-by-job": { title: "Spend per day by AI task", text: "What you paid each day, stacked by AI task.", tag: "Spend", span: 2, thumb: "area" },
  pipeline: { title: "How it works", text: "The four steps every AI call goes through: record, check, remember and advise.", tag: "Overview", span: 2, thumb: "steps" },
  news: { title: "In the news", text: "Recent stories about the AI models you use.", tag: "News", span: 1, thumb: "list" },
};

/** What a new or unsaved project sees: 7 widgets in three sections. Everything else is in Add widget. */
export const DEFAULT_LAYOUT: WidgetId[] = ["spend-month", "spend-split", "wasted-spend", "correct", "attention", "next-step", "jobs-table"];

const key = (project: string) => `mcm_layout_${project}`;

function read(project: string): WidgetId[] {
  try {
    const raw = localStorage.getItem(key(project));
    if (!raw) return DEFAULT_LAYOUT;
    const ids = (JSON.parse(raw) as unknown[]).filter((id): id is WidgetId => typeof id === "string" && id in WIDGETS);
    const clean = [...new Set(ids)];
    // Nothing usable saved (for example only widgets that no longer exist): show the default, never a blank page.
    return clean.length === 0 && Array.isArray(JSON.parse(raw)) && (JSON.parse(raw) as unknown[]).length > 0 ? DEFAULT_LAYOUT : clean;
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
    /** Puts back an earlier list (used by Undo). */
    restore: save,
  };
}
