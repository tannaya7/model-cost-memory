/** The demo data tells one story: a task has the same number of AI calls on every screen, and a task with
 * no calls has no verdict to show. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

const server = setupServer(...handlers);
const get = async <T,>(path: string) => (await (await fetch(`${location.origin}${path}`, { headers: { "x-api-key": "demo-key" } })).json()) as T;

beforeAll(() => {
  localStorage.setItem("mcm_mock_signed_in", "true");
  server.listen();
});
afterAll(() => server.close());

describe("demo data", () => {
  it("shows the same call count for each AI task in the list, the spend list, the daily history and the profile", async () => {
    const jobs = await get<{ name: string; run_count: number }[]>("/v1/jobs");
    const spend = await get<{ job: string; runs: number }[]>("/v1/insights/spend");
    const daily90 = await get<{ job: string; runs: number }[]>("/v1/insights/daily?days=90");
    const daily30 = await get<{ job: string; runs: number }[]>("/v1/insights/daily?days=30");
    const sum = (rows: { job: string; runs: number }[], job: string) => rows.filter((r) => r.job === job).reduce((a, r) => a + r.runs, 0);
    for (const j of jobs) {
      expect(sum(daily30, j.name), j.name).toBe(j.run_count);
      expect(sum(daily90, j.name), j.name).toBe(j.run_count);
      expect(spend.find((s) => s.job === j.name)?.runs ?? 0, j.name).toBe(j.run_count);
    }
    const profile = await get<{ calls: number }>("/v1/jobs/invoice-extract/profile");
    expect(profile.calls).toBe(jobs.find((j) => j.name === "invoice-extract")!.run_count);
  });

  it("gives every AI task that has a recommendation at least some calls", async () => {
    const jobs = await get<{ name: string; run_count: number }[]>("/v1/jobs");
    for (const j of jobs) expect(j.run_count, j.name).toBeGreaterThan(0);
  });
});
