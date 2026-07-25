"""Session tests — the write/restore loop, with 0G faked out.

These are slow-ish (each opens a real mem0 engine with a real local
embedder) but they are the tests that matter: they cover the thing that
would silently lose a user's memory.
"""

from __future__ import annotations

import pytest

from dmemo_hermes.session import (
    DmemoSession,
    RestoreChainUnavailableError,
    RestoreTemporarilyUnavailableError,
)

FACTS = [
    "The Meridian project uses a hexagonal architecture with the domain core isolated from adapters.",
    "Meridian's deploy window is Thursdays at 02:00 UTC, never on Fridays.",
    "The Meridian on-call rotation is owned by the Atlas team, escalation goes to Priya Raghunathan.",
]


def _write(config, transport, facts=FACTS):
    session = DmemoSession.open(config, transport=transport)
    for fact in facts:
        session.add([{"role": "user", "content": fact}], user_id="tester")
    session.close()
    return session


@pytest.mark.slow
def test_second_session_recalls_what_the_first_wrote(config, transport):
    first = _write(config, transport)
    assert first.dropped_flush_batches == 0
    assert first.flush_log, "expected at least one blob uploaded"

    second = DmemoSession.open(config, transport=transport)
    try:
        assert second.restore_stats.restored
        assert second.restore_stats.vector_rows == len(FACTS)
        hits = second.search("who owns the on-call rotation?", filters={"user_id": "tester"}, top_k=3)
        assert any("Atlas" in (h.get("memory") or "") for h in hits)
    finally:
        second.close()


@pytest.mark.slow
def test_read_only_session_uploads_nothing(config, transport):
    _write(config, transport)
    before = len(transport.order)

    session = DmemoSession.open(config, transport=transport)
    session.search("anything", filters={"user_id": "tester"}, top_k=1)
    session.close()

    assert session.flush_log == []
    assert len(transport.order) == before


@pytest.mark.slow
def test_first_open_on_an_empty_chain_is_not_an_error(config, transport):
    session = DmemoSession.open(config, transport=transport)
    try:
        assert session.restore_stats.restored is False
        assert session.restore_stats.chain_length == 0
    finally:
        session.close()


@pytest.mark.slow
def test_checkpoint_cadence_alternates_with_deltas(config, transport):
    """K=2: every Kth flush is a full checkpoint, the rest are deltas.

    On a fresh chain that means delta, checkpoint, delta — the counter starts
    at zero, so the first write is cheap and the checkpoint lands on the
    second. A session that restores mid-cycle inherits the counter and can
    checkpoint on its very first flush.
    """
    config.checkpoint_every_n_flushes = 2
    session = DmemoSession.open(config, transport=transport)
    for fact in FACTS:
        session.add([{"role": "user", "content": fact}], user_id="tester")
        session.wait_for_pending_flush(timeout=60)
    session.close()

    assert [e.kind for e in session.flush_log] == ["delta", "checkpoint", "delta"]


@pytest.mark.slow
def test_refuses_to_start_empty_when_the_chain_is_unreadable(config, transport):
    """Refuse, don't degrade.

    A pointer exists but its blob cannot be fetched. Returning an empty store
    would look like a fresh install and the next flush would checkpoint over
    the user's real memory — so open() must raise instead.
    """
    _write(config, transport)
    transport.unretrievable = set(transport.blobs)

    with pytest.raises(RestoreChainUnavailableError):
        DmemoSession.open(config, transport=transport)


@pytest.mark.slow
def test_walks_back_past_an_upload_this_client_abandoned(config, transport):
    """Refuse-don't-degrade must not wedge the wallet on our own wreckage.

    0G mines the Submit transaction before segment data is durable, so an
    upload abandoned after that point (app-level timeout, crash) leaves a
    paid-for pointer with nothing behind it — permanently. Observed live:
    four such pointers made every subsequent session refuse to open. The
    local abandoned-upload marker is what tells the two cases apart.
    """
    _write(config, transport)
    good_head = transport.order[-1]

    # Two dead heads, exactly as a timed-out checkpoint leaves them.
    for i in range(2):
        dead = f"0xdead{i}"
        transport.order.append(dead)
        transport.unretrievable.add(dead)
        transport.orphan_suspects.add(dead)

    session = DmemoSession.open(config, transport=transport)
    try:
        assert session.restore_stats.restored
        assert [s["reason"] for s in session.restore_stats.skipped_blobs] == ["orphaned", "orphaned"]
        assert transport.saved_pointers[-1] == good_head
        hits = session.search("Meridian deploy window", filters={"user_id": "tester"}, top_k=3)
        assert any("Thursdays" in (h.get("memory") or "") for h in hits)
    finally:
        session.close()


@pytest.mark.slow
def test_an_unreachable_head_without_the_marker_still_refuses(config, transport):
    """The narrowness of the exception is the whole safety argument."""
    _write(config, transport)
    dead = "0xdead"
    transport.order.append(dead)
    transport.unretrievable.add(dead)  # note: NOT an orphan suspect

    with pytest.raises(RestoreTemporarilyUnavailableError):
        DmemoSession.open(config, transport=transport)
