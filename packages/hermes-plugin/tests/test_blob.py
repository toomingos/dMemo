"""Codec tests.

The blob is the cross-language contract (D16): a Python host and a
TypeScript host have to produce identical bytes for identical input, or the
same wallet ends up with a chain only one of them can read. These tests pin
the properties that make that true — fixed key order, exact float packing,
no incidental whitespace.
"""

from __future__ import annotations

import base64
import json
import struct

import pytest

from dmemo_hermes.blob import (
    SPEC_VERSION,
    BlobDecodeError,
    decode_blob,
    encode_blob,
    history_row,
    history_tuples,
    pack_vector,
    unpack_vector,
)

HISTORY_ROW = {
    "id": "h1",
    "memory_id": "a",
    "old_memory": None,
    "new_memory": "hi",
    "event": "ADD",
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": None,
    "is_deleted": 0,
}

META = {
    "specVersion": SPEC_VERSION,
    "walletAddress": "0xabc",
    "agentScope": "test",
    "seq": 1,
    "prevRootHash": None,
    "embedder": {"provider": "fastembed", "model": "fast-bge-small-en-v1.5", "dim": 3},
    "engine": {"name": "mem0-oss", "version": "2.0.14+python"},
    "createdAt": "2026-01-01T00:00:00.000Z",
}


def test_pack_vector_is_little_endian_float32():
    packed = pack_vector([1.0, -0.5, 0.0])
    assert base64.b64decode(packed) == struct.pack("<3f", 1.0, -0.5, 0.0)


def test_pack_unpack_round_trip_within_float32_precision():
    original = [0.1, -2.75, 3.25e-8, 1e30]
    restored = unpack_vector(pack_vector(original))
    assert len(restored) == len(original)
    for a, b in zip(original, restored):
        assert a == pytest.approx(b, rel=1e-6)


def test_encode_is_compact_json_with_no_incidental_whitespace():
    blob = {"kind": "delta", "meta": META, "vectorOps": [], "historyEntries": []}
    raw = encode_blob(blob)
    assert b", " not in raw and b": " not in raw
    assert json.loads(raw)["kind"] == "delta"


def test_encode_key_order_is_fixed_not_insertion_order():
    """Byte-identity across languages depends on this and nothing else."""
    a = {"kind": "delta", "meta": META, "vectorOps": [], "historyEntries": []}
    b = {"historyEntries": [], "vectorOps": [], "meta": dict(reversed(list(META.items()))), "kind": "delta"}
    assert encode_blob(a) == encode_blob(b)


def test_encode_preserves_unicode_unescaped():
    meta = {**META, "agentScope": "hermes:tomás:ação"}
    raw = encode_blob({"kind": "delta", "meta": meta, "vectorOps": [], "historyEntries": []})
    assert "tomás".encode("utf-8") in raw


def test_round_trip_delta_with_ops_and_history():
    ops = [
        {
            "op": "insert",
            "ids": ["a"],
            "vectors": [pack_vector([1.0, 2.0, 3.0])],
            "payloads": [{"data": "hi"}],
        },
        {"op": "delete", "id": "b"},
    ]
    blob = {
        "kind": "delta",
        "meta": META,
        "vectorOps": ops,
        "historyEntries": history_tuples([HISTORY_ROW]),
    }
    decoded = decode_blob(encode_blob(blob))
    assert decoded["kind"] == "delta"
    assert decoded["meta"]["seq"] == 1
    assert [o["op"] for o in decoded["vectorOps"]] == ["insert", "delete"]
    assert unpack_vector(decoded["vectorOps"][0]["vectors"][0]) == pytest.approx([1.0, 2.0, 3.0])
    assert len(decoded["historyEntries"]) == 1


def test_history_row_is_the_inverse_of_history_tuples():
    """mem0-Python column names in, spec names on the wire, column names back."""
    (_, record), = history_tuples([HISTORY_ROW])
    assert record["previous_value"] is None
    assert record["new_value"] == "hi"
    assert record["action"] == "ADD"
    assert history_row(record) == HISTORY_ROW


def test_decode_rejects_non_json():
    with pytest.raises(BlobDecodeError):
        decode_blob(b"\x00\x01 not json")


def test_decode_rejects_unknown_spec_version():
    blob = {"kind": "delta", "meta": {**META, "specVersion": "dmemo/99"}, "vectorOps": [], "historyEntries": []}
    with pytest.raises(BlobDecodeError):
        decode_blob(encode_blob(blob))
