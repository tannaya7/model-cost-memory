"""The committed API contract (contract/) matches what the code publishes."""

import importlib.util
import json
from pathlib import Path

import pytest

from agent_memory.schemas import JobOut, ModelPage, RecommendationOut, RunPage, SpendOut

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def built():
    spec = importlib.util.spec_from_file_location("export_openapi", ROOT / "scripts" / "export_openapi.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build()


@pytest.mark.parametrize("name", ["openapi.json", "samples/jobs.json", "samples/runs.json", "samples/models.json",
                                  "samples/recommendation.json", "samples/spend.json"])
def test_committed_contract_is_up_to_date(built, name):
    committed = (ROOT / "contract" / name).read_text(encoding="utf8")
    assert committed == built[name], "run `python scripts/export_openapi.py` and commit contract/"


def test_samples_validate_against_the_models(built):
    for item in json.loads(built["samples/jobs.json"]):
        JobOut.model_validate(item)
    RunPage.model_validate(json.loads(built["samples/runs.json"]))
    ModelPage.model_validate(json.loads(built["samples/models.json"]))
    RecommendationOut.model_validate(json.loads(built["samples/recommendation.json"]))
    for item in json.loads(built["samples/spend.json"]):
        SpendOut.model_validate(item)


def test_openapi_lists_the_week_two_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert {"/healthz", "/v1/jobs", "/v1/runs", "/v1/models"} <= set(paths)


def test_openapi_lists_the_week_seven_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert {"/v1/jobs/{job}/recommendation", "/v1/insights/spend"} <= set(paths)


def test_openapi_lists_the_week_eight_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert "/v1/jobs/{job}/history" in paths
    assert "recommendation" in {p["name"] for p in paths["/v1/runs"]["get"]["parameters"]}


def test_openapi_lists_the_week_nine_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert {"/v1/jobs/{job}/regressions", "/v1/alerts", "/v1/alerts/{alert_id}/resolve"} <= set(paths)


def test_openapi_lists_the_week_ten_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert {"/v1/jobs/{job}/retest", "/v1/jobs/{job}/retest/{retest_id}", "/v1/jobs/{job}/retests",
            "/v1/retest/limits", "/v1/provider-key"} <= set(paths)


def test_openapi_lists_the_week_eleven_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert {"/auth/config", "/auth/google/login", "/auth/google/callback", "/auth/logout", "/v1/me", "/v1/projects",
            "/v1/projects/{project_id}", "/v1/projects/{project_id}/key", "/v1/jobs/{job}/insights"} <= set(paths)


def test_openapi_lists_the_week_twelve_endpoints(built):
    paths = json.loads(built["openapi.json"])["paths"]
    assert {"/v1/flow", "/v1/flow/stream"} <= set(paths)
