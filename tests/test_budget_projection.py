"""The month-end forecast and the budget alerts, deterministic: every clock is fixed, nothing sleeps.

Covers month boundaries, timezones (including a clock change), leap days, sparse and short histories, provider lag,
alert dedupe, a higher threshold firing later, and that nothing leaves the app unless the owner opted in."""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import select

from agent_memory.alerts.notifier import deliver_pending
from agent_memory.alerts.watch import check_budgets
from agent_memory.insights.projection import (
    DATA_NOTE,
    RULE,
    STALE_AFTER,
    build_projection,
    day_bounds,
    is_timezone,
    month_projection,
    month_window,
    zone,
)
from agent_memory.models import Alert, Job, Project, Run
from agent_memory.security import generate_key, hash_key

D = Decimal


def utc(*a):
    return datetime(*a, tzinfo=UTC)


def steady(today: date, per_day="10", days=7):
    return {today - timedelta(days=k): D(per_day) for k in range(1, days + 1)}


def proj(now, *, tz="UTC", spend="100", daily=None, first=None, newest=None, budget=None, unpriced=0):
    today = now.astimezone(zone(tz)).date()
    return build_projection(
        now=now, tz_name=tz, month_spend=D(spend), unpriced_runs=unpriced,
        daily_spend=steady(today) if daily is None else daily,
        first_priced_day=(today - timedelta(days=30)) if first is None else first,
        newest_call_at=now - timedelta(hours=1) if newest is None else newest,
        budget=D(budget) if budget is not None else None)


# ---- month boundaries, year end, leap days --------------------------------------------------------------------

def test_the_last_second_of_a_month_belongs_to_that_month():
    p = proj(utc(2026, 11, 30, 23, 59, 59))
    assert (p.month, p.day_of_month, p.days_in_month) == ("2026-11", 30, 30)
    assert p.period_start == utc(2026, 11, 1) and p.period_end == utc(2026, 12, 1)
    assert (p.first_day, p.last_day) == (date(2026, 11, 1), date(2026, 11, 30))
    assert p.days_left == pytest.approx(1 / 86400, abs=1e-4)


def test_the_first_second_of_the_next_month_starts_a_new_month():
    p = proj(utc(2026, 12, 1, 0, 0, 0))
    assert (p.month, p.day_of_month) == ("2026-12", 1) and p.period_start == utc(2026, 12, 1)
    assert p.days_left == pytest.approx(31.0)


def test_december_rolls_into_january_of_the_next_year():
    p = proj(utc(2026, 12, 31, 12))
    assert p.period_end == utc(2027, 1, 1) and p.last_day == date(2026, 12, 31) and p.days_left == pytest.approx(0.5)


@pytest.mark.parametrize("now,days,last", [
    (utc(2028, 2, 10), 29, date(2028, 2, 29)),   # a leap year
    (utc(2027, 2, 10), 28, date(2027, 2, 28)),
    (utc(2100, 2, 10), 28, date(2100, 2, 28)),   # a century year that is not a leap year
    (utc(2000, 2, 10), 29, date(2000, 2, 29)),   # a century year that is
    (utc(2026, 4, 10), 30, date(2026, 4, 30)),
    (utc(2026, 1, 10), 31, date(2026, 1, 31)),
])
def test_month_length_comes_from_the_calendar(now, days, last):
    p = proj(now)
    assert p.days_in_month == days and p.last_day == last


def test_the_forecast_uses_the_leap_day():
    on_the_28th = proj(utc(2028, 2, 28, 12), spend="100")
    assert on_the_28th.days_left == pytest.approx(1.5)                 # the rest of the 28th, and the 29th
    assert on_the_28th.projected_likely_usd == D("100") + D("10") * D("1.5")
    not_leap = proj(utc(2027, 2, 28, 12), spend="100")
    assert not_leap.days_left == pytest.approx(0.5)                    # 28 Feb is the last day


# ---- timezones ----------------------------------------------------------------------------------------------------

def test_the_same_instant_is_a_different_month_in_a_different_timezone():
    now = utc(2026, 11, 30, 23, 30)
    assert proj(now, tz="UTC").month == "2026-11"
    auckland = proj(now, tz="Pacific/Auckland")                        # UTC+13: already 1 December
    assert (auckland.month, auckland.day_of_month) == ("2026-12", 1)
    assert auckland.period_start == utc(2026, 11, 30, 11)              # local midnight, written as UTC
    assert proj(now, tz="America/Los_Angeles").month == "2026-11"      # UTC-8: still 30 November


