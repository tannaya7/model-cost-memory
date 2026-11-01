# Staleness experiment

5 simulated timelines of 120 days. Workload drifts from 5% to 60% long documents; a
new version of the mid-priced model arrives on day 45. Every 7 days both evidence sets are asked for a
recommendation and scored against the known right answer (the cheapest model within 3 points of the best
true pass rate).

- **Frozen**: a curated evaluation set of the first 14 days, judged once and never updated.
- **Maintained**: this system's stored recommendation, kept current by decay, re-tests and consolidation.

| | Accuracy, whole timeline | Accuracy, second half |
|---|---|---|
| Frozen | 25% | 0% |
| Maintained | 85% | 100% |

**Headline:** in the second half of the timeline the maintained memory picked the right model 100% of the time, the frozen set 0%.

## Checkpoints (first timeline)

| Day | Right answer | Frozen | Maintained |
|---|---|---|---|
| 14 | acme-mini | acme-large ✗ | acme-large ✗ |
| 21 | acme-large | acme-large ✓ | acme-large ✓ |
| 28 | acme-large | acme-large ✓ | acme-large ✓ |
| 35 | acme-large | acme-large ✓ | acme-large ✓ |
| 42 | acme-large | acme-large ✓ | acme-large ✓ |
| 49 | acme-mid | acme-large ✗ | acme-large ✗ |
| 56 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 63 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 70 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 77 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 84 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 91 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 98 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 105 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 112 | acme-mid | acme-large ✗ | acme-mid ✓ |
| 119 | acme-mid | acme-large ✗ | acme-mid ✓ |

Reproduce with `python scripts/staleness_experiment.py`. Simulated data; the engine, decay,
consolidation and regression code are the production code, run with simulated time.
