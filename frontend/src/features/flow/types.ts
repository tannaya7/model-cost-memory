import type { components } from "../../shared/api/generated";

/** One step of a run through the pipeline: GET /v1/flow and the /v1/flow/stream events. */
export type FlowEvent = components["schemas"]["FlowEventOut"];

export type FlowConnectionStatus = "live" | "reconnecting" | "polling";
