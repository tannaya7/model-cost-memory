import { delay, http, HttpResponse } from "msw";
import jobs from "./jobs.sample.json";

// Tip: add ?state=empty or ?state=error handling later by swapping these responses
// to see the empty and error states.
export const handlers = [
  http.get("/v1/jobs", async () => {
    await delay(600);
    return HttpResponse.json(jobs);
  }),
];
