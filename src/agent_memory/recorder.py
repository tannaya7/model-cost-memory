"""RunRecorder: the SDK the engineer wraps around an existing model call.

Captures prompt, model, provider-resolved version, tokens, cost, latency and output, then sends
them to POST /v1/runs in the background. Must add under 5 ms and never block or break the
customer's call. Implemented in Week 3.
"""


class RunRecorder:
    """Context manager around one model call."""

    def __init__(self, job: str) -> None:
        self.job = job

    def __enter__(self) -> "RunRecorder":
        raise NotImplementedError("Week 3")

    def __exit__(self, *exc: object) -> None:
        raise NotImplementedError("Week 3")

    def capture(self, response: object) -> None:
        """Read usage, model and output from a provider response."""
        raise NotImplementedError("Week 3")
