# mcm-recorder (working name, not published)

The small recorder for apps that use Model & Cost Memory. It is generated from the product's own recorder by
`scripts/build_recorder_package.py`, so do not edit it by hand.

```python
from mcm_recorder import RunRecorder, provider_for

with RunRecorder(job="read-invoices", provider=provider_for(client.base_url)) as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])
    rec.capture(response, prompt=prompt, model="my-model")
```

**Optional: name the feature.** Pass `feature="support_summary"` (Python) or `feature: "support_summary"` (JavaScript) with a call and the
Cost analysis page shows what each of your features cost. It is entirely optional, and you choose whether to add it: Model & Cost Memory
never changes your code. The label is your own word. It is not verified, it is not an identity, and it is not an invoice-grade chargeback
record. Letters, digits, spaces and `. _ -` only, at most 100 characters; anything else is turned into an underscore. Calls without a label
are shown as "Unlabelled". Nothing is ever guessed from your prompts to fill it in.

Set `MCM_API_KEY` (your project key) and `MCM_API_URL` (the address of your Model & Cost Memory server).
It sends in a background thread, adds well under 5 ms to a call, and never raises into your app.

**Not published.** The classifier `Private :: Do Not Upload` stops an accidental upload. The public name and the licence are the
owner's decisions. Until then the Connect guide gives developers a small copy-paste function with nothing to install.
