import type { components } from "./generated";

export type Job = components["schemas"]["JobOut"];
export type JobCreate = components["schemas"]["JobCreate"];
export type Run = components["schemas"]["RunOut"];
export type RunDetail = components["schemas"]["RunDetail"];
export type RunPage = components["schemas"]["RunPage"];
export type CheckKind = components["schemas"]["JobCreate"]["check_kind"];

export type Model = components["schemas"]["ModelOut"];
export type ModelPage = components["schemas"]["ModelPage"];
export type ModelStatus = components["schemas"]["ModelOut"]["status"];