def test_a_month_that_contains_a_clock_change_starts_and_ends_at_local_midnight():
    win = month_window(utc(2026, 11, 15, 12), ZoneInfo("America/New_York"))   # DST ends on 1 Nov 2026
    assert win.start == utc(2026, 11, 1, 4)                            # midnight EDT
    assert win.end == utc(2026, 12, 1, 5)                              # midnight EST
    start, end = day_bounds(date(2026, 11, 1), ZoneInfo("America/New_York"))
    assert end - start == timedelta(hours=25)                          # the day the clocks go back
    start, end = day_bounds(date(2026, 3, 8), ZoneInfo("America/New_York"))
    assert end - start == timedelta(hours=23)                          # the day they go forward


def test_the_timezone_is_named_in_the_result_and_an_unknown_one_falls_back_to_utc():
    assert proj(utc(2026, 11, 15), tz="Europe/Berlin").timezone == "Europe/Berlin"
    assert proj(utc(2026, 11, 15), tz="Not/AZone").timezone == "UTC"
    assert proj(utc(2026, 11, 15), tz=None).timezone == "UTC"
    assert is_timezone("Europe/Berlin") and is_timezone("UTC") and not is_timezone("Mars/Base")


def test_the_last_seven_full_days_are_counted_in_the_projects_timezone():
    now = utc(2026, 11, 20, 3)                                         # 20 Nov 03:00 UTC = 19 Nov 22:00 in New York
    ny = proj(now, tz="America/New_York")
    assert ny.recent_days[0][0] == date(2026, 11, 18)                  # the last FULL local day is the 18th, not the 19th
    assert proj(now, tz="UTC").recent_days[0][0] == date(2026, 11, 19)


# ---- actual and projected are kept apart, with a range ------------------------------------------------------------

def test_actual_spend_and_the_forecast_are_separate_numbers():
    p = proj(utc(2026, 11, 20, 12), spend="100")
    assert p.state == "ok" and p.actual_usd == D("100")
    assert p.projected_low_usd == p.projected_likely_usd == p.projected_high_usd == D("205.00")  # 100 + 10 * 10.5 days


def test_the_range_is_the_lowest_and_highest_recent_day_and_the_likely_value_is_their_mean():
    today = date(2026, 11, 20)
    daily = {today - timedelta(days=k): D(v) for k, v in enumerate(["4", "6", "8", "10", "12", "14", "16"], start=1)}
    p = proj(utc(2026, 11, 20, 0), spend="50", daily=daily)            # 11 whole days left (20 to 30 Nov)
    assert p.days_left == pytest.approx(11.0)
    assert p.projected_low_usd == D("94.00") and p.projected_high_usd == D("226.00")   # 50 + 4 * 11, 50 + 16 * 11
    assert p.projected_likely_usd == D("160.00")                       # mean 10 * 11 days + 50
    assert p.projected_low_usd < p.projected_likely_usd < p.projected_high_usd


def test_amounts_are_rounded_to_cents():
    today = date(2026, 11, 20)
    p = proj(utc(2026, 11, 20, 0), spend="0.005", daily={today - timedelta(days=k): D("0.333") for k in range(1, 8)})
    assert p.projected_likely_usd == (D("0.005") + D("0.333") * 11).quantize(D("0.01")) == D("3.67")


def test_unpriced_calls_are_disclosed_and_in_no_figure():
    p = proj(utc(2026, 11, 20, 12), spend="100", unpriced=7)
    assert p.unpriced_runs == 7 and p.actual_usd == D("100")           # priced spend only, the gap is stated beside it


def test_the_result_names_currency_dates_rule_and_data_delay():
    p = proj(utc(2026, 11, 20, 12))
    assert p.currency == "USD" and (p.first_day, p.last_day) == (date(2026, 11, 1), date(2026, 11, 30))
    assert p.rule == RULE and "5 of the last 7" in RULE and "48 hours" in RULE and "7 full days" in RULE
    assert p.data_note == DATA_NOTE and "delay on your provider's own billing" in DATA_NOTE and "every hour" in DATA_NOTE


