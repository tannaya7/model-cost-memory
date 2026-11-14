/** What the product already knows about a job's recent usage (the Compare page fills this in). */
export type ProfileUsage = { daysOfHistory: number; runs: number; monthlyTokensIn: number; monthlyTokensOut: number; monthlySpendUsd: number; budgetUsd: number | null; currentModels: string[]; periodFrom: string; periodTo: string };

export type People = "1" | "2-10" | "11-50" | "50+";
export type Task = "coding" | "extraction" | "support" | "summarising" | "classification" | "agents" | "long-documents" | "reasoning";
export type Priority = "cost" | "quality" | "speed" | "balanced";
export type Need = "long-inputs" | "images" | "tool-use" | "privacy";

export type Answers = {
  people: People;
  tasks: Task[];
  priority: Priority;
  needs: Need[];
  /** Monthly budget in US dollars; null when the user has none. */
  budgetUsd: number | null;
};

/** A capability the provider itself publishes about a model family. */
export type Tag = "coding" | "extraction" | "classification" | "agents" | "tool-use" | "reasoning" | "multimodal" | "fast-cheap" | "complex-work" | "balanced";

export type Suggestion = {
  model: string;
  provider: string;
  why: string[];
  estimatedMonthlyUsd: number | null;
  fitsBudget: boolean | null;
  link: { url: string; label: string } | null;
  confidence: "profile";
};
