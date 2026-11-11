# Speed

Measured with `python scripts/benchmark.py` on a laptop, against an embedded Postgres on the same machine.
The server will differ; the shape of the numbers is what matters. Simulated runs: 70% on the production
model and 10% each on three alternatives, spread over the last 90 days.

## Recommendation (target under 500 ms)

`GET /v1/jobs/{job}/recommendation` through the app. *Cold* is an empty cache, as after a restart, and is
also how long a fresh verdict takes to compute. *After a new run* is the first request after a run arrives,
the usual case under live traffic: a job whose verdict takes over 250 ms to compute is answered with its
last verdict (at most a minute old, its `computed_at` says when) while the new one is computed in the
background. *Cached* is a repeat within 5 minutes.

| Checked runs in the job | Cold | After a new run | Cached |
|---|---|---|---|
| 10,000 | 43.5 ms (p95 44.5) | 45.5 ms (p95 51.8) | 8.0 ms |
| 100,000 | 286.5 ms (p95 299.5) | 280.4 ms (p95 309.9) | 57.1 ms |
| 500,000 | 991.3 ms (p95 1007.6) | 94.9 ms (p95 103.0) | 85.2 ms |

Medians over 5 requests per column.

**Limits.** A job with half a million runs (about 5,500 a day on one job) still takes about a second
when no verdict from the last minute exists: after a restart, or the first request after a quiet minute.
Every fresh verdict reads each counted run once; Postgres sums them per hour bucket, so the cost is one
scan, not one Python object per run. Running totals per hour, kept as runs arrive, are labelled,
archived or invalidated, would make it independent of the job's size; that is the next step if a real
job reaches this scale. The Consolidator, which runs in the background, still lists every counted run
for a verdict's lineage.

## Recording (target under 5 ms added to the application's call)

What `RunRecorder` adds on the calling thread: reading the response and queueing the run. Sending happens
on a background thread, so the API's speed, or its absence, should not show here.

| API | Median | p99 |
|---|---|---|
| reachable | 0.009 ms | 0.168 ms |
| unreachable | 0.009 ms | 0.028 ms |

5,000 recorded calls each.
