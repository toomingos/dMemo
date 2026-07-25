"""dmemo/1 blob codec — Python side of the cross-language contract (D16).

This is a faithful port of ``packages/blob-spec/src/codec.ts`` +
``vector.ts``. The blob format — not a bridge, not an RPC — is what makes a
Python host and a TypeScript host read each other's memory, so the two
encoders must produce *byte-identical* output for equal input:

  * fixed key insertion order in every object (Python 3.7+ dicts preserve
    insertion order, matching JS object literals);
  * ``json.dumps(..., separators=(",", ":"), ensure_ascii=False)`` to match
    ``JSON.stringify`` exactly (no spaces, non-ASCII emitted raw);
  * vectors packed as base64 of little-endian Float32 bytes (gotcha 14), the
    same encoding mem0's own native store uses on disk.

``blob_roundtrip.py`` in ``tests/`` checks the first two against the real
TypeScript encoder rather than against a hand-written expectation.
"""

from __future__ import annotations

import base64
import json
import struct
from typing import Any, Dict, Iterable, List, Sequence, Tuple

SPEC_VERSION = "dmemo/1"
ENGINE_NAME = "mem0-oss"

HistoryEntryTuple = Tuple[str, Dict[str, Any]]


class BlobDecodeError(Exception):
    """Structural mismatch while decoding — always treated as corruption.

    Never coerce past this: AES-CTR carries no auth tag (gotcha 6), so a
    decode failure is one of the few signals that the bytes are not what we
    wrote.
    """

    def __init__(self, message: str) -> None:
        super().__init__(f"dMemo blob decode error: {message}")


# --------------------------------------------------------------------------
# vectors (gotcha 14)
# --------------------------------------------------------------------------


def pack_vector(vector: Sequence[float]) -> str:
    """Pack an embedding into base64-encoded little-endian Float32 bytes."""
    return base64.b64encode(struct.pack("<%df" % len(vector), *vector)).decode("ascii")


