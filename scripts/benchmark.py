"""Measure the PRD's speed targets (PRD 9, technical plan 9 "Performance").

  python scripts/benchmark.py                       # embedded Postgres; writes reports/speed.md and .json
  python scripts/benchmark.py --sizes 10000 100000  # fewer sizes

  recommendation    GET /v1/jobs/{job}/recommendation through the ASGI app, target under 500 ms, for a job
                    holding N checked runs over the last 90 days (decay archives older ones, so 90 days of
                    one job's traffic is what the engine reads): a cold request (cache empty, as after a
                    restart), one right after a new run (the fingerprint changed; a job slower than 250 ms
                    to compute gets its last verdict while the new one is computed), and a cached one.
  recording         what RunRecorder adds to the application's own call, target under 5 ms: reading the
                    response and queueing the run, with the API up and with it unreachable.

Never point --database-url at a database that holds real data: every size writes its own project.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
ROOT = Path(__file__).resolve().parents[1]

# One production model and three alternatives with re-test evidence: (name, share of runs, pass rate, cost)
MODELS = [("flash", 0.70, 0.96, 0.0002), ("pro", 0.10, 0.98, 0.0008), ("lite", 0.10, 0.90, 0.00004),
          ("other", 0.10, 0.95, 0.0003)]

SEED = """
INSERT INTO runs (run_id, job_id, project_id, prompt, prompt_hash, model, model_version, provider, run_kind,
                  tokens_in, tokens_out, cost_usd, outcome, state, created_at)
SELECT gen_random_uuid(), :job, :project, 'invoice ' || g, md5(:project || g::text), m.name, m.name, 'gemini',
       CASE WHEN m.name = 'flash' THEN 'PRODUCTION' ELSE 'RETEST' END, 400, 60, m.cost,
       CASE WHEN random() < m.rate THEN 'PASS' ELSE 'FAIL' END, 'INDEXED',
       now() - random() * interval '90 days'
