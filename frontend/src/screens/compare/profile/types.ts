/** What the product already knows about a job's recent usage (the Compare page fills this in). */
export type ProfileUsage = { daysOfHistory: number; runs: number; monthlyTokensIn: number; monthlyTokensOut: number; monthlySpendUsd: number; budgetUsd: number | null; currentModels: string[]; periodFrom: string; periodTo: string };

export type Task = "coding" | "extraction" | "support" | "summarising" | "classification" | "agents" | "long-documents" | "reasoning";
export type Priority = "cost" | "quality" | "speed" | "balanced";
export type Need = "long-inputs" | "images" | "tool-use" | "privacy";

/** Everything here is optional. An empty list, null or no budget means "not answered", never a default the user did not choose. */
export type Answers = {
  tasks: Task[];
  /** null = no preference chosen (the person did not pick one, or took it back). */
  priority: Priority | null;
  needs: Need[];
  /** Monthly budget in US dollars; null when the user has none. */
  budgetUsd: number | null;
};

/** What is saved for a task (or, before there is a task, for the project): nothing, a skip, or answers. */
export type Profile = { state: "none" } | { state: "skipped" } | { state: "answered"; answers: Answers };

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