# ---- no forecast from a short or sparse history ---------------------------------------------------------------------

def test_a_history_under_seven_full_days_gets_no_forecast_and_says_why():
    now = utc(2026, 11, 20, 12)
    p = proj(now, first=date(2026, 11, 14))                            # 6 full days
    assert (p.state, p.reason) == ("not_enough_history", "too_new") and p.projected_likely_usd is None
    assert p.actual_usd == D("100")                                    # the fact is still shown


def test_exactly_seven_full_days_is_enough():
    assert proj(utc(2026, 11, 20, 12), first=date(2026, 11, 13)).state == "ok"


@pytest.mark.parametrize("active,state", [(7, "ok"), (5, "ok"), (4, "not_enough_history"), (1, "not_enough_history"), (0, "not_enough_history")])
def test_a_sparse_history_needs_spend_on_at_least_five_of_the_last_seven_days(active, state):
    today = date(2026, 11, 20)
    daily = {today - timedelta(days=k): D("10") for k in range(1, active + 1)}
    p = proj(utc(2026, 11, 20, 12), daily=daily)
    assert p.state == state and p.active_days == active
    if state != "ok":
        assert p.reason == "sparse" and p.projected_low_usd is None


def test_no_spend_at_all_is_its_own_state():
    p = build_projection(now=utc(2026, 11, 20), tz_name="UTC", month_spend=D(0), unpriced_runs=0, daily_spend={},
                         first_priced_day=None, newest_call_at=None)
    assert p.state == "no_spend" and p.projected_likely_usd is None


# ---- provider lag and silence -----------------------------------------------------------------------------------

def test_a_late_arriving_call_still_counts_and_the_forecast_runs_while_the_newest_call_is_under_48_hours_old():
    now = utc(2026, 11, 20, 12)
    for hours in (0, 1, 24, 47, 48):                                   # 48 hours exactly is not yet stale
        assert proj(now, newest=now - timedelta(hours=hours)).state == "ok"


def test_with_no_call_recorded_for_over_48_hours_the_forecast_pauses_but_the_actual_stays():
    now = utc(2026, 11, 20, 12)
    p = proj(now, newest=now - STALE_AFTER - timedelta(minutes=1))
    assert (p.state, p.reason) == ("paused", "no_recent_calls") and p.projected_likely_usd is None
    assert p.actual_usd == D("100") and p.data_through == now - timedelta(hours=48, minutes=1)


# ---- against the budget -------------------------------------------------------------------------------------------

@pytest.mark.parametrize("budget,expected", [("150", "over"), ("204.99", "over"), ("205", "under"), ("1000", "under"), (None, None)])
def test_where_the_range_sits_against_the_budget(budget, expected):
    assert proj(utc(2026, 11, 20, 12), budget=budget).vs_budget == expected


def test_over_needs_the_low_end_above_the_budget_may_go_over_only_the_high_end():
    today = date(2026, 11, 20)
    daily = {today - timedelta(days=k): D(v) for k, v in enumerate(["2", "2", "2", "2", "2", "2", "30"], start=1)}
    p = proj(utc(2026, 11, 20, 0), spend="100", daily=daily)           # 11 days left: low 100 + 2*11, high 100 + 30*11
    assert (p.projected_low_usd, p.projected_high_usd) == (D("122.00"), D("430.00"))
    assert proj(utc(2026, 11, 20, 0), spend="100", daily=daily, budget="300").vs_budget == "may_go_over"
    assert proj(utc(2026, 11, 20, 0), spend="100", daily=daily, budget="110").vs_budget == "over"
    assert proj(utc(2026, 11, 20, 0), spend="100", daily=daily, budget="500").vs_budget == "under"
    assert proj(utc(2026, 11, 20, 0), spend="100", daily=daily, budget="430").vs_budget == "under"     # the high end equals it
    assert proj(utc(2026, 11, 20, 0), spend="100", daily=daily, budget="122").vs_budget == "may_go_over"  # the low end equals it


# ================================ with a database =====================================================================

NOW = utc(2026, 11, 20, 12, 30)
SESSIONS_JOB = {"name": "invoice", "check_kind": "LATE_LABEL", "check_config": {}}


