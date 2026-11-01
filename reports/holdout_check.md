# Held-out check (simulated answers)

1000 generated invoices. Three stand-in models at the real list prices of Gemini 2.5 Flash-Lite,
Flash and Pro answer every invoice, passing with an assumed accuracy per difficulty. In each of
500 random splits per evidence size, the engine decides from that many runs per model through
the production rule, and its pick is scored against the true pass rates:

- **Safe**: the pick is truly within 3 points of the best model. This is the promise behind every recommendation, made at 95% confidence.
- **Right model**: the pick is the cheapest per success within 3 points of the best.
- **Saving captured**: of the saving per success the right model offers over the one in use, how much the
  pick realises.

The accuracies are assumptions; `python scripts/holdout_check.py --project ...` runs the same check on
real recorded runs.

## nearly-as-good

A cheaper model is truly 1.4 points worse: inside the margin, so it is the right pick. True pass rates: gemini-2.5-flash 96.3%, gemini-2.5-flash-lite 90.0%, gemini-2.5-pro 97.7%. In use: gemini-2.5-pro; right pick: gemini-2.5-flash.

| Evidence runs per model | Safe | Right model | Refused | Saving captured | Picks |
|---|---|---|---|---|---|
| 25 | 100.0% | 0.0% | 0.0% | 0% | gemini-2.5-pro 500 |
| 50 | 99.8% | 1.0% | 0.0% | 1% | gemini-2.5-flash 5, gemini-2.5-flash-lite 1, gemini-2.5-pro 494 |
| 100 | 100.0% | 4.8% | 0.0% | 5% | gemini-2.5-flash 24, gemini-2.5-pro 476 |
| 200 | 100.0% | 7.2% | 0.0% | 7% | gemini-2.5-flash 36, gemini-2.5-pro 464 |
| 400 | 100.0% | 14.6% | 0.0% | 15% | gemini-2.5-flash 73, gemini-2.5-pro 427 |

## as-good

A cheaper model is truly as good as the one in use. True pass rates: gemini-2.5-flash 97.7%, gemini-2.5-flash-lite 90.0%, gemini-2.5-pro 97.7%. In use: gemini-2.5-pro; right pick: gemini-2.5-flash.

| Evidence runs per model | Safe | Right model | Refused | Saving captured | Picks |
|---|---|---|---|---|---|
| 25 | 100.0% | 0.0% | 0.0% | 0% | gemini-2.5-pro 500 |
| 50 | 99.8% | 1.2% | 0.0% | 1% | gemini-2.5-flash 6, gemini-2.5-flash-lite 1, gemini-2.5-pro 493 |
| 100 | 100.0% | 12.4% | 0.0% | 12% | gemini-2.5-flash 62, gemini-2.5-pro 438 |
| 200 | 100.0% | 26.0% | 0.0% | 26% | gemini-2.5-flash 130, gemini-2.5-pro 370 |
| 400 | 100.0% | 56.2% | 0.0% | 56% | gemini-2.5-flash 281, gemini-2.5-pro 219 |

## current-is-worse

The model in use is truly 6-8 points behind: the right move is up. True pass rates: gemini-2.5-flash 96.3%, gemini-2.5-flash-lite 90.0%, gemini-2.5-pro 97.7%. In use: gemini-2.5-flash-lite; right pick: gemini-2.5-flash.

| Evidence runs per model | Safe | Right model | Refused | Saving captured | Picks |
|---|---|---|---|---|---|
| 25 | 2.0% | 0.8% | 0.0% | n/a | gemini-2.5-flash 4, gemini-2.5-flash-lite 490, gemini-2.5-pro 6 |
| 50 | 7.2% | 1.6% | 0.0% | n/a | gemini-2.5-flash 8, gemini-2.5-flash-lite 464, gemini-2.5-pro 28 |
| 100 | 16.2% | 3.8% | 0.0% | n/a | gemini-2.5-flash 19, gemini-2.5-flash-lite 419, gemini-2.5-pro 62 |
| 200 | 31.2% | 6.0% | 0.0% | n/a | gemini-2.5-flash 30, gemini-2.5-flash-lite 344, gemini-2.5-pro 126 |
| 400 | 63.8% | 8.6% | 0.0% | n/a | gemini-2.5-flash 43, gemini-2.5-flash-lite 181, gemini-2.5-pro 276 |

## already-right

The model in use is already the right pick: nothing cheaper is good enough. True pass rates: gemini-2.5-flash 97.7%, gemini-2.5-flash-lite 90.0%, gemini-2.5-pro 97.7%. In use: gemini-2.5-flash; right pick: gemini-2.5-flash.

| Evidence runs per model | Safe | Right model | Refused | Saving captured | Picks |
|---|---|---|---|---|---|
| 25 | 100.0% | 100.0% | 0.0% | n/a | gemini-2.5-flash 500 |
| 50 | 99.8% | 99.8% | 0.0% | n/a | gemini-2.5-flash 499, gemini-2.5-flash-lite 1 |
| 100 | 100.0% | 100.0% | 0.0% | n/a | gemini-2.5-flash 500 |
| 200 | 100.0% | 100.0% | 0.0% | n/a | gemini-2.5-flash 500 |
| 400 | 100.0% | 100.0% | 0.0% | n/a | gemini-2.5-flash 500 |

## What this shows

- **Every move the engine makes is safe.** Where the model in use is good enough, no pick in any split
  was more than the margin worse than the best, at any evidence size. Before the rule was changed, 8% of
  picks at 25 runs per model were (the luckiest model was recommended without being compared with the
  model in use).
- **It is cautious with savings.** Proving a 1.4-point gap is under 3 points at 95% confidence takes
  about 900 runs per model, so until then the engine holds and asks for a re-test. A truly equal model is
  proven sooner. A wider margin or a lower confidence would capture savings earlier, at more risk.
- **It is slow to move off a model that is behind but not proven so.** In `current-is-worse` the engine
  holds the weaker model until the gap is proven to exceed the margin. It now names the best model for a
  re-test whenever the model in use measures more than the margin behind, so the proof arrives sooner
  than production traffic alone brings it. A snapshot with a fixed amount of evidence, as here, cannot
  show that speed-up; it shows the decision the engine makes before the extra evidence arrives.
