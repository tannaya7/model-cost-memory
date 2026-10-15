import { apiFetch } from "../../../shared/api/apiFetch";
import type { Job } from "../../../shared/api/types";

export const fetchJobs = () => apiFetch<Job[]>("/v1/jobs");