async def make_project(session, pid="acme", *, budget="100", mode="per_use", tz="UTC", levels=None, projected=True,
                       webhook=None, webhook_on=False):
    p = Project(project_id=pid, api_key_hash=hash_key(generate_key()), monthly_budget_usd=D(budget), billing_mode=mode,
                budget_timezone=tz, budget_alert_projected=projected, budget_alert_webhook=webhook_on,
                webhook_url=webhook, webhook_secret="s" if webhook else None)
    if levels is not None:
        p.budget_alert_levels = levels
    session.add(p)
    await session.flush()
    job = Job(project_id=pid, **SESSIONS_JOB)
    session.add(job)
    await session.flush()
    return p, job


def run(job, when, cost="1.00", kind="PRODUCTION"):
    return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=job.project_id, prompt="p", prompt_hash=str(uuid.uuid4()),
               model="m", model_version="m-1", outcome="PASS", tokens_in=10, run_kind=kind, created_at=when,
               cost_usd=D(cost) if cost is not None else None)


def daily_pace(job, per_day, *, days=14, end=NOW):
    return [run(job, end - timedelta(days=k, hours=1), cost=per_day) for k in range(1, days + 1)]


async def alerts_of(session, kind="BUDGET"):
    return (await session.execute(select(Alert).where(Alert.kind == kind).order_by(Alert.created_at))).scalars().all()


async def test_the_loader_attributes_calls_to_the_projects_local_days(session):
    _, job = await make_project(session, tz="Pacific/Auckland")
    # 15 Nov 22:00 UTC is 16 Nov 11:00 in Auckland (UTC+13): the 16th there, the 15th in UTC. Both are full days
    # inside the 7-day window that ends before 20 Nov.
    session.add_all([run(job, utc(2026, 11, 15, 22), "3.00"), run(job, utc(2026, 11, 3), "1.00")])
    await session.commit()
    project = await session.get(Project, "acme")
    nz = await month_projection(session, project, NOW)
    assert dict(nz.recent_days)[date(2026, 11, 16)] == D("3.00") and dict(nz.recent_days)[date(2026, 11, 15)] == 0
    project.budget_timezone = "UTC"
    utc_p = await month_projection(session, project, NOW)
    assert dict(utc_p.recent_days)[date(2026, 11, 15)] == D("3.00") and dict(utc_p.recent_days)[date(2026, 11, 16)] == 0
    assert nz.actual_usd == utc_p.actual_usd == D("4.00")             # the month total is the same either way here


async def test_a_clock_change_day_is_one_local_day_in_the_loader(session):
    _, job = await make_project(session, tz="America/New_York")
    # 1 Nov 2026 is 25 hours long in New York: 04:00Z to 05:00Z the next day. Spend at both ends is one day's spend.
    session.add_all([run(job, utc(2026, 11, 1, 4, 30), "2.00"), run(job, utc(2026, 11, 2, 4, 30), "5.00")])
    await session.commit()
    p = await month_projection(session, await session.get(Project, "acme"), utc(2026, 11, 5, 12))
    days = dict(p.recent_days)
    assert days[date(2026, 11, 1)] == D("7.00") and days[date(2026, 11, 2)] == 0    # 04:30Z on the 2nd is still the 1st (23:30 EST)


async def test_the_loader_counts_only_this_projects_priced_production_calls_in_this_month(session):
    _, job = await make_project(session)
    _, other = await make_project(session, "other")
    session.add_all([run(job, NOW - timedelta(days=2), "5.00"), run(job, NOW - timedelta(days=2), None),
                     run(job, NOW - timedelta(days=2), "9.00", kind="RETEST"), run(job, utc(2026, 10, 31, 23), "7.00"),
                     run(other, NOW - timedelta(days=2), "50.00")])
    await session.commit()
    p = await month_projection(session, await session.get(Project, "acme"), NOW)
    assert p.actual_usd == D("5.00") and p.unpriced_runs == 1          # not the re-test, last month or the other project


# ---- alerts: actual crossings and projected-over are separate -------------------------------------------------------

