"""Provider tests — the Hermes-facing contract.

Chiefly: the provider must never take the host down with it. Every one of
these exercises a failure path and asserts the agent keeps running.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from dmemo_hermes.provider import DmemoMemoryProvider
from dmemo_hermes.session import DmemoSession, RestoreStats


@pytest.fixture(autouse=True)
def _isolated_config(config, monkeypatch):
    """Don't let a real ~/.dmemo/config.json decide whether these tests pass."""
    monkeypatch.setattr("dmemo_hermes.provider.load_config", lambda env=None: config)


class FakeSession:
    """Enough of DmemoSession for the provider to consider itself live."""

    def __init__(self) -> None:
        self.adds = []
        self.restore_stats = RestoreStats(restored=True, chain_length=1, vector_rows=3)
        self.transport = SimpleNamespace(address="0xdeadbeef")

    def add(self, text, **kwargs):
        self.adds.append((text, kwargs))

    def flush(self):
        pass

    def close(self):
        pass


def _live_provider(monkeypatch, **init_kwargs) -> tuple:
    session = FakeSession()
    monkeypatch.setattr(DmemoSession, "open", staticmethod(lambda *a, **k: session))
    provider = DmemoMemoryProvider()
    kwargs = {
        "session_id": "s1",
        "hermes_home": "/nonexistent",
        "platform": "cli",
        "agent_context": "primary",
        **init_kwargs,
    }
    provider.initialize(**kwargs)
    return provider, session


def test_uninitialized_provider_answers_tools_instead_of_raising():
    p = DmemoMemoryProvider()
    out = json.loads(p.handle_tool_call("dmemo_search", {"query": "anything"}))
    assert "error" in out


def test_unknown_tool_is_an_error_not_an_exception():
    p = DmemoMemoryProvider()
    p._session = object()  # past the not-initialized guard
    out = json.loads(p.handle_tool_call("dmemo_nonexistent", {}))
    assert "Unknown tool" in out["error"]


def test_missing_required_arg_is_reported_to_the_model():
    p = DmemoMemoryProvider()
    p._session = object()
    assert "query" in json.loads(p.handle_tool_call("dmemo_search", {}))["error"]
    assert "content" in json.loads(p.handle_tool_call("dmemo_add", {}))["error"]
    assert "memory_id" in json.loads(p.handle_tool_call("dmemo_delete", {}))["error"]


def test_failed_initialize_leaves_the_provider_inert_not_broken(monkeypatch):
    """A dead chain must degrade to "no memory", never to a crashed agent."""

    def boom(*_a, **_k):
        raise RuntimeError("indexer unreachable")

    monkeypatch.setattr(DmemoSession, "open", staticmethod(boom))
    p = DmemoMemoryProvider()
    p.initialize(session_id="s", hermes_home="/nonexistent", platform="cli")

    assert p._session is None
    assert "indexer unreachable" in p._init_error
    assert p.system_prompt_block() == ""
    assert p.prefetch("anything") == ""
    p.sync_turn("hello", "hi")  # must not raise
    p.on_session_end([])
    p.shutdown()


def test_circuit_breaker_opens_after_five_failures_and_short_circuits():
    p = DmemoMemoryProvider()
    p._session = object()
    for _ in range(5):
        p._record_failure()
    assert p._is_breaker_open()
    assert "temporarily unavailable" in json.loads(
        p.handle_tool_call("dmemo_search", {"query": "x"})
    )["error"]


def test_a_success_resets_the_failure_count():
    p = DmemoMemoryProvider()
    for _ in range(4):
        p._record_failure()
    p._record_success()
    p._record_failure()
    assert not p._is_breaker_open()


def test_non_primary_agent_contexts_never_write(monkeypatch):
    """Cron and subagent prompts are not the user talking."""
    p, session = _live_provider(monkeypatch, agent_context="cron")

    p.sync_turn("user text", "assistant text")
    if p._sync_thread:
        p._sync_thread.join(timeout=5)
    assert session.adds == []
    assert "read-only" in json.loads(p.handle_tool_call("dmemo_add", {"content": "x"}))["error"]


def test_captured_turn_uses_the_same_shape_as_the_typescript_hosts(monkeypatch):
    p, session = _live_provider(monkeypatch)

    p.sync_turn("what is the deploy window?", "Thursdays 02:00 UTC.", session_id="s1")
    p._sync_thread.join(timeout=5)

    text, kwargs = session.adds[0]
    assert text == "User: what is the deploy window?\n\nAssistant: Thursdays 02:00 UTC."
    assert kwargs["metadata"]["session_id"] == "s1"


def test_empty_turns_are_not_stored(monkeypatch):
    p, session = _live_provider(monkeypatch)
    p.sync_turn("", "")
    assert session.adds == []


def test_system_prompt_block_reports_the_restored_chain(monkeypatch):
    p, _ = _live_provider(monkeypatch)
    block = p.system_prompt_block()
    assert "3 memories restored from 1 blob(s)" in block
    assert "0xdeadbeef" in block
    assert "dmemo_search" in block


def test_backup_paths_and_tool_schemas_work_without_initialize():
    """Hermes calls both before any provider is live."""
    p = DmemoMemoryProvider()
    assert p.backup_paths() and p.backup_paths()[0].endswith(".dmemo")
    assert [t["name"] for t in p.get_tool_schemas()] == ["dmemo_search", "dmemo_add", "dmemo_delete"]
    for schema in p.get_tool_schemas():
        assert set(schema) >= {"name", "description", "parameters"}
