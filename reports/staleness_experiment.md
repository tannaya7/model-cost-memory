# Staleness experiment

Over the whole timeline the maintained memory picked the right model 75% of the time, against 25% for a frozen test set and 69% for one re-checked every 30 days. Keeping it fresh cost 9% of production spend. Where nothing changes, its answer changed 2.6 times per timeline.

5 simulated timelines of 120 days per set-up. In the drifting world the share of long documents grows from 5% to 60%, so the cheap model stops being good enough, and a better version of the mid-priced model arrives on day 45. Every 7 days each answer is scored against the known right answer (the cheapest model within 3 points of the best true pass rate).

- **Frozen**: a curated test set of the first 14 days, judged once and never updated.
- **Re-checked monthly**: the same engine asked every 30 days, its answer kept until the next check, the way a team re-runs its test set each month. It sees all the evidence at each check, so it is a generous baseline.
- **Maintained**: this system's stored recommendation, kept current every day by decay, re-tests and consolidation.

## Drifting world

| | Accuracy, whole timeline | Accuracy, second half |
|---|---|---|
| Frozen | 25% | 0% |
| Re-checked monthly | 69% | 88% |
| Maintained | 75% | 92% |

The right answer changes 2.0 times per timeline; the maintained answer changed 2.2 times (range 1-7).

### Accuracy at each checkpoint, mean of 5 timelines

| Day | Frozen | Re-checked monthly | Maintained |
|---|---|---|---|
| 14 | 0% | 0% | 0% |
| 21 | 100% | 100% | 100% |
| 28 | 100% | 100% | 100% |
| 35 | 100% | 100% | 100% |
| 42 | 100% | 100% | 100% |
| 49 | 0% | 0% | 0% |
| 56 | 0% | 0% | 20% |
| 63 | 0% | 0% | 40% |
| 70 | 0% | 0% | 80% |
| 77 | 0% | 100% | 100% |
| 84 | 0% | 100% | 80% |
| 91 | 0% | 100% | 100% |
| 98 | 0% | 100% | 100% |
| 105 | 0% | 100% | 80% |
| 112 | 0% | 100% | 100% |
| 119 | 0% | 100% | 100% |

## What freshness costs

Re-test runs keep the evidence on the models not in production current. Spend is per 30 days at the simulated prices (production: 100 runs a day).

| Re-test runs per model per day | Re-test spend | Production spend | Re-test share | Maintained accuracy, whole timeline |
|---|---|---|---|---|
| 30 | $13.35 | $148.49 | 9% | 75% |
| 10 | $4.48 | $148.16 | 3% | 48% |

## Control: a world where nothing changes

Same models, no drift, no new version: the right answer is the same every day.

| | Accuracy, whole timeline | Answer changes per timeline |
|---|---|---|
| Frozen | 0% | 0 |
| Re-checked monthly | 50% | 1.2 |
| Maintained | 64% | 2.6 (range 1-4) |

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

Reproduce with `python scripts/staleness_experiment.py --seeds 5`. Simulated data; the engine, decay, consolidation and regression code are the production code, run with simulated time.