async def test_an_actual_crossing_and_a_projected_warning_are_two_different_alerts(session):
    _, job = await make_project(session, budget="460")
    session.add_all(daily_pace(job, "10"))                              # 14 days at $10, $140 in this month
    session.add(run(job, NOW - timedelta(hours=1), "255"))              # $395 of $460: 85.9%, past 85% and not 95%
    await session.commit()
    raised = await check_budgets(session, now=NOW)
    kinds = {a.detail["kind"]: a for a in raised}
    assert set(kinds) == {"actual", "projected"}
    assert kinds["actual"].detail["level"] == "85" and "already happened" in kinds["actual"].detail["summary"]
    assert kinds["projected"].detail["level"] == "PROJECTED" and "forecast, not spend that has happened" in kinds["projected"].detail["summary"]
    assert kinds["projected"].detail["projected_low_usd"] <= kinds["projected"].detail["projected_usd"] <= kinds["projected"].detail["projected_high_usd"]
    assert "UTC" in kinds["actual"].detail["summary"] and "2026-11" in kinds["actual"].detail["summary"]


async def test_the_projected_warning_needs_even_the_low_end_over_the_budget(session):
    _, job = await make_project(session, budget="200")
    # six $1 days and one $40 day: the likely figure is over $200 but the low end is not
    rows = [run(job, NOW - timedelta(days=k, hours=1), "1.00") for k in range(2, 8)] + [run(job, NOW - timedelta(days=1, hours=1), "40.00")]
    session.add_all(rows + [run(job, NOW - timedelta(days=12), "60.00")])
    await session.commit()
    project = await session.get(Project, "acme")
    p = await month_projection(session, project, NOW)
    assert p.state == "ok" and p.vs_budget == "may_go_over"
    assert await check_budgets(session, now=NOW) == []


async def test_no_projected_warning_from_a_short_or_sparse_history(session):
    _, job = await make_project(session, budget="50")
    session.add_all([run(job, NOW - timedelta(days=d, hours=1), "30.00") for d in (1, 2, 3)])  # 3 days only
    await session.commit()
    p = await month_projection(session, await session.get(Project, "acme"), NOW)
    assert (p.state, p.reason) == ("not_enough_history", "too_new")
    raised = await check_budgets(session, now=NOW)
    assert [a.detail["kind"] for a in raised] == ["actual"]            # spend that happened still alerts; no forecast does


async def test_a_paused_forecast_raises_no_projected_warning_but_the_actual_threshold_still_fires(session):
    _, job = await make_project(session, budget="100")
    old = NOW - timedelta(days=3)
    session.add_all([run(job, old - timedelta(days=k), "10.00") for k in range(0, 9)])   # active, then silent for 3 days
    await session.commit()
    p = await month_projection(session, await session.get(Project, "acme"), NOW)
    assert p.state == "paused"
    raised = await check_budgets(session, now=NOW)
    assert [a.detail["kind"] for a in raised] == ["actual"] and raised[0].detail["level"] == "85"   # $90 of $100


async def test_projected_warnings_can_be_turned_off_by_the_owner(session):
    _, job = await make_project(session, budget="300", projected=False)
    session.add_all(daily_pace(job, "10") + [run(job, NOW - timedelta(hours=1), "255")])
    await session.commit()
    assert [a.detail["kind"] for a in await check_budgets(session, now=NOW)] == ["actual"]


async def test_the_owner_chooses_the_thresholds(session):
    _, job = await make_project(session, budget="100", levels=[50, 100])
    session.add(run(job, NOW - timedelta(hours=1), "60"))               # 60%: past 50, before 100; 85 is not in the list
    await session.commit()
    [alert] = await check_budgets(session, now=NOW)
    assert alert.detail["level"] == "50"
    assert await check_budgets(session, now=NOW + timedelta(hours=1)) == []


async def test_a_project_with_no_thresholds_still_gets_the_projected_warning_if_on(session):
    _, job = await make_project(session, budget="100", levels=[])
    session.add_all(daily_pace(job, "10") + [run(job, NOW - timedelta(hours=1), "50")])
    await session.commit()
    assert [a.detail["kind"] for a in await check_budgets(session, now=NOW)] == ["projected"]


# ---- dedupe and a higher tier --------------------------------------------------------------------------------------

async def test_the_same_alert_is_never_raised_twice_in_a_month(session):
    _, job = await make_project(session, budget="100")
    session.add(run(job, NOW - timedelta(hours=1), "86"))
    await session.commit()
    assert len(await check_budgets(session, now=NOW)) == 1
    for later in (NOW + timedelta(minutes=5), NOW + timedelta(hours=1), NOW + timedelta(days=3)):
        assert await check_budgets(session, now=later) == []
    assert len(await alerts_of(session)) == 1


