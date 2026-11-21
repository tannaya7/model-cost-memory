"""The canonical token ledger: each provider's usage block read into distinct fields, unknown kept apart from 0."""

from types import SimpleNamespace

import pytest

from agent_memory.recorder import read_response
from agent_memory.usage_ledger import INCLUSION, SHAPES, legacy_columns, read_usage, sanitize_raw


def fields(usage):
    return read_usage(usage)["fields"]


# --- Anthropic: cache is ADDITIONAL to input_tokens; thinking is inside output ------------------------------

def test_anthropic_cache_fields_are_additional_and_not_double_counted():
    ledger = read_usage({"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 300,
                         "cache_creation_input_tokens": 248,
                         "cache_creation": {"ephemeral_5m_input_tokens": 148, "ephemeral_1h_input_tokens": 100}})
    f = ledger["fields"]
    assert ledger["shape"] == "anthropic_messages"
    assert (f["uncached_input"], f["cache_read"], f["cache_write"], f["cache_write_1h"]) == (100, 300, 248, 100)
    assert f["input_total"] == 648  # derived: Anthropic reports no total
    assert f["output_billed"] == 50 and f["total_reported"] is None


def test_anthropic_omitted_cache_fields_stay_unknown_but_the_old_columns_read_zero():
    ledger = read_usage({"input_tokens": 10, "output_tokens": 5})
    assert ledger["fields"]["cache_read"] is None and ledger["fields"]["cache_write"] is None
    assert ledger["fields"]["input_total"] is None  # not derived from partial data
    assert legacy_columns(ledger) == {"tokens_in": 10, "tokens_out": 5, "cache_read_tokens": 0, "cache_write_tokens": 0}


