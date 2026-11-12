# Staleness experiment

Over the whole timeline the maintained memory picked the right model 76% of the time, against 25% for a frozen test set and 65% for one re-checked every 30 days. Keeping it fresh cost 9% of production spend. Where nothing changes, its answer changed 1.9 times per timeline.

20 simulated timelines of 120 days per set-up. In the drifting world the share of long documents grows from 5% to 60%, so the cheap model stops being good enough, and a better version of the mid-priced model arrives on day 45. Every 7 days each answer is scored against the known right answer (the cheapest model within 3 points of the best true pass rate).

- **Frozen**: a curated test set of the first 14 days, judged once and never updated.
- **Re-checked monthly**: the same engine asked every 30 days, its answer kept until the next check, the way a team re-runs its test set each month. It sees all the evidence at each check, so it is a generous baseline.
- **Maintained**: this system's stored recommendation, kept current every day by decay, re-tests and consolidation.

## Drifting world

| | Accuracy, whole timeline | Accuracy, second half |
|---|---|---|
| Frozen | 25% | 0% |
| Re-checked monthly | 65% | 81% |
| Maintained | 76% | 92% |

The right answer changes 2.0 times per timeline; the maintained answer changed 1.4 times (range 0-7).

### Accuracy at each checkpoint, mean of 20 timelines

| Day | Frozen | Re-checked monthly | Maintained |
|---|---|---|---|
| 14 | 0% | 0% | 0% |
| 21 | 100% | 100% | 95% |
| 28 | 100% | 100% | 100% |
| 35 | 100% | 100% | 100% |
| 42 | 100% | 100% | 100% |
| 49 | 0% | 0% | 0% |
| 56 | 0% | 0% | 15% |
| 63 | 0% | 0% | 65% |
| 70 | 0% | 0% | 85% |
| 77 | 0% | 90% | 95% |
| 84 | 0% | 90% | 90% |
| 91 | 0% | 90% | 95% |
| 98 | 0% | 90% | 95% |
| 105 | 0% | 95% | 90% |
| 112 | 0% | 95% | 95% |
| 119 | 0% | 95% | 95% |

## What freshness costs

Re-test runs keep the evidence on the models not in production current. Spend is per 30 days at the simulated prices (production: 100 runs a day).

| Re-test runs per model per day | Re-test spend | Production spend | Re-test share | Maintained accuracy, whole timeline |
|---|---|---|---|---|
| 30 | $13.38 | $148.52 | 9% | 76% |
| 10 | $4.45 | $148.50 | 3% | 51% |

## Control: a world where nothing changes

Same models, no drift, no new version: the right answer is the same every day.

| | Accuracy, whole timeline | Answer changes per timeline |
|---|---|---|
| Frozen | 20% | 0 |
| Re-checked monthly | 58% | 1.2 |
| Maintained | 73% | 1.9 (range 0-5) |

## Checkpoints, first drifting timeline

| Day | Right answer | Frozen | Re-checked monthly | Maintained |
|---|---|---|---|---|
| 14 | acme-mini | acme-large ✗ | acme-large ✗ | acme-large ✗ |
| 21 | acme-large | acme-large ✓ | acme-large ✓ | acme-large ✓ |
| 28 | acme-large | acme-large ✓ | acme-large ✓ | acme-large ✓ |
| 35 | acme-large | acme-large ✓ | acme-large ✓ | acme-large ✓ |
| 42 | acme-large | acme-large ✓ | acme-large ✓ | acme-large ✓ |
| 49 | acme-mid | acme-large ✗ | acme-large ✗ | acme-large ✗ |
| 56 | acme-mid | acme-large ✗ | acme-large ✗ | acme-mid ✓ |
| 63 | acme-mid | acme-large ✗ | acme-large ✗ | acme-mid ✓ |
| 70 | acme-mid | acme-large ✗ | acme-large ✗ | acme-mid ✓ |
| 77 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |
| 84 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |
| 91 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |
| 98 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |
| 105 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |
| 112 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |
| 119 | acme-mid | acme-large ✗ | acme-mid ✓ | acme-mid ✓ |

Reproduce with `python scripts/staleness_experiment.py --seeds 20`. Simulated data; the engine, decay, consolidation and regression code are the production code, run with simulated time.
