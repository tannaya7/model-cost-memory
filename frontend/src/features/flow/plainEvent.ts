import { jobTitle } from "../jobs/jobTitle";
import type { FlowEvent } from "./types";

/** One plain sentence for a pipeline event, so nobody reads raw log lines like "POST /v1/runs accepted: 202". */
export function plainEvent(ev: FlowEvent): string {
  const job = typeof ev.data?.job === "string" && ev.data.job ? ev.data.job : null;
  const task = job ? `“${jobTitle(job)}”` : "your app";
  const wrong = ev.data?.outcome === "FAIL" || (ev.stage === "check" && ev.message.toLowerCase().includes("fail"));
  switch (ev.stage) {
    case "sdk":
      return `A new AI call was recorded for ${task}`;
    case "api":
      return `The AI call for ${task} was stored with its cost`;
    case "check":
      return wrong ? `An answer for ${task} was marked wrong` : `An answer for ${task} was marked correct`;
    case "index":
      return `The AI call for ${task} was filed so similar prompts can be found`;
    case "consolidate":
      return `Our advice for ${task} was updated with this call`;
    default:
      return `A step finished for ${task}`;
  }
}