def unpack_vector(encoded: str) -> List[float]:
    """Unpack base64 Float32 bytes back into a plain list of floats."""
    raw = base64.b64decode(encoded)
    if len(raw) % 4 != 0:
        raise BlobDecodeError(f"vector byte length {len(raw)} is not a multiple of 4")
    return list(struct.unpack("<%df" % (len(raw) // 4), raw))


# --------------------------------------------------------------------------
# deterministic ordering
# --------------------------------------------------------------------------


def _ordered_meta(meta: Dict[str, Any]) -> Dict[str, Any]:
    embedder = meta["embedder"]
    engine = meta["engine"]
    ordered: Dict[str, Any] = {
        "specVersion": meta["specVersion"],
        "walletAddress": meta["walletAddress"],
        "agentScope": meta["agentScope"],
        "seq": meta["seq"],
        "prevRootHash": meta["prevRootHash"],
        "embedder": {
            "provider": embedder["provider"],
            "model": embedder["model"],
            "dim": embedder["dim"],
        },
        "engine": {"name": engine["name"], "version": engine["version"]},
        "createdAt": meta["createdAt"],
    }
    if meta.get("createdAtChain") is not None:
        ordered["createdAtChain"] = meta["createdAtChain"]
    return ordered


def _ordered_op(op: Dict[str, Any]) -> Dict[str, Any]:
    kind = op.get("op")
    if kind == "insert":
        return {
            "op": "insert",
            "ids": list(op["ids"]),
            "vectors": list(op["vectors"]),
            "payloads": [dict(p) for p in op["payloads"]],
        }
    if kind == "update":
        return {
            "op": "update",
            "id": op["id"],
            "vector": op["vector"],
            "payload": dict(op["payload"]),
        }
    if kind == "delete":
        return {"op": "delete", "id": op["id"]}
    if kind == "deleteCol":
        return {"op": "deleteCol"}
    if kind == "tombstone":
        out: Dict[str, Any] = {
            "op": "tombstone",
            "epoch": op["epoch"],
            "tombstonedAt": op["tombstonedAt"],
        }
        if op.get("reason") is not None:
            out["reason"] = op["reason"]
        return out
    raise BlobDecodeError(f"unknown vectorOp.op: {kind!r}")


def _ordered_history(entries: Iterable[HistoryEntryTuple]) -> List[List[Any]]:
    out: List[List[Any]] = []
    for entry_id, r in entries:
        out.append(
            [
                entry_id,
                {
                    "id": r["id"],
                    "memory_id": r["memory_id"],
                    "previous_value": r["previous_value"],
                    "new_value": r["new_value"],
                    "action": r["action"],
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                    "is_deleted": r["is_deleted"],
                },
            ]
        )
    return out


def encode_blob(blob: Dict[str, Any]) -> bytes:
    """Encode a blob dict into deterministic-key-order UTF-8 JSON bytes."""
    if blob["kind"] == "delta":
        ordered: Dict[str, Any] = {
            "kind": "delta",
            "meta": _ordered_meta(blob["meta"]),
            "vectorOps": [_ordered_op(op) for op in blob["vectorOps"]],
            "historyEntries": _ordered_history(blob["historyEntries"]),
        }
    elif blob["kind"] == "checkpoint":
        ordered = {
            "kind": "checkpoint",
            "meta": _ordered_meta(blob["meta"]),
            "vectors": [
                {"id": v["id"], "vector": v["vector"], "payload": v["payload"]}
                for v in blob["vectors"]
            ],
            "historyEntries": _ordered_history(blob["historyEntries"]),
        }
    else:
        raise BlobDecodeError(f"unknown blob.kind: {blob.get('kind')!r}")
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


# --------------------------------------------------------------------------
# decode + validation (mirrors codec.ts's shallow validation exactly)
# --------------------------------------------------------------------------


def _assert(cond: Any, msg: str) -> None:
    if not cond:
        raise BlobDecodeError(msg)


def _validate_meta(meta: Any) -> None:
    _assert(isinstance(meta, dict), "meta missing or not an object")
    _assert(meta.get("specVersion") == SPEC_VERSION, f"unsupported specVersion: {meta.get('specVersion')}")
    _assert(isinstance(meta.get("walletAddress"), str), "meta.walletAddress must be a string")
    _assert(isinstance(meta.get("agentScope"), str), "meta.agentScope must be a string")
    _assert(isinstance(meta.get("seq"), int) and not isinstance(meta.get("seq"), bool), "meta.seq must be a number")
    _assert(meta.get("prevRootHash") is None or isinstance(meta["prevRootHash"], str), "meta.prevRootHash must be string|null")
    e = meta.get("embedder")
    _assert(isinstance(e, dict), "meta.embedder missing")
    _assert(
        isinstance(e.get("provider"), str) and isinstance(e.get("model"), str) and isinstance(e.get("dim"), int),
        "meta.embedder malformed",
    )
    eng = meta.get("engine")
    _assert(isinstance(eng, dict), "meta.engine missing")
    _assert(eng.get("name") == ENGINE_NAME and isinstance(eng.get("version"), str), "meta.engine malformed")
    _assert(isinstance(meta.get("createdAt"), str), "meta.createdAt must be a string")


def _validate_op(op: Any) -> None:
    _assert(isinstance(op, dict), "vectorOp must be an object")
    kind = op.get("op")
    if kind == "insert":
        _assert(
            isinstance(op.get("ids"), list) and isinstance(op.get("vectors"), list) and isinstance(op.get("payloads"), list),
            "insert op malformed",
        )
    elif kind == "update":
        _assert(isinstance(op.get("id"), str) and isinstance(op.get("vector"), str), "update op malformed")
    elif kind == "delete":
        _assert(isinstance(op.get("id"), str), "delete op malformed")
    elif kind == "deleteCol":
        pass
    elif kind == "tombstone":
        _assert(
            isinstance(op.get("epoch"), int) and isinstance(op.get("tombstonedAt"), str),
            "tombstone op malformed",
        )
    else:
        raise BlobDecodeError(f"unknown vectorOp.op: {kind!r}")


def decode_blob(data: bytes) -> Dict[str, Any]:
    """Decode UTF-8 JSON bytes into a validated blob dict."""
    try:
        parsed = json.loads(data.decode("utf-8"))
    except Exception as e:  # noqa: BLE001 — any parse failure is corruption
        raise BlobDecodeError(f"invalid JSON: {e}") from e

    _assert(isinstance(parsed, dict), "top-level value is not an object")
    _validate_meta(parsed.get("meta"))
    _assert(isinstance(parsed.get("historyEntries"), list), "historyEntries must be an array")

    kind = parsed.get("kind")
    if kind == "delta":
        _assert(isinstance(parsed.get("vectorOps"), list), "delta.vectorOps must be an array")
        for op in parsed["vectorOps"]:
            _validate_op(op)
        return parsed
    if kind == "checkpoint":
        _assert(isinstance(parsed.get("vectors"), list), "checkpoint.vectors must be an array")
        for row in parsed["vectors"]:
            _assert(isinstance(row, dict), "checkpoint vector row must be an object")
            _assert(
                isinstance(row.get("id"), str)
                and isinstance(row.get("vector"), str)
                and isinstance(row.get("payload"), dict),
                "checkpoint vector row malformed",
            )
        return parsed
    raise BlobDecodeError(f"unknown blob.kind: {kind!r}")


def history_tuples(rows: Iterable[Dict[str, Any]]) -> List[HistoryEntryTuple]:
    """Map mem0-Python history rows onto spec history records.

    mem0's Python ``history`` table and the TypeScript in-RAM history map use
    different field names for the same three columns. The spec names win —
    that is the whole point of having a spec.
    """
    out: List[HistoryEntryTuple] = []
    for row in rows:
        out.append(
            (
                row["id"],
                {
                    "id": row["id"],
                    "memory_id": row["memory_id"],
                    "previous_value": row["old_memory"],
                    "new_value": row["new_memory"],
                    "action": row["event"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                    "is_deleted": row["is_deleted"],
                },
            )
        )
    return out


def history_row(record: Dict[str, Any]) -> Dict[str, Any]:
    """Inverse of :func:`history_tuples` — spec record back to a table row."""
    return {
        "id": record["id"],
        "memory_id": record["memory_id"],
        "old_memory": record["previous_value"],
        "new_memory": record["new_value"],
        "event": record["action"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
        "is_deleted": record["is_deleted"],
    }