async def test_a_resolved_alert_is_not_raised_again_in_the_same_month(session):
    _, job = await make_project(session, budget="100")
    session.add(run(job, NOW - timedelta(hours=1), "86"))
    await session.commit()
    [first] = await check_budgets(session, now=NOW)
    first.resolved_at = NOW
    await session.commit()
    assert await check_budgets(session, now=NOW + timedelta(days=1)) == []


async def test_crossing_a_higher_threshold_later_fires_a_second_alert(session):
    _, job = await make_project(session, budget="100")
    session.add(run(job, NOW - timedelta(hours=2), "86"))
    await session.commit()
    [low] = await check_budgets(session, now=NOW)
    session.add(run(job, NOW + timedelta(hours=1), "10"))               # now $96: past 95%
    await session.commit()
    [high] = await check_budgets(session, now=NOW + timedelta(hours=2))
    assert (low.detail["level"], high.detail["level"]) == ("85", "95")
    assert await check_budgets(session, now=NOW + timedelta(hours=3)) == []


async def test_jumping_past_both_thresholds_raises_only_the_highest(session):
    _, job = await make_project(session, budget="100")
    session.add(run(job, NOW - timedelta(hours=1), "97"))
    await session.commit()
    assert [a.detail["level"] for a in await check_budgets(session, now=NOW)] == ["95"]


async def test_a_new_month_starts_fresh(session):
    _, job = await make_project(session, budget="100")
    session.add_all([run(job, NOW - timedelta(hours=1), "86"), run(job, utc(2026, 12, 2, 10), "88")])
    await session.commit()
    assert len(await check_budgets(session, now=NOW)) == 1
    [dec] = await check_budgets(session, now=utc(2026, 12, 3, 5))
    assert dec.detail["month"] == "2026-12" and dec.detail["spent_usd"] == 88.0


async def test_a_new_budget_re_arms_the_thresholds(session):
    _, job = await make_project(session, budget="100")
    session.add(run(job, NOW - timedelta(hours=1), "86"))
    await session.commit()
    assert len(await check_budgets(session, now=NOW)) == 1
    project = await session.get(Project, "acme")
    project.monthly_budget_usd = D("90")                                # $86 is 95.5% of the new budget
    await session.commit()
    [again] = await check_budgets(session, now=NOW + timedelta(hours=1))
    assert again.detail["level"] == "95" and again.detail["budget_usd"] == 90.0


async def test_the_month_boundary_follows_the_projects_timezone(session):
    _, nz_job = await make_project(session, "nz", budget="100", tz="Pacific/Auckland")
    _, utc_job = await make_project(session, "plain", budget="100", tz="UTC")
    for job in (nz_job, utc_job):
        session.add(run(job, utc(2026, 11, 30, 10), "86"))             # 30 Nov 23:00 in Auckland, 10:00 UTC
    await session.commit()
    before = utc(2026, 11, 30, 10, 30)                                 # 30 Nov 23:30 in Auckland: still November there
    assert {a.detail["month"] for a in await check_budgets(session, now=before)} == {"2026-11"}
    # 30 Nov 11:30 UTC is 1 Dec 00:30 in Auckland. Its new month has no spend; the UTC project is still in November
    session2 = [a for a in await alerts_of(session)]
    assert len(session2) == 2                                          # one alert per project, both for November
    after = utc(2026, 11, 30, 11, 30)
    assert await check_budgets(session, now=after) == []              # deduped (UTC) and a fresh, empty December (Auckland)
    nz = await month_projection(session, await session.get(Project, "nz"), after)
    plain = await month_projection(session, await session.get(Project, "plain"), after)
    assert (nz.month, nz.actual_usd) == ("2026-12", D(0)) and (plain.month, plain.actual_usd) == ("2026-11", D("86.00"))
    assert nz.period_start == utc(2026, 11, 30, 11) and plain.period_start == utc(2026, 11, 1)


async def test_a_leap_february_budget_month_runs_to_the_29th(session):
    _, job = await make_project(session, budget="100")
    session.add(run(job, utc(2028, 2, 29, 9), "86"))
    await session.commit()
    [alert] = await check_budgets(session, now=utc(2028, 2, 29, 10))
    assert alert.detail["month"] == "2028-02" and alert.detail["spent_usd"] == 86.0
    assert await check_budgets(session, now=utc(2028, 3, 1, 0, 30)) == []   # March has none of it


