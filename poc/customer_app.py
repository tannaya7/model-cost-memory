"""A pretend customer application that uses the SDK over real HTTP.

This is what an engineer's own code looks like after integrating: their normal model call,
wrapped in RunRecorder. Start the engine first (python -m poc_engine), then run:

    python customer_app.py                 # 5 invoices on 'mini'
    python customer_app.py max 10 v2       # 10 invoices on 'max' with prompt v2
"""

import random
import sys

from poc_engine import fake_models
from poc_engine.sdk import RunRecorder

VERSIONS = {"mini": "mini-2026-06", "pro": "pro-2026-09", "max": "max-2026-05"}


def main(model: str = "mini", n: int = 5, prompt_version: str = "v1") -> None:
    rng = random.Random()
    for i in range(n):
        prompt, answer_key, tokens_in = fake_models.make_invoice(rng)

        # --- the engineer's integration: three lines around their existing call -----------
        with RunRecorder(job="invoice-extract", api_key="demo-key", prompt_version=prompt_version) as rec:
            response = fake_models.call(VERSIONS[model], "invoice-extract", prompt, answer_key,
                                        tokens_in, prompt_version, rng)        # their normal call
            rec.capture(prompt, response, reference=answer_key)
        # -------------------------------------------------------------------------------------

        print(f"[app] invoice {i + 1}: model answered {response['output']}")
        result = rec.wait()          # a real app would not wait; this is just to print the result
        print(f"      recorded → {result}\n")


if __name__ == "__main__":
    args = sys.argv[1:]
    main(args[0] if args else "mini", int(args[1]) if len(args) > 1 else 5, args[2] if len(args) > 2 else "v1")
