import { apiFetch } from "../../../shared/api/apiFetch";
import type { Model, RegressionAlert } from "../../../shared/api/types";
import { fetchJobs } from "../../jobs/api/jobsApi";
import { fetchModels } from "../../models/api/modelsApi";

export function fetchJobRegressions(jobName: string): Promise<RegressionAlert[]> {
  return apiFetch<RegressionAlert[]>(
    `/v1/jobs/${encodeURIComponent(jobName)}/regressions`,
  );
}

export async function fetchAllRegressions(): Promise<RegressionAlert[]> {
  const jobs = await fetchJobs();
  const results = await Promise.all(
    jobs.map((job) =>
      fetchJobRegressions(job.name)
        .then((alerts) =>
          alerts.map((a) => ({ ...a, job_id: a.job_id || job.name })),
        )
        .catch(() => [] as RegressionAlert[]),
    ),
  );
  return results.flat();
}

export async function fetchDeprecatedModels(): Promise<Model[]> {
  const page = await fetchModels({ used: true, status: "DEPRECATED" });
  return page.items;
}