# ---- subscription projects get no dollar alerts ------------------------------------------------------------------

async def test_a_subscription_project_gets_no_dollar_alert_of_either_kind(session):
    _, job = await make_project(session, budget="100", mode="subscription")
    session.add_all(daily_pace(job, "10") + [run(job, NOW - timedelta(hours=1), "96")])
    await session.commit()
    assert await check_budgets(session, now=NOW) == [] and await alerts_of(session) == []


# ---- notifications: in the app by default, outside it only if the owner opts in --------------------------------------

async def _deliver(session, *, now=NOW):
    sent: list[httpx.Request] = []

    def handler(request):
        sent.append(request)
        return httpx.Response(204)

    result = await deliver_pending(session, now=now, transport=httpx.MockTransport(handler))
    return result, sent


async def test_a_budget_alert_is_only_in_the_app_by_default_even_with_a_webhook_address(session):
    _, job = await make_project(session, budget="100", webhook="https://hooks.example/x")
    session.add(run(job, NOW - timedelta(hours=1), "86"))
    await session.commit()
    await check_budgets(session, now=NOW)
    assert len(await alerts_of(session)) == 1                          # in the app: always
    (delivered, failed), sent = await _deliver(session)
    assert (delivered, failed, sent) == (0, 0, [])                     # nothing left the app
    assert (await alerts_of(session))[0].delivered_at is None


async def test_a_budget_alert_is_sent_to_the_webhook_once_the_owner_opts_in(session):
    _, job = await make_project(session, budget="100", webhook="https://hooks.example/x", webhook_on=True)
    session.add(run(job, NOW - timedelta(hours=1), "86"))
    await session.commit()
    await check_budgets(session, now=NOW)
    (delivered, failed), sent = await _deliver(session)
    assert (delivered, failed, len(sent)) == (1, 0, 1)


async def test_the_opt_in_covers_budget_alerts_only_other_alerts_follow_the_webhook_as_before(session):
    _, job = await make_project(session, budget="100", webhook="https://hooks.example/x")
    session.add(Alert(job_id=job.job_id, kind="SILENT_DROP", detail={"summary": "fell"}, dedupe_key="a"))
    session.add(Alert(job_id=job.job_id, kind="BUDGET", detail={"summary": "x", "level": "85"}, dedupe_key="b"))
    await session.commit()
    (delivered, _), sent = await _deliver(session)
    assert delivered == 1 and len(sent) == 1 and b"SILENT_DROP" in sent[0].content


async def test_without_a_webhook_address_nothing_is_ever_sent(session):
    _, job = await make_project(session, budget="100", webhook=None, webhook_on=True)
    session.add(run(job, NOW - timedelta(hours=1), "86"))
    await session.commit()
    await check_budgets(session, now=NOW)
    (delivered, failed), sent = await _deliver(session)
    assert (delivered, failed, sent) == (0, 0, [])


# ---- settings through the API ----------------------------------------------------------------------------------------

async def test_the_defaults_are_in_the_app_only_utc_and_85_95(client, session):
    from agent_memory.projects import create_project

    _, key = await create_project(session, "defaults")
    body = (await client.get("/v1/insights/projection", headers={"X-API-Key": key})).json()
    assert body["state"] == "no_spend" and body["timezone"] == "UTC" and body["currency"] == "USD"
    assert body["rule"] == RULE and body["data_note"] == DATA_NOTE
    project = await session.get(Project, "defaults")
    assert (project.budget_timezone, list(project.budget_alert_levels), project.budget_alert_projected, project.budget_alert_webhook) \
        == ("UTC", [85, 95], True, False)


async def test_the_projection_endpoint_returns_actual_and_a_range_apart(client, session):
    from agent_memory.projects import create_project

    project, key = await create_project(session, "range")
    job = Job(project_id="range", **SESSIONS_JOB)
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)
    session.add_all([run(job, now - timedelta(days=k, hours=1), "10.00") for k in range(1, 15)] + [run(job, now - timedelta(minutes=5), None)])
    await session.commit()
    body = (await client.get("/v1/insights/projection", headers={"X-API-Key": key})).json()
    assert body["state"] == "ok" and body["unpriced_runs"] == 1 and len(body["recent_days"]) == 7
    assert body["projected_low_usd"] <= body["projected_likely_usd"] <= body["projected_high_usd"]
    assert body["actual_usd"] >= 0 and "actual_usd" in body and "projected_likely_usd" in body
    assert (await client.get("/v1/insights/projection")).status_code in (401, 403)


