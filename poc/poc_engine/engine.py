"""The read path and the maintenance path (tech plan 3.4, 3.5).

recommend()        cheapest model that passes, per job, with the runs behind it
regressions()      open alerts
history()          the chain of recommendations: what changed, when, why
insights()         breakdowns: per model, by input size, by prompt version
spend()            spend by job
run_maintenance()  what the scheduler does: decay, regression check, consolidation,
                   catalog check, alert delivery
"""

import json
import math
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from . import catalog, db, scoring, trace

EVIDENCE_FLOOR = 25.0      # minimum Σ R(t) before a model can be recommended
TOLERANCE = 0.02           # eligible if within 2 points of the best weighted pass rate
MIN_DROP = 0.05            # a regression must drop at least 5 points ...
P_VALUE = 0.05             # ... and be statistically significant
WEBHOOK = "https://hooks.example.com/model-cost-memory"   # simulated delivery


# ------------------------------------------------------------------------------------ helpers
def _checked_runs(job_id: str) -> list[dict]:
    return db.rows(
        "SELECT * FROM runs WHERE job_id=? AND outcome IN ('PASS','FAIL') AND state!='ARCHIVED'",
        (job_id,),
    )


def _current_model(job_id: str) -> str | None:
    r = db.one("SELECT model FROM runs WHERE job_id=? AND run_kind='PRODUCTION' "
               "ORDER BY created_at DESC LIMIT 1", (job_id,))
    return r["model"] if r else None


def model_stats(job_id: str, now: datetime | None = None) -> dict[str, dict]:
    """Freshness-weighted pass rate and cost per model, across all its versions."""
    now = now or datetime.now(timezone.utc)
    acc = defaultdict(lambda: {"n": 0, "w": 0.0, "w_pass": 0.0, "w_cost": 0.0, "fails": 0})
    for r in _checked_runs(job_id):
        w = scoring.weight(r["created_at"], r["stability"], now)
        a = acc[r["model"]]
        a["n"] += 1
        a["w"] += w
        a["w_pass"] += w * (r["outcome"] == "PASS")
        a["w_cost"] += w * r["cost_usd"]
        a["fails"] += r["outcome"] == "FAIL"
    out = {}
    for model, a in acc.items():
        latest = catalog.latest_version(model)
        wpr = a["w_pass"] / a["w"] if a["w"] else 0.0
        mean_cost = a["w_cost"] / a["w"] if a["w"] else 0.0
        out[model] = {
            "model": model,
            "latest_version": latest["model_version"] if latest else None,
            "catalog_status": latest["status"] if latest else "UNKNOWN",
            "shutdown_date": latest["shutdown_date"] if latest else None,
            "n_runs": a["n"],
            "failures": a["fails"],
            "evidence_weight": round(a["w"], 2),
            "weighted_pass_rate": round(wpr, 4),
            "mean_cost_usd": round(mean_cost, 6),
            "cost_per_success_usd": round(mean_cost / wpr, 6) if wpr > 0 else None,
        }
    return out


def _runs_last_30_days(job_id: str, now: datetime) -> int:
    since = (now - timedelta(days=30)).isoformat()
    r = db.one("SELECT COUNT(*) AS n FROM runs WHERE job_id=? AND run_kind='PRODUCTION' AND created_at>=? "
               "AND created_at<=?", (job_id, since, now.isoformat()))
    return r["n"] if r else 0


