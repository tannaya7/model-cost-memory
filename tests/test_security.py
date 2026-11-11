"""API key handling (no database needed)."""

from agent_memory.security import KEY_PREFIX, extract_key, generate_key, hash_key


def test_keys_are_random_prefixed_and_long():
    a, b = generate_key(), generate_key()
    assert a != b
    assert a.startswith(KEY_PREFIX) and len(a) > 30


def test_the_hash_is_stable_and_does_not_contain_the_key():
    key = generate_key()
    assert hash_key(key) == hash_key(key)
    assert key not in hash_key(key)
    assert len(hash_key(key)) == 64


def test_key_is_read_from_either_header():
    assert extract_key("abc", None) == "abc"
    assert extract_key(None, "Bearer abc") == "abc"
    assert extract_key(None, "bearer  abc ") == "abc"
    assert extract_key("first", "Bearer second") == "first"


def test_missing_or_malformed_headers_give_no_key():
    assert extract_key(None, None) is None
    assert extract_key("  ", None) is None
    assert extract_key(None, "Basic abc") is None
    assert extract_key(None, "Bearer") is None