FROM generate_series(1, :n) AS g
CROSS JOIN LATERAL (
    SELECT name, rate, cost FROM (VALUES {values}) AS v(name, lo, hi, rate, cost)
    WHERE (g % 100) >= v.lo AND (g % 100) < v.hi
) AS m
"""


def ms(seconds: float, places: int = 1) -> float:
    return round(seconds * 1000, places)


def summary(samples: list[float], places: int = 1) -> dict:
    s = sorted(samples)
    return {"median_ms": ms(statistics.median(s), places), "p95_ms": ms(s[min(len(s) - 1, int(len(s) * 0.95))], places),
            "max_ms": ms(s[-1], places), "samples": len(s)}


async def bench_recommendation(url: str, sizes: list[int], repeats: int, on_size=None) -> list[dict]:
    import httpx
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from agent_memory import api as api_module
    from agent_memory.config import normalize_database_url
    from agent_memory.db import get_session
    from agent_memory.models import Job, Project
    from agent_memory.recommend import cache
    from agent_memory.security import generate_key, hash_key

    engine = create_async_engine(normalize_database_url(url))
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def override():
        async with sessions() as s:
            yield s

    api_module.app.dependency_overrides[get_session] = override
    lo, values = 0, []
    for name, share, rate, cost in MODELS:
        hi = lo + round(share * 100)
        values.append(f"('{name}', {lo}, {hi}, {rate}, {cost})")
        lo = hi
    seed = text(SEED.format(values=", ".join(values)))
    results = []
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api_module.app), base_url="http://bench") as client:
            for n in sizes:
                project_id, key = f"bench-{n}-{uuid.uuid4().hex[:6]}", generate_key()
                async with sessions() as s:
                    s.add(Project(project_id=project_id, api_key_hash=hash_key(key)))
                    await s.flush()
                    job = Job(project_id=project_id, name="invoice", check_kind="ANSWER_KEY",
                              check_config={"fields": ["total"]})
                    s.add(job)
                    await s.commit()
                    started = time.perf_counter()
                    await s.execute(seed, {"job": job.job_id, "project": project_id, "n": n})
                    await s.commit()
                    seeded = time.perf_counter() - started
                async with engine.connect() as conn:
                    await conn.execute(text("ANALYZE runs"))
                    await conn.commit()
                headers = {"X-API-Key": key}

                async def get() -> float:
                    t = time.perf_counter()
                    r = await client.get("/v1/jobs/invoice/recommendation", headers=headers)
                    r.raise_for_status()
                    return time.perf_counter() - t

                await get()  # warm up connections and code paths
                cold, after_run, cached = [], [], []
                for _ in range(repeats):
                    cache.clear()
                    cold.append(await get())
                    cached.append(await get())
                    async with sessions() as s:  # one new run changes the fingerprint
                        await s.execute(text(
                            "INSERT INTO runs (run_id, job_id, project_id, prompt, prompt_hash, model, model_version, "
                            "outcome, state) VALUES (gen_random_uuid(), :job, :project, 'new', 'new', 'flash', "
                            "'flash', 'PASS', 'CHECKED')"), {"job": job.job_id, "project": project_id})
                        await s.commit()
                    after_run.append(await get())
                    await cache.settle()  # let a background refresh finish before the next sample
                verdict = (await client.get("/v1/jobs/invoice/recommendation", headers=headers)).json()["verdict"]
                row = {"runs": n, "seed_seconds": round(seeded, 1), "verdict": verdict, "cold": summary(cold),
                       "after_new_run": summary(after_run), "cached": summary(cached)}
                print(f"{n:>8} runs: cold {row['cold']['median_ms']} ms, after a new run "
                      f"{row['after_new_run']['median_ms']} ms, cached {row['cached']['median_ms']} ms ({verdict})")
                results.append(row)
                if on_size:
                    on_size(row)  # saved at once, so a long run that is stopped keeps what it measured
    finally:
        api_module.app.dependency_overrides.clear()
        await engine.dispose()
    return results


def bench_recording(calls: int) -> dict:
    import httpx

    from agent_memory.recorder import RunRecorder, Sender

    response = SimpleNamespace(
        model="gemini-2.5-flash",
        usage=SimpleNamespace(prompt_tokens=420, completion_tokens=60, prompt_tokens_details=None),
        choices=[SimpleNamespace(message=SimpleNamespace(content='{"total": 120.5}', tool_calls=None))],
    )
    prompt = "Extract the vendor, invoice number, date and total from the invoice below.\n" + "line item 12.50\n" * 40
    out = {}
    for label, handler in (("api_up", lambda request: httpx.Response(202, json={"run_id": "x"})),
                           ("api_down", lambda request: (_ for _ in ()).throw(httpx.ConnectError("refused")))):
        sender = Sender("http://api.invalid", "key", transport=httpx.MockTransport(handler), queue_size=calls + 10)
        samples = []
        for _ in range(calls):
            t = time.perf_counter()
            with RunRecorder(job="invoice", provider="gemini", sender=sender) as rec:
                rec.capture(response, prompt=prompt, model="gemini-2.5-flash", expected={"total": 120.5})
            samples.append(time.perf_counter() - t)
        sender.close()
        out[label] = {**summary(samples, 3), "p99_ms": ms(sorted(samples)[int(len(samples) * 0.99)], 3)}
        print(f"recording, {label}: median {out[label]['median_ms']} ms, p99 {out[label]['p99_ms']} ms")
    return out


def report(rec: list[dict], recording: dict, args) -> str:
    lines = [
        "# Speed",
        "",
        "Measured with `python scripts/benchmark.py` on a laptop, against an embedded Postgres on the same machine.",
        "The server will differ; the shape of the numbers is what matters. Simulated runs: 70% on the production",
        "model and 10% each on three alternatives, spread over the last 90 days.",
        "",
        "## Recommendation (target under 500 ms)",
        "",
        "`GET /v1/jobs/{job}/recommendation` through the app. *Cold* is an empty cache, as after a restart, and is",
        "also how long a fresh verdict takes to compute. *After a new run* is the first request after a run arrives,",
        "the usual case under live traffic: a job whose verdict takes over 250 ms to compute is answered with its",
        "last verdict (at most a minute old, its `computed_at` says when) while the new one is computed in the",
        "background. *Cached* is a repeat within 5 minutes.",
        "",
        "| Checked runs in the job | Cold | After a new run | Cached |",
        "|---|---|---|---|",
    ]
    for r in rec:
        lines.append(f"| {r['runs']:,} | {r['cold']['median_ms']} ms (p95 {r['cold']['p95_ms']}) | "
                     f"{r['after_new_run']['median_ms']} ms (p95 {r['after_new_run']['p95_ms']}) | "
                     f"{r['cached']['median_ms']} ms |")
    lines += [
        "",
        f"Medians over {args.repeats} requests per column.",
        "",
        "**Limits.** A job with half a million runs (about 5,500 a day on one job) still takes about a second",
        "when no verdict from the last minute exists: after a restart, or the first request after a quiet minute.",
        "Every fresh verdict reads each counted run once; Postgres sums them per hour bucket, so the cost is one",
        "scan, not one Python object per run. Running totals per hour, kept as runs arrive, are labelled,",
        "archived or invalidated, would make it independent of the job's size; that is the next step if a real",
        "job reaches this scale. The Consolidator, which runs in the background, still lists every counted run",
        "for a verdict's lineage.",
        "",
        "## Recording (target under 5 ms added to the application's call)",
        "",
        "What `RunRecorder` adds on the calling thread: reading the response and queueing the run. Sending happens",
        "on a background thread, so the API's speed, or its absence, should not show here.",
        "",
        "| API | Median | p99 |",
        "|---|---|---|",
    ]
    for label, name in (("api_up", "reachable"), ("api_down", "unreachable")):
        lines.append(f"| {name} | {recording[label]['median_ms']} ms | {recording[label]['p99_ms']} ms |")
    lines.append("")
    lines.append(f"{recording['api_up']['samples']:,} recorded calls each.")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", help="a throwaway database (default: embedded Postgres)")
    parser.add_argument("--sizes", type=int, nargs="+", default=[10_000, 100_000, 500_000])
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--calls", type=int, default=5000)
    parser.add_argument("--no-report", action="store_true", help="print only; do not write reports/speed.*")
    parser.add_argument("--merge", action="store_true",
                        help="add these sizes to the existing reports/speed.json instead of starting afresh")
    args = parser.parse_args()

    from agent_memory.simulation.throwaway import ThrowawayDatabase

    saved = ROOT / "reports" / "speed.json"
    previous = json.loads(saved.read_text(encoding="utf8")) if args.merge and saved.is_file() else {}
    by_size = {r["runs"]: r for r in previous.get("recommendation", [])}
    recording = bench_recording(args.calls) if args.calls else previous["recording"]

    def save(row: dict) -> None:
        by_size[row["runs"]] = row
        if args.no_report:
            return
        rows = [by_size[n] for n in sorted(by_size)]
        (ROOT / "reports" / "speed.md").write_text(report(rows, recording, args), encoding="utf8")
        saved.write_text(json.dumps({"recommendation": rows, "recording": recording}, indent=2) + "\n",
                         encoding="utf8")
        print(f"saved {row['runs']:,} runs to reports/speed.md and .json")

    with ThrowawayDatabase(args.database_url) as url:
        asyncio.run(bench_recommendation(url, args.sizes, args.repeats, on_size=save))
    return 0


if __name__ == "__main__":
    sys.exit(main())
