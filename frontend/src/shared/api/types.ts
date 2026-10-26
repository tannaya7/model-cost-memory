import type { components } from "./generated";

export type Job = components["schemas"]["JobOut"];
export type JobCreate = components["schemas"]["JobCreate"];
export type Run = components["schemas"]["RunOut"];
export type RunDetail = components["schemas"]["RunDetail"];
export type RunPage = components["schemas"]["RunPage"];
export type LabelCreate = components["schemas"]["LabelCreate"];
export type CheckKind = components["schemas"]["JobCreate"]["check_kind"];

export type Model = components["schemas"]["ModelOut"];
export type ModelPage = components["schemas"]["ModelPage"];
export type ModelStatus = components["schemas"]["ModelOut"]["status"];

export type Verdict = components["schemas"]["RecommendationOut"]["verdict"];
export type Recommendation = components["schemas"]["RecommendationOut"];
export type ModelEvidence = components["schemas"]["ModelEvidenceOut"];
export type ModelEvidenceStatus = ModelEvidence["status"];
export type FailingRun = components["schemas"]["FailingRunOut"];
export type SpendInsight = components["schemas"]["SpendOut"];

// TEMPORARY: hand-written until the backend builds these endpoints (Weeks 8-11)
export interface RegressionAlertDetail {
  model: string;
  old_version: string;
  new_version: string;
  old_pass_rate: number;
  new_pass_rate: number;
  n_old: number;
  n_new: number;
  p_value: number;
  summary: string;
}

export interface RegressionAlert {
  alert_id: string;
  job_id: string;
  kind: "VERSION_REGRESSION";
  detail: RegressionAlertDetail;
  resolved_at: string | null;
  created_at: string;
}

export interface HistoryEntry {
  recommendation_id: string;
  job_id: string;
  model: string;
  model_version: string;
  verdict: "HOLD" | "DOWNGRADE" | "SWITCH";
  weighted_pass_rate: number | null;
  cost_per_success: number | null;
  n_runs: number;
  evidence_weight: number;
  n_source_runs: number;
  superseded_by_id: string | null;
  supersession_reason: "MODEL_UPGRADE" | "EVIDENCE_DECAYED" | "REGRESSION" | null;
  valid_at: string;
  invalid_at: string | null;
}

export type RetestExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "DONE"
  | "STOPPED_BUDGET"
  | "FAILED";

export interface RetestStatus {
  retest_id: string;
  job: string;
  candidate_model: string;
  status: RetestExecutionStatus;
  budget_usd: number;
  spent_usd: number;
  monthly_cap_usd: number;
  cap_remaining_usd: number;
  runs_planned: number;
  runs_done: number;
  passed: number;
  failed: number;
  pass_rate: number | null;
  started_at: string;
  finished_at: string | null;
  message: string | null;
}

export interface RetestCreateInput {
  candidate_model: string;
  budget_usd: number;
}

export interface RetestLimits {
  monthly_cap_usd: number;
  spent_this_month_usd: number;
  cap_remaining_usd: number;
}

export interface User {
  user_id: string;
  email: string;
  name: string;
  picture_url: string | null;
}

export interface Project {
  project_id: string;
  name: string;
  webhook_url: string | null;
  retest_monthly_cap_usd: number;
  retest_allowed: boolean;
  key_prefix: string;
  created_at: string;
}

export interface ProjectCreateInput {
  name: string;
}

export interface ProjectCreateResult {
  project: Project;
  api_key: string;
}

export interface ProjectPatchInput {
  name?: string;
  webhook_url?: string | null;
  retest_monthly_cap_usd?: number;
  retest_allowed?: boolean;
}

export interface ProjectKeyResult {
  api_key: string;
}
