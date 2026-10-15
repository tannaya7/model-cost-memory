import type { components } from "./generated";

export type Job = components["schemas"]["JobOut"];
export type JobCreate = components["schemas"]["JobCreate"];
export type Run = components["schemas"]["RunOut"];
export type RunDetail = components["schemas"]["RunDetail"];
export type RunPage = components["schemas"]["RunPage"];
export type CheckKind = components["schemas"]["JobCreate"]["check_kind"];

export type Model = components["schemas"]["ModelOut"];
export type ModelPage = components["schemas"]["ModelPage"];
export type ModelStatus = components["schemas"]["ModelOut"]["status"];

// TEMPORARY: from poc/poc_engine/engine.py until contract/openapi.json includes them
export interface ModelStat {
  model: string;
  latest_version: string | null;
  catalog_status: "ACTIVE" | "DEPRECATED" | "RETIRED" | "UNKNOWN";
  shutdown_date: string | null;
  n_runs: number;
  failures: number;
  evidence_weight: number;
  weighted_pass_rate: number;
  mean_cost_usd: number;
  cost_per_success_usd: number | null;
  eligible?: boolean;
}

export type Verdict = "HOLD" | "DOWNGRADE" | "SWITCH" | "INSUFFICIENT_EVIDENCE";

export interface FailingRunSummary {
  run_id: string;
  model_version: string;
  outcome_reason: string | null;
  created_at: string;
}

export interface Recommendation {
  job: string;
  current_model: string | null;
  rules: { evidence_floor: number; tolerance: number };
  verdict: Verdict;
  candidates: ModelStat[];
  excluded: (ModelStat & { why: string })[];
  recommended?: { model: string; model_version: string | null };
  comparison?: { recommended: ModelStat; current: ModelStat | null };
  forecast?: {
    runs_per_month: number;
    monthly_saving_usd: number;
    extra_failures_per_month: number;
    note: string;
  } | null;
  evidence?: {
    n_runs: number;
    evidence_weight: number;
    failures: number;
    recent_failing_runs: FailingRunSummary[];
  };
  warnings?: string[];
  progress?: string;
  next_step?: string;
}

export interface SpendInsight {
  job: string;
  runs: number;
  spend_usd: number;
  share: number;
}

export interface RegressionAlert {
  alert_id: string;
  kind: string;
  detail: { model: string; summary: string };
  resolved_at: string | null;
  created_at: string;
}
