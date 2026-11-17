import { apiFetch } from "../../../shared/api/apiFetch";
import type { Job, JobCreate, TaskProfile, TaskSummary } from "../../../shared/api/types";

export const fetchJobs = () => apiFetch<Job[]>("/v1/jobs");

export const createJob = (data: JobCreate) =>
  apiFetch<Job>("/v1/jobs", {
    method: "POST",
    body: JSON.stringify(data),
  });

/** Change a task's description. */
export const updateJobDescription = (name: string, description: string | null) =>
  apiFetch<Job>(`/v1/jobs/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });

/** What the recorded calls prove about a task, plus the state of the optional AI summary. */
export const fetchTaskProfile = (name: string) =>
  apiFetch<TaskProfile>(`/v1/jobs/${encodeURIComponent(name)}/profile`);

/** Switch the AI-written task summary on or off for the whole project. */
export const setTaskSummaryConsent = (enabled: boolean) =>
  apiFetch<TaskSummary>("/v1/task-summary-consent", { method: "PUT", body: JSON.stringify({ enabled }) });

export const deleteTaskSummary = (name: string) =>
  apiFetch<null>(`/v1/jobs/${encodeURIComponent(name)}/summary`, { method: "DELETE" });
