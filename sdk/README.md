# Recorders for apps that use Model & Cost Memory

Small, separate recorders so a customer's app never has to install the whole server. **Nothing here is published**, and both are
marked private so they cannot be uploaded by accident. The public names and the licence are the owner's decisions.

| Folder | What | Install size |
|---|---|---|
| `python/` | The product's own Python recorder, copied out by `scripts/build_recorder_package.py` (three plain files, one dependency: `httpx`). Do not edit by hand. | tiny |
| `js/` | A JavaScript/TypeScript recorder for Node 18+, no dependencies. Written by hand, tested against the Python reader. | tiny |
| `fixtures/usage_cases.json` | Provider usage blocks and what the Python reader makes of them. Both recorders must agree. Written by `scripts/build_usage_fixtures.py`. | |

What a customer is shown today does not depend on these: the Connect guide gives a developer a short copy-paste function (Python,
JavaScript) or a plain web request (any language). Those need nothing installed. These packages are the next step once the owner
picks a public name and licence.

## Checks

```
python scripts/build_recorder_package.py --check      # sdk/python is up to date with the real recorder
python scripts/build_usage_fixtures.py --check        # the shared cases are up to date
(cd sdk/python && PYTHONPATH=src python -m pytest tests)   # the recorder's own tests, run against the small package
(cd sdk/js && node --test)                            # the JavaScript tests, including the parity cases
```

`tests/test_sdk_packages.py` runs all four as part of the normal test suite. No test makes a network call.

## What is not covered
- The Python package has not been built into a wheel or uploaded anywhere: that needs the build tools and a name.
- The JavaScript recorder does not send tool calls or raw usage blocks (the Python one does).
- There is no recorder for other languages: they use the plain web request.
