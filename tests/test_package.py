"""Week 1 smoke test: the package imports and exposes its version."""

import agent_memory


def test_version() -> None:
    assert agent_memory.__version__