def test_anthropic_explicit_zero_is_a_known_zero():
    f = fields({"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})
    assert f["cache_read"] == 0 and f["cache_write"] == 0


def test_anthropic_null_cache_fields_are_unknown_not_zero():
    f = fields({"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": None,
                "cache_creation_input_tokens": None})
    assert f["cache_read"] is None and f["cache_write"] is None


def test_anthropic_one_hour_part_never_exceeds_the_total_written():
    f = fields({"input_tokens": 1, "output_tokens": 1, "cache_creation_input_tokens": 50,
                "cache_creation": {"ephemeral_1h_input_tokens": 80}})
    assert f["cache_write_1h"] == 50


# --- OpenAI: cached, cache-write and reasoning are INSIDE their totals ---------------------------------------

def test_openai_chat_cached_and_reasoning_sit_inside_the_totals():
    ledger = read_usage({"prompt_tokens": 1000, "completion_tokens": 90, "total_tokens": 1090,
                         "prompt_tokens_details": {"cached_tokens": 400},
                         "completion_tokens_details": {"reasoning_tokens": 60}})
    f = ledger["fields"]
    assert ledger["shape"] == "openai_chat"
    assert (f["input_total"], f["uncached_input"], f["cache_read"]) == (1000, 600, 400)
    assert f["output_billed"] == 90 and f["reasoning"] == 60  # reasoning is NOT added again
    assert ledger["notes"] == []


def test_openai_chat_without_details_leaves_cache_and_reasoning_unknown():
    f = fields({"prompt_tokens": 100, "completion_tokens": 10})
    assert f["cache_read"] is None and f["reasoning"] is None and f["uncached_input"] == 100


def test_openai_responses_subtracts_cached_and_written_from_input():
    ledger = read_usage({"input_tokens": 1000, "output_tokens": 50, "total_tokens": 1050,
                         "input_tokens_details": {"cached_tokens": 300, "cache_write_tokens": 200},
                         "output_tokens_details": {"reasoning_tokens": 20}})
    f = ledger["fields"]
    assert ledger["shape"] == "openai_responses"
    assert (f["uncached_input"], f["cache_read"], f["cache_write"], f["reasoning"]) == (500, 300, 200, 20)


def test_openai_cached_larger_than_input_never_goes_negative():
    assert fields({"prompt_tokens": 10, "completion_tokens": 1,
                   "prompt_tokens_details": {"cached_tokens": 50}})["uncached_input"] == 0


def test_openai_a_total_that_disagrees_with_its_parts_is_noted_not_fatal():
    ledger = read_usage({"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 999})
    assert any("differs from the sum" in n for n in ledger["notes"])
    assert ledger["fields"]["uncached_input"] == 100


# --- DeepSeek: prompt = hit + miss -----------------------------------------------------------------------------

def test_deepseek_hit_and_miss():
    ledger = read_usage({"prompt_tokens": 100, "prompt_cache_hit_tokens": 70, "prompt_cache_miss_tokens": 30,
                         "completion_tokens": 9, "total_tokens": 109})
    assert ledger["shape"] == "deepseek_chat"
    assert (ledger["fields"]["uncached_input"], ledger["fields"]["cache_read"]) == (30, 70)
    assert ledger["notes"] == []


def test_deepseek_without_a_miss_count_derives_it_from_the_prompt_total():
    f = fields({"prompt_tokens": 100, "prompt_cache_hit_tokens": 70, "completion_tokens": 9})
    assert f["uncached_input"] == 30


# --- Gemini: cached INSIDE the prompt; thoughts and tool-use are ADDITIONAL -----------------------------------

def test_gemini_cached_inside_prompt_thoughts_added_to_output_and_tool_use_kept_apart():
    ledger = read_usage({"promptTokenCount": 1000, "cachedContentTokenCount": 400, "candidatesTokenCount": 90,
                         "thoughtsTokenCount": 60, "toolUsePromptTokenCount": 40, "totalTokenCount": 1190})
    f = ledger["fields"]
    assert ledger["shape"] == "gemini"
    assert (f["uncached_input"], f["cache_read"]) == (600, 400)
    assert f["output_billed"] == 150 and f["reasoning"] == 60
    assert f["tool_use_input"] == 40 and f["uncached_input"] != 640  # never silently added to input
    assert any("not priced" in n for n in ledger["notes"])
    assert not any("differs" in n for n in ledger["notes"])  # 1000 + 150 + 40 = 1190


def test_gemini_sdk_snake_case_and_rest_camel_case_read_the_same():
    snake = fields(SimpleNamespace(prompt_token_count=50, cached_content_token_count=10, candidates_token_count=5,
                                   thoughts_token_count=None, tool_use_prompt_token_count=None,
                                   total_token_count=55))
    camel = fields({"promptTokenCount": 50, "cachedContentTokenCount": 10, "candidatesTokenCount": 5,
                    "totalTokenCount": 55})
    assert snake == camel
    assert snake["tool_use_input"] is None and snake["reasoning"] is None


def test_gemini_zero_tool_use_is_known_zero_and_adds_no_note():
    ledger = read_usage({"promptTokenCount": 5, "candidatesTokenCount": 1, "toolUsePromptTokenCount": 0})
    assert ledger["fields"]["tool_use_input"] == 0 and ledger["notes"] == []


# --- unknown, missing and odd shapes ---------------------------------------------------------------------------

def test_no_usage_block_is_shape_none_with_every_field_unknown():
    ledger = read_usage(None)
    assert ledger["shape"] == "none" and all(v is None for v in ledger["fields"].values())
    assert legacy_columns(ledger) == {}


@pytest.mark.parametrize("usage", [{}, {"foo": 1}, "text", 7, [], {"input_tokens": "12"}])
def test_unrecognised_shapes_read_nothing_and_never_raise(usage):
    ledger = read_usage(usage)
    assert ledger["shape"] == "none" and all(v is None for v in ledger["fields"].values())
    assert ledger["notes"]


@pytest.mark.parametrize("bad", [True, False, -5, float("nan"), "9", None, 10**12])
def test_unusable_counts_are_unknown_not_zero(bad):
    f = fields({"prompt_tokens": 10, "completion_tokens": bad})
    assert f["output_billed"] is None


def test_float_counts_are_truncated_to_ints():
    assert fields({"prompt_tokens": 10.0, "completion_tokens": 3.0})["output_billed"] == 3


def test_every_shape_has_an_inclusion_note_and_the_set_is_closed():
    assert set(INCLUSION) == set(SHAPES)


# --- the raw block ---------------------------------------------------------------------------------------------

def test_raw_keeps_numbers_and_price_labels_only():
    raw = sanitize_raw({"input_tokens": 5, "output_tokens": 2, "service_tier": "batch", "inference_geo": "us",
                        "prompt": "SECRET prompt text", "notes": ["SECRET"], "ok": True,
                        "cache_creation": {"ephemeral_1h_input_tokens": 3, "label": "SECRET"}})
    assert raw == {"input_tokens": 5, "output_tokens": 2, "service_tier": "batch", "inference_geo": "us",
                   "cache_creation": {"ephemeral_1h_input_tokens": 3}}
    assert "SECRET" not in str(raw)


def test_raw_is_bounded_in_keys_and_depth():
    deep = {"a": {"b": {"c": {"d": {"e": 1}}}}}
    assert sanitize_raw(deep) is None  # depth cap leaves nothing numeric
    many = {f"k{i}": i for i in range(500)}
    assert len(sanitize_raw(many)) == 40


def test_raw_is_none_for_a_non_mapping():
    assert sanitize_raw("text") is None and sanitize_raw(None) is None


# --- through read_response: backward compatibility -------------------------------------------------------------

def test_read_response_keeps_the_old_columns_and_adds_the_ledger_keys():
    data = read_response({"model": "m", "usage": {"prompt_tokens": 1000, "completion_tokens": 90,
                                                  "prompt_tokens_details": {"cached_tokens": 400},
                                                  "completion_tokens_details": {"reasoning_tokens": 60}}})
    assert data["tokens_in"] == 600 and data["tokens_out"] == 90 and data["cache_read_tokens"] == 400
    assert data["usage_shape"] == "openai_chat" and data["reasoning_tokens"] == 60
    assert data["usage_raw"]["prompt_tokens_details"] == {"cached_tokens": 400}


def test_read_response_with_no_usage_marks_the_counts_unknown():
    data = read_response({"model": "m", "choices": [{"message": {"content": "hi"}}]})
    assert data["usage_shape"] == "none" and "tokens_in" not in data and "usage_raw" not in data
    assert data["output"] == "hi"


def test_read_response_never_raises_on_odd_usage():
    data = read_response({"usage": SimpleNamespace(input_tokens=None, output_tokens=object())})
    assert data["usage_shape"] == "none"
