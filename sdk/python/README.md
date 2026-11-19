# mcm-recorder (working name, not published)

The small recorder for apps that use Model & Cost Memory. It is generated from the product's own recorder by
`scripts/build_recorder_package.py`, so do not edit it by hand.

```python
from mcm_recorder import RunRecorder, provider_for

with RunRecorder(job="read-invoices", provider=provider_for(client.base_url)) as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])
    rec.capture(response, prompt=prompt, model="my-model")
```

Set `MCM_API_KEY` (your project key) and `MCM_API_URL` (the address of your Model & Cost Memory server).
It sends in a background thread, adds well under 5 ms to a call, and never raises into your app.

**Not published.** The classifier `Private :: Do Not Upload` stops an accidental upload. The public name and the licence are the
owner's decisions. Until then the Connect guide gives developers a small copy-paste function with nothing to install.
