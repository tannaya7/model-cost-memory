import { apiFetch } from "../../../shared/api/apiFetch";
import type { Job, JobCreate } from "../../../shared/api/types";

export const fetchJobs = () => apiFetch<Job[]>("/v1/jobs");

export const createJob = (data: JobCreate) =>
  apiFetch<Job>("/v1/jobs", {
    method: "POST",
    body: JSON.stringify(data),
  });