# ---- saving the settings: an owner chooses, and nothing is on without a choice ---------------------------------------

@pytest.fixture
def signed_in(client, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def go(email="owner@example.com"):
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200
        created = (await client.post("/v1/projects", json={"name": "Shop"})).json()["project"]
        return created["project_id"], created

    return go


async def test_a_new_project_starts_with_in_app_alerts_only_utc_and_the_two_default_thresholds(client, signed_in):
    _, project = await signed_in()
    assert (project["budget_timezone"], project["budget_alert_levels"]) == ("UTC", [85, 95])
    assert (project["budget_alert_projected"], project["budget_alert_webhook"]) == (True, False)


async def test_the_owner_can_choose_timezone_thresholds_and_the_projected_warning(client, signed_in):
    pid, _ = await signed_in()
    saved = (await client.patch(f"/v1/projects/{pid}", json={
        "budget_timezone": "Europe/Berlin", "budget_alert_levels": [95, 50, 75], "budget_alert_projected": False,
    })).json()
    assert saved["budget_timezone"] == "Europe/Berlin" and saved["budget_alert_levels"] == [50, 75, 95]  # kept in order
    assert saved["budget_alert_projected"] is False and saved["budget_alert_webhook"] is False         # untouched
    assert (await client.patch(f"/v1/projects/{pid}", json={"budget_alert_levels": []})).json()["budget_alert_levels"] == []


@pytest.mark.parametrize("bad", [
    {"budget_timezone": "Mars/Base"}, {"budget_timezone": ""}, {"budget_timezone": "x" * 80},
    {"budget_alert_levels": [0]}, {"budget_alert_levels": [101]}, {"budget_alert_levels": [85, 85]},
    {"budget_alert_levels": [10, 20, 30, 40, 50, 60, 70]}, {"budget_alert_levels": [-5]},
])
async def test_values_that_make_no_sense_are_refused(client, signed_in, bad):
    pid, before = await signed_in()
    assert (await client.patch(f"/v1/projects/{pid}", json=bad)).status_code == 422
    after = (await client.get(f"/v1/projects/{pid}")).json()
    assert (after["budget_timezone"], after["budget_alert_levels"]) == (before["budget_timezone"], before["budget_alert_levels"])


async def test_the_webhook_opt_in_needs_a_webhook_address_first_and_is_off_until_chosen(client, signed_in):
    pid, _ = await signed_in()
    refused = await client.patch(f"/v1/projects/{pid}", json={"budget_alert_webhook": True})
    assert refused.status_code == 422 and "webhook address first" in refused.text
    assert (await client.get(f"/v1/projects/{pid}")).json()["budget_alert_webhook"] is False
    await client.patch(f"/v1/projects/{pid}", json={"webhook_url": "https://hooks.example/x"})
    # adding the address does not turn budget alerts on: that is a separate choice
    assert (await client.get(f"/v1/projects/{pid}")).json()["budget_alert_webhook"] is False
    on = (await client.patch(f"/v1/projects/{pid}", json={"budget_alert_webhook": True})).json()
    assert on["budget_alert_webhook"] is True
    assert (await client.patch(f"/v1/projects/{pid}", json={"budget_alert_webhook": False})).json()["budget_alert_webhook"] is False


async def test_there_is_no_email_destination_to_opt_into(client, signed_in):
    pid, project = await signed_in()
    assert not [k for k in project if "email" in k]                      # email alerts are not built, so none can be on
    assert (await client.patch(f"/v1/projects/{pid}", json={"budget_alert_email": True})).status_code in (200, 422)
    assert not [k for k in (await client.get(f"/v1/projects/{pid}")).json() if "email" in k]


async def test_a_blocking_or_enforcing_setting_does_not_exist(client, signed_in):
    pid, project = await signed_in()
    forbidden = ("block", "hard", "enforce", "stop", "cap_calls", "throttle")
    assert not [k for k in project if any(w in k for w in forbidden)]
