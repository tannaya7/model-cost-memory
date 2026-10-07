"""RunRecorder: the SDK an engineer wraps around their existing model call (tech plan 3.12).

    with RunRecorder(job="invoice-extract", api_key="demo-key") as rec:
        response = provider.call(...)            # the app's normal call, unchanged
        rec.capture(prompt, response, reference=answer_key)

It reads model, resolved version, usage and output from the response, then sends the run to
POST /v1/runs in the background. If our API is unreachable it gives up quietly: recording must
never break the customer's app.
"""

import json
import threading
import time
import urllib.request


class RunRecorder:
    def __init__(self, job: str, api_url: str = "http://127.0.0.1:8000", api_key: str = "demo-key",
                 prompt_version: str | None = None, run_kind: str = "PRODUCTION",
                 transport=None, background: bool = True):
        self.job, self.api_url, self.api_key = job, api_url.rstrip("/"), api_key
        self.prompt_version, self.run_kind = prompt_version, run_kind
        self.transport = transport            # in-process function, used by the demo page
        self.background = background
        self.payload: dict | None = None
        self.result: dict | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "RunRecorder":
        self._t0 = time.perf_counter()
        return self

    def capture(self, prompt: str, response: dict, reference: dict | None = None) -> None:
        u = response["usage"]
        self.payload = {
            "job": self.job,
            "prompt": prompt,
            "prompt_version": self.prompt_version,
            "model": response["model"],
            "model_version": response["model_version"],
            "tokens_in": u["input_tokens"],
            "tokens_out": u["output_tokens"],
            "cache_read_tokens": u.get("cache_read_tokens", 0),
            "cache_write_tokens": u.get("cache_write_tokens", 0),
            "latency_ms": response.get("latency_ms") or int((time.perf_counter() - self._t0) * 1000),
            "output": response["output"],
            "reference": reference,
            "run_kind": self.run_kind,
        }

    def __exit__(self, exc_type, exc, tb) -> bool:
        if self.payload is not None:
            if self.background:
                self._thread = threading.Thread(target=self._send, daemon=True)
                self._thread.start()
            else:
                self._send()
        return False            # never swallow the app's own exceptions

    def _send(self) -> None:
        try:
            if self.transport:
                self.result = self.transport(self.payload)
                return
            req = urllib.request.Request(
                f"{self.api_url}/v1/runs", data=json.dumps(self.payload).encode(),
                headers={"Content-Type": "application/json", "X-API-Key": self.api_key}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as resp:
                self.result = json.loads(resp.read())
        except Exception as exc:       # recording failures are logged, never raised into the app
            self.result = {"error": str(exc)}

    def wait(self, timeout: float = 5.0) -> dict | None:
        if self._thread:
            self._thread.join(timeout)
        return self.result