# --------------------------------------------------------------------------------- read path
def recommend(job_id: str, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    stats = model_stats(job_id, now)
    current = _current_model(job_id)
    candidates, excluded = [], []
    for s in stats.values():
        if s["catalog_status"] == "RETIRED":
            excluded.append({**s, "why": f"RETIRED by its provider on {s['shutdown_date']}, can't be called"})
        elif s["evidence_weight"] < EVIDENCE_FLOOR:
            excluded.append({**s, "why": f"not enough evidence yet ({s['evidence_weight']} of {EVIDENCE_FLOOR})"})
        else:
            candidates.append(s)

    base = {"job": job_id, "current_model": current,
            "rules": {"evidence_floor": EVIDENCE_FLOOR, "tolerance": TOLERANCE},
            "candidates": sorted(stats.values(), key=lambda s: -s["weighted_pass_rate"]),
            "excluded": excluded}
    if not candidates:
        best = max(stats.values(), key=lambda s: s["evidence_weight"], default=None)
        return {**base, "verdict": "INSUFFICIENT_EVIDENCE",
                "progress": f"{best['evidence_weight'] if best else 0} of {EVIDENCE_FLOOR} weighted runs",
                "next_step": "Record more runs, or start a re-test to gather evidence sooner"}

    best_rate = max(c["weighted_pass_rate"] for c in candidates)
    eligible = sorted([c for c in candidates if c["weighted_pass_rate"] >= best_rate - TOLERANCE],
                      key=lambda c: c["cost_per_success_usd"])
    pick = eligible[0]
    for c in candidates:
        c["eligible"] = c in eligible
    cur = stats.get(current)

    if current == pick["model"]:
        verdict = "HOLD"
    elif cur and cur["cost_per_success_usd"] and pick["cost_per_success_usd"] < cur["cost_per_success_usd"]:
        verdict = "DOWNGRADE"   # a cheaper model does the job as well
    else:
        verdict = "SWITCH"      # the current model no longer does the job well enough

    failing = db.rows(
        "SELECT run_id, model_version, outcome_reason, created_at FROM runs WHERE job_id=? AND model=? "
        "AND outcome='FAIL' AND state!='ARCHIVED' ORDER BY created_at DESC LIMIT 8",
        (job_id, pick["model"]))

    forecast = None
    if cur and verdict != "HOLD":
        per_month = _runs_last_30_days(job_id, now)
        successes = per_month * pick["weighted_pass_rate"]
        forecast = {
            "runs_per_month": per_month,
            "monthly_saving_usd": round((cur["cost_per_success_usd"] - pick["cost_per_success_usd"]) * successes, 2),
            "extra_failures_per_month": round((cur["weighted_pass_rate"] - pick["weighted_pass_rate"]) * per_month, 1),
            "note": "negative saving = costs more; negative extra failures = fewer failures",
        }

    warnings = []
    if pick["catalog_status"] == "DEPRECATED":
        others = [c for c in eligible if c is not pick and c["catalog_status"] == "ACTIVE"]
        nxt = others[0]["model"] if others else None
        warnings.append(f"{pick['model']} is DEPRECATED and shuts down on {pick['shutdown_date']}. "
                        f"Next cheapest model that passes: {nxt or 'none yet, start a re-test'}.")
    open_regs = regressions(job_id)
    for a in open_regs:
        if a["detail"].get("model") == current:
            warnings.append(f"Your current model regressed: {a['detail']['summary']}")

    return {**base, "verdict": verdict,
            "recommended": {"model": pick["model"], "model_version": pick["latest_version"]},
            "comparison": {"recommended": pick, "current": cur},
            "forecast": forecast,
            "evidence": {"n_runs": pick["n_runs"], "evidence_weight": pick["evidence_weight"],
                         "failures": pick["failures"], "recent_failing_runs": failing},
            "warnings": warnings}


def regressions(job_id: str) -> list[dict]:
    out = db.rows("SELECT * FROM alerts WHERE job_id=? ORDER BY created_at DESC", (job_id,))
    for a in out:
        a["detail"] = json.loads(a["detail"])
    return out


def history(job_id: str) -> list[dict]:
    out = db.rows("SELECT * FROM recommendations WHERE job_id=? ORDER BY valid_at DESC", (job_id,))
    for r in out:
        r["n_source_runs"] = len(json.loads(r.pop("consolidated_from")))
    return out


def insights(job_id: str) -> dict:
    runs = db.rows("SELECT model, tokens_in, prompt_version, outcome, cost_usd FROM runs "
                   "WHERE job_id=? AND outcome IN ('PASS','FAIL')", (job_id,))

    def band(t):
        return "short (<1k tokens)" if t < 1000 else "medium (1k-2.5k)" if t < 2500 else "long (>2.5k)"

    def table(keyfn):
        acc = defaultdict(lambda: [0, 0])
        for r in runs:
            k = keyfn(r)
            if k is None:
                continue
            acc[k][0] += 1
            acc[k][1] += r["outcome"] == "PASS"
        return [{"model": m, "group": g, "n_runs": n, "pass_rate": round(p / n, 4)}
                for (m, g), (n, p) in sorted(acc.items())]

    return {
        "job": job_id,
        "by_model": sorted(model_stats(job_id).values(), key=lambda s: s["model"]),
        "by_input_size": table(lambda r: (r["model"], band(r["tokens_in"]))),
        "by_prompt_version": table(lambda r: (r["model"], r["prompt_version"]) if r["prompt_version"] else None),
    }


def spend() -> list[dict]:
    out = db.rows("SELECT job_id AS job, COUNT(*) AS runs, ROUND(SUM(cost_usd), 4) AS spend_usd "
                  "FROM runs GROUP BY job_id ORDER BY spend_usd DESC")
    total = sum(r["spend_usd"] for r in out) or 1
    for r in out:
        r["share"] = round(r["spend_usd"] / total, 4)
    return out


# --------------------------------------------------------------------------- maintenance path
def decay_job(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    rs = db.rows("SELECT run_id, created_at, stability, state FROM runs WHERE state!='ARCHIVED'")
    archived = 0
    with db.conn() as c:
        for r in rs:
            w = scoring.weight(r["created_at"], r["stability"], now)
            if w < scoring.ARCHIVE_BELOW:
                c.execute("UPDATE runs SET weight=?, state='ARCHIVED' WHERE run_id=?", (w, r["run_id"]))
                archived += 1
            else:
                c.execute("UPDATE runs SET weight=? WHERE run_id=?", (w, r["run_id"]))
    trace.log("decay", f"Decay job: recomputed {len(rs)} run weights, archived {archived} "
              f"(below {scoring.ARCHIVE_BELOW}). Nothing deleted.")
    return {"recomputed": len(rs), "archived": archived}


def _two_proportion_p(x1, n1, x2, n2) -> float:
    """One-sided p-value that the new pass rate (x2/n2) is lower than the old one (x1/n1)."""
    p = (x1 + x2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) or 1e-9
    z = (x1 / n1 - x2 / n2) / se
    return 0.5 * math.erfc(z / math.sqrt(2))


def regression_job(job_id: str) -> list[dict]:
    found = []
    by_version = db.rows(
        "SELECT model, model_version, COUNT(*) AS n, SUM(outcome='PASS') AS x, MIN(created_at) AS first_seen "
        "FROM runs WHERE job_id=? AND outcome IN ('PASS','FAIL') GROUP BY model, model_version "
        "ORDER BY model, first_seen", (job_id,))
    versions = defaultdict(list)
    for v in by_version:
        versions[v["model"]].append(v)
    for model, vs in versions.items():
        for old, new in zip(vs, vs[1:]):
            if old["n"] < 30 or new["n"] < 30:
                continue
            r_old, r_new = old["x"] / old["n"], new["x"] / new["n"]
            p = _two_proportion_p(old["x"], old["n"], new["x"], new["n"])
            if r_old - r_new >= MIN_DROP and p < P_VALUE:
                exists = db.one("SELECT 1 FROM alerts WHERE job_id=? AND kind='VERSION_REGRESSION' "
                                "AND detail LIKE ?", (job_id, f'%"{new["model_version"]}"%'))
                if exists:
                    continue
                detail = {"model": model, "old_version": old["model_version"], "new_version": new["model_version"],
                          "old_pass_rate": round(r_old, 4), "new_pass_rate": round(r_new, 4),
                          "n_old": old["n"], "n_new": new["n"], "p_value": round(p, 6),
                          "summary": f"{model} dropped from {r_old:.1%} to {r_new:.1%} when "
                                     f"{old['model_version']} → {new['model_version']} (p={p:.2g})"}
                with db.conn() as c:
                    c.execute("INSERT INTO alerts VALUES (?,?,?,?,?,?)",
                              (uuid.uuid4().hex[:12], job_id, "VERSION_REGRESSION", db.dumps(detail),
                               None, trace.now_iso()))
                trace.log("regression", f"[{job_id}] REGRESSION: {detail['summary']}", data=detail)
                found.append(detail)
    if not found:
        trace.log("regression", f"[{job_id}] Regression check: no new significant drops")
    return found


def consolidate_job(job_id: str, now: datetime | None = None) -> dict | None:
    rec = recommend(job_id, now)
    if rec["verdict"] == "INSUFFICIENT_EVIDENCE":
        trace.log("consolidate", f"[{job_id}] Not enough evidence to write a recommendation yet")
        return None
    pick = rec["comparison"]["recommended"]
    active = db.one("SELECT * FROM recommendations WHERE job_id=? AND invalid_at IS NULL", (job_id,))
    if active and active["model"] == pick["model"]:
        trace.log("consolidate", f"[{job_id}] Recommendation unchanged: {pick['model']}")
        return {"recommendation_id": active["recommendation_id"], "model": active["model"], "unchanged": True}
    source_ids = [r["run_id"] for r in db.rows(
        "SELECT run_id FROM runs WHERE job_id=? AND model=? AND outcome IN ('PASS','FAIL') AND state!='ARCHIVED'",
        (job_id, pick["model"]))]
    new_id, now = uuid.uuid4().hex[:12], (now.isoformat() if now else trace.now_iso())
    reason = None
    if active:
        regressed = db.one("SELECT 1 FROM alerts WHERE job_id=? AND kind='VERSION_REGRESSION' AND detail LIKE ?",
                           (job_id, f'%"model":"{active["model"]}"%'))
        old_entry = catalog.entry(active["model"], active["model_version"])
        reason = ("REGRESSION" if regressed else
                  "MODEL_UPGRADE" if old_entry and old_entry["superseded_by"] else "EVIDENCE_DECAYED")
    with db.conn() as c:
        c.execute("INSERT INTO recommendations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (new_id, job_id, pick["model"], pick["latest_version"], rec["verdict"],
                   pick["weighted_pass_rate"], pick["cost_per_success_usd"], pick["n_runs"],
                   pick["evidence_weight"], db.dumps(source_ids), None, None, now, None))
        if active:
            c.execute("UPDATE recommendations SET invalid_at=?, superseded_by_id=?, supersession_reason=? "
                      "WHERE recommendation_id=?", (now, new_id, reason, active["recommendation_id"]))
        c.execute(f"UPDATE runs SET state='CONSOLIDATED' WHERE state='INDEXED' AND run_id IN "
                  f"({','.join('?' * len(source_ids))})", source_ids)
    msg = (f"[{job_id}] New recommendation: {pick['model']} ({rec['verdict']}), built from "
           f"{len(source_ids)} runs")
    if active:
        msg += f"; previous ({active['model']}) superseded, reason {reason} — kept in history"
    trace.log("consolidate", msg)
    return {"recommendation_id": new_id, "model": pick["model"], "reason": reason}


def catalog_job(job_id: str) -> None:
    active = db.one("SELECT * FROM recommendations WHERE job_id=? AND invalid_at IS NULL", (job_id,))
    if not active:
        return
    e = catalog.latest_version(active["model"])
    if e and e["status"] == "DEPRECATED":
        exists = db.one("SELECT 1 FROM alerts WHERE job_id=? AND kind='MODEL_DEPRECATED' AND detail LIKE ?",
                        (job_id, f'%"{e["model_version"]}"%'))
        if not exists:
            detail = {"model": active["model"], "model_version": e["model_version"],
                      "shutdown_date": e["shutdown_date"],
                      "summary": f"Recommended model {e['model_version']} shuts down on {e['shutdown_date']}"}
            with db.conn() as c:
                c.execute("INSERT INTO alerts VALUES (?,?,?,?,?,?)",
                          (uuid.uuid4().hex[:12], job_id, "MODEL_DEPRECATED", db.dumps(detail), None,
                           trace.now_iso()))
            trace.log("catalog", f"[{job_id}] Catalog check: {detail['summary']}", data=detail)


def deliver_alerts() -> int:
    pending = db.rows("SELECT * FROM alerts WHERE delivered_at IS NULL")
    for a in pending:
        trace.log("alert", f"POST {WEBHOOK} (simulated) → {a['kind']} for job {a['job_id']}",
                  data=json.loads(a["detail"]))
        with db.conn() as c:
            c.execute("UPDATE alerts SET delivered_at=? WHERE alert_id=?", (trace.now_iso(), a["alert_id"]))
    return len(pending)


def run_maintenance(now: datetime | None = None) -> dict:
    """`now` lets the simulator run the scheduler as if it were an earlier day."""
    when = f" (as of {now.date()})" if now else ""
    trace.log("scheduler", f"Scheduler fired{when}: decay → regression check → consolidation → catalog → alerts")
    summary = {"decay": decay_job(now), "regressions": {}, "consolidation": {}}
    for job in db.rows("SELECT job_id FROM jobs"):
        j = job["job_id"]
        summary["regressions"][j] = regression_job(j)
        summary["consolidation"][j] = consolidate_job(j, now)
        catalog_job(j)
    summary["alerts_delivered"] = deliver_alerts()
    return summary
