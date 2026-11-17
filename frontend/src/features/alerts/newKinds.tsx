import type { ReactNode } from "react";
import type { Alert } from "../../shared/api/types";
import { IconAlert, IconBolt, IconClock, IconDollar } from "../../ui/icons";

/** The four alert kinds that are about use and spending, not answer quality. */
export const NEW_KINDS = ["TOKEN_BURST", "BUDGET", "TRIAL_BUDGET", "MODEL_RETIRING"] as const;
export type NewKind = (typeof NEW_KINDS)[number];

export function isNewKind(kind: string): kind is NewKind {
  return (NEW_KINDS as readonly string[]).includes(kind);
}

export interface NewKindView {
  title: string;
  tone: "bad" | "warn";
  icon: ReactNode;
  /** One short line of the key numbers. */
  numbers: string;
  /** Where to go next, as a path inside the project. */
  to: string;
  linkLabel: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const money = (v: unknown) => {
  const n = num(v);
  if (n === null) return null;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 100 && !Number.isInteger(n) ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 })}`;
};
const tokens = (v: unknown) => {
  const n = num(v);
  return n === null ? null : `${Math.round(n).toLocaleString("en-US")} tokens`;
};
const dateText = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
};

/** Title, icon, key numbers and link for an alert of one of the four kinds; null for any other kind. */
export function newKindView(alert: Alert): NewKindView | null {
  const d = alert.detail ?? {};
  switch (alert.kind) {
    case "TOKEN_BURST": {
      const job = str(d.top_job) ?? (alert.job || null);
      const now = tokens(d.tokens_last_hour);
      const usual = tokens(d.usual_tokens_per_hour);
      return {
        title: "Unusually high AI use",
        tone: "warn",
        icon: <IconBolt size={16} />,
        numbers: now && usual ? `Last hour: ${now}. Usual hour: ${usual}.` : "",
        to: job ? `/jobs/${encodeURIComponent(job)}?tab=tokens` : "/jobs",
        linkLabel: job ? `See the tokens of ${job} →` : "See your AI tasks →",
      };
    }
    case "BUDGET": {
      const spent = money(d.spent_usd);
      const limit = money(d.budget_usd);
      const projected = money(d.projected_usd);
      const numbers =
        d.level === "PROJECTED"
          ? `Spent ${spent ?? "?"} so far. On this pace the month ends near ${projected ?? "?"}, over your ${limit ?? "?"} limit.`
          : `Spent ${spent ?? "?"} of your ${limit ?? "?"} limit.`;
      return { title: "Spending limit warning", tone: "warn", icon: <IconDollar size={16} />, numbers, to: "/settings#budget", linkLabel: "Change your limit →" };
    }
    case "TRIAL_BUDGET":
      return {
        title: "Trial budget warning",
        tone: "warn",
        icon: <IconAlert size={16} />,
        numbers: `Spent ${money(d.spent_usd) ?? "?"} of your ${money(d.cap_usd) ?? "?"} trial budget.`,
        to: "/settings#retests",
        linkLabel: "See your trial budget →",
      };
    case "MODEL_RETIRING": {
      const when = dateText(d.shutdown_date);
      const model = str(d.model);
      return {
        title: "A model is being shut down",
        tone: "warn",
        icon: <IconClock size={16} />,
        numbers: `${model ? `${model}: ` : ""}${when ? `Shutdown not before ${when}.` : "No shutdown date published."}`,
        to: "/models",
        linkLabel: "See the models →",
      };
    }
    default:
      return null;
  }
}
