// TEMPORARY: backend not published yet; from poc/poc_engine/trace.py and GET /v1/flow
export interface FlowEvent {
  event_id: number;
  ts: string;
  run_id: string | null;
  stage: string;
  message: string;
  data: Record<string, unknown> | null;
}

export type FlowConnectionStatus = "live" | "reconnecting" | "polling";
