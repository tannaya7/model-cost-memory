import { apiFetch } from "../../../shared/api/apiFetch";
import type { FlowConnectionStatus, FlowEvent } from "../types";

const MOCK_JOBS = ["invoice-extract", "ticket-classify", "customer-support"];
const MOCK_FAIL_REASONS = [
  "schema validation failed: missing required property 'category'",
  "total: expected 1250.00, got 1205.00",
  "category: expected 'billing', got 'hardware'",
  "date: expected 2026-10-14, got null",
];

export function subscribeToFlow(
  onEvent: (event: FlowEvent) => void,
  onStatusChange?: (status: FlowConnectionStatus) => void,
): () => void {
  const isMock =
    import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "true";

  if (isMock) {
    onStatusChange?.("live");
    let eventId = 100;
    let runCounter = 0;
    const activeTimeouts: ReturnType<typeof setTimeout>[] = [];

    const startRunJourney = () => {
      runCounter++;
      const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
      const job = MOCK_JOBS[runCounter % MOCK_JOBS.length];
      const willFail = runCounter % 6 === 0;

      // 1. SDK
      const t1 = setTimeout(() => {
        onEvent({
          event_id: ++eventId,
          ts: new Date().toISOString(),
          run_id: runId,
          stage: "sdk",
          message: `RunRecorder captured call to 'acme-mini' for '${job}'`,
          data: { job, model: "acme-mini", tokens_in: 256, tokens_out: 42 },
        });
      }, 0);

      // 2. API
      const t2 = setTimeout(() => {
        onEvent({
          event_id: ++eventId,
          ts: new Date().toISOString(),
          run_id: runId,
          stage: "api",
          message: `POST /v1/runs accepted: 202 Accepted for '${job}'`,
          data: { job, status: "ACCEPTED" },
        });
      }, 300);

      // 3. Check
      const t3 = setTimeout(() => {
        if (willFail) {
          const reason =
            MOCK_FAIL_REASONS[runCounter % MOCK_FAIL_REASONS.length];
          onEvent({
            event_id: ++eventId,
            ts: new Date().toISOString(),
            run_id: runId,
            stage: "check",
            message: `Check failed: ${reason}`,
            data: { job, outcome: "FAIL", reason },
          });
          // Fails: stops here
        } else {
          onEvent({
            event_id: ++eventId,
            ts: new Date().toISOString(),
            run_id: runId,
            stage: "check",
            message: `Check passed: output matches expected specification`,
            data: { job, outcome: "PASS" },
          });

          // 4. Index
          const t4 = setTimeout(() => {
            onEvent({
              event_id: ++eventId,
              ts: new Date().toISOString(),
              run_id: runId,
              stage: "index",
              message: `Worker indexed run: latency 240ms, cost $0.0003`,
              data: { job, cost_usd: 0.0003, latency_ms: 240 },
            });
          }, 300);

          // 5. Consolidate
          const t5 = setTimeout(() => {
            onEvent({
              event_id: ++eventId,
              ts: new Date().toISOString(),
              run_id: runId,
              stage: "consolidate",
              message: `[${job}] Evaluated evidence: model 'acme-mini' meets threshold`,
              data: { job, verdict: "HOLD" },
            });
          }, 600);

          activeTimeouts.push(t4, t5);
        }
      }, 600);

      activeTimeouts.push(t1, t2, t3);
    };

    // Run immediately, then every ~1.5s
    startRunJourney();
    const intervalId = setInterval(startRunJourney, 1500);

    return () => {
      clearInterval(intervalId);
      activeTimeouts.forEach((t) => clearTimeout(t));
    };
  }

  // Real EventSource implementation with polling fallback
  let isClosed = false;
  let lastEventId = 0;
  let consecutiveErrors = 0;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let eventSource: EventSource | null = null;

  const startPolling = () => {
    if (isClosed || pollInterval) return;
    onStatusChange?.("polling");

    const poll = async () => {
      if (isClosed) return;
      try {
        const events = await apiFetch<FlowEvent[]>(
          `/v1/flow?after=${lastEventId}`,
        );
        for (const ev of events) {
          if (ev.event_id > lastEventId) {
            lastEventId = ev.event_id;
          }
          onEvent(ev);
        }
      } catch {
        /* poll error: retry next cycle */
      }
    };

    void poll();
    pollInterval = setInterval(poll, 2000);
  };

  try {
    eventSource = new EventSource("/v1/flow/stream");

    eventSource.onopen = () => {
      if (isClosed) return;
      consecutiveErrors = 0;
      onStatusChange?.("live");
    };

    eventSource.onmessage = (e) => {
      if (isClosed) return;
      try {
        const event = JSON.parse(e.data) as FlowEvent;
        if (event.event_id > lastEventId) {
          lastEventId = event.event_id;
        }
        onEvent(event);
      } catch {
        /* ignore invalid json message */
      }
    };

    eventSource.onerror = () => {
      if (isClosed) return;
      consecutiveErrors++;
      if (consecutiveErrors < 3) {
        onStatusChange?.("reconnecting");
      } else {
        eventSource?.close();
        eventSource = null;
        startPolling();
      }
    };
  } catch {
    startPolling();
  }

  return () => {
    isClosed = true;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };
}
