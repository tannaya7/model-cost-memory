import { apiFetch } from "../../../shared/api/apiFetch";
import type { Job, JobCreate } from "../../../shared/api/types";

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
