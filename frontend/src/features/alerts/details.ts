import type { Alert } from "../../shared/api/types";

/** The figures in an alert's `detail`, by kind (see AlertOut in the API contract). */
export interface VersionRegressionDetail {
  model: string;
  old_version: string;
  new_version: string;
  old_pass_rate: number;
  new_pass_rate: number;
  n_old: number;
  n_new: number;
  drop: number;
  p_value: number;
  failing_run_ids: string[];
}

export interface SilentDropDetail {
  model: string;
  model_version: string;
  before_pass_rate: number;
  after_pass_rate: number;
  n_before: number;
  n_after: number;
  drop: number;
  p_value: number;
}

export interface DeprecatedDetail {
  model: string;
  model_version: string;
  status: "DEPRECATED" | "RETIRED";
}

export function versionRegression(alert: Alert): VersionRegressionDetail | null {
  return alert.kind === "VERSION_REGRESSION" ? (alert.detail as unknown as VersionRegressionDetail) : null;
}

export function silentDrop(alert: Alert): SilentDropDetail | null {
  return alert.kind === "SILENT_DROP" ? (alert.detail as unknown as SilentDropDetail) : null;
}

export function deprecated(alert: Alert): DeprecatedDetail | null {
  return alert.kind === "MODEL_DEPRECATED" ? (alert.detail as unknown as DeprecatedDetail) : null;
}

export function formatPValue(p: number): string {
  return p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`;
}
