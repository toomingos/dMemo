"""Journaling VectorStore wrapper (D7) — Python port of ``store/journal.ts``.

Wraps mem0's native Python ``VectorStoreBase`` instance and:

 1. forwards every call through unchanged, so search/read behaviour is
    identical to un-wrapped mem0;
 2. records every mutating call as a spec ``VectorOp`` for ``flush()`` to
    drain;
 3. keeps a materialized ``{id: (vector, payload)}`` mirror, because mem0's
    stores do not return embedding vectors from ``get()``/``list()``
    (gotcha 16 — FAISS's ``OutputData`` is ``id``/``score``/``payload``
    only), and checkpoint blobs need full rows.

Installed by post-init property swap (``memory.vector_store = Journaling...``),
the same shape as the TypeScript adapter: mem0 has no custom-store
registration hook in either language (gotcha 11).
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .blob import pack_vector, unpack_vector


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


class JournalingVectorStore:
    """Mutation-journaling proxy around a mem0 ``VectorStoreBase``."""

    def __init__(self, native: Any) -> None:
        self._native = native
        self._journal: List[Dict[str, Any]] = []
        self._mirror: Dict[str, Tuple[List[float], Dict[str, Any]]] = {}

    # -- reads / lifecycle: delegate untouched, never journaled -------------

    def search(self, query: str, vectors: Sequence[float], top_k: int = 5, filters: Optional[Dict] = None):
        return self._native.search(query, vectors, top_k, filters)

    def keyword_search(self, query: str, top_k: int = 5, filters: Optional[Dict] = None):
        return self._native.keyword_search(query, top_k, filters)

    def get(self, vector_id: str):
        return self._native.get(vector_id)

    def list(self, filters: Optional[Dict] = None, top_k: Optional[int] = None):
        return self._native.list(filters, top_k)

    def list_cols(self):
        return self._native.list_cols()

    def col_info(self):
        return self._native.col_info()

    def create_col(self, *args: Any, **kwargs: Any):
        # Collection creation is a store-local concern; the blob chain
        # describes rows, not collections.
        return self._native.create_col(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        # Store-specific extras (``_save``, ``client``, ``index`` …) that mem0
        # or a host may reach for. Only consulted for attributes this class
        # does not define, so it can never shadow the journaled methods.
        return getattr(self._native, name)

    # -- mutations: forward to native, then journal + mirror ----------------

    def insert(self, vectors: Sequence[Sequence[float]], payloads: Optional[Sequence[Dict]] = None, ids: Optional[Sequence[str]] = None):
        result = self._native.insert(vectors, payloads, ids)
        ids = list(ids or [])
        payloads = [dict(p) for p in (payloads or [{} for _ in vectors])]
        for i, vector_id in enumerate(ids):
            self._mirror[vector_id] = (list(vectors[i]), payloads[i])
        self._journal.append(
            {
                "op": "insert",
                "ids": ids,
                "vectors": [pack_vector(v) for v in vectors],
                "payloads": payloads,
            }
        )
        return result

    def update(self, vector_id: str, vector: Optional[Sequence[float]] = None, payload: Optional[Dict] = None):
        result = self._native.update(vector_id, vector, payload)
        existing = self._mirror.get(vector_id)
        new_vector = list(vector) if vector is not None else (list(existing[0]) if existing else [])
        new_payload = dict(payload) if payload is not None else (dict(existing[1]) if existing else {})
        self._mirror[vector_id] = (new_vector, new_payload)
        # The spec's update op always carries a vector, so a payload-only
        # mem0 update still replays correctly on a host that never saw the
        # original insert.
        self._journal.append(
            {"op": "update", "id": vector_id, "vector": pack_vector(new_vector), "payload": new_payload}
        )
        return result

    def delete(self, vector_id: str):
        result = self._native.delete(vector_id)
        self._mirror.pop(vector_id, None)
        self._journal.append({"op": "delete", "id": vector_id})
        return result

    def delete_col(self):
        result = self._native.delete_col()
        self._mirror.clear()
        self._journal.append({"op": "deleteCol"})
        return result

    def reset(self):
        # mem0's ``reset()`` is delete-collection-then-recreate; on the wire
        # that is exactly a deleteCol op — recreation carries no rows.
        result = self._native.reset()
        self._mirror.clear()
        self._journal.append({"op": "deleteCol"})
        return result

    # -- dmemo-specific extensions -----------------------------------------

    def journal_tombstone(self, epoch: int, reason: Optional[str] = None) -> None:
        op: Dict[str, Any] = {"op": "tombstone", "epoch": epoch, "tombstonedAt": _utc_now_iso()}
        if reason is not None:
            op["reason"] = reason
        self._journal.append(op)

    def drain_journal(self) -> List[Dict[str, Any]]:
        drained, self._journal = self._journal, []
        return drained

    def has_pending_ops(self) -> bool:
        return len(self._journal) > 0

    def snapshot_rows(self) -> List[Dict[str, Any]]:
        """Full materialized vector rows, for a checkpoint blob."""
        return [
            {"id": vector_id, "vector": pack_vector(vector), "payload": payload}
            for vector_id, (vector, payload) in self._mirror.items()
        ]

    @property
    def row_count(self) -> int:
        return len(self._mirror)

    # -- restore-time replay (must NOT re-journal) --------------------------

    def apply_replay_op(self, op: Dict[str, Any]) -> None:
        kind = op["op"]
        if kind == "insert":
            vectors = [unpack_vector(v) for v in op["vectors"]]
            payloads = [dict(p) for p in op["payloads"]]
            ids = list(op["ids"])
            self._native.insert(vectors, payloads, ids)
            for i, vector_id in enumerate(ids):
                self._mirror[vector_id] = (vectors[i], payloads[i])
        elif kind == "update":
            vector = unpack_vector(op["vector"])
            payload = dict(op["payload"])
            if op["id"] in self._mirror:
                self._native.update(op["id"], vector, payload)
            else:
                # A chain can legitimately update a row this store never saw
                # (e.g. the insert landed in a blob that a re-embed migration
                # replaced). mem0's stores raise on unknown ids, so replay as
                # an insert rather than aborting the whole chain.
                self._native.insert([vector], [payload], [op["id"]])
            self._mirror[op["id"]] = (vector, payload)
        elif kind == "delete":
            if op["id"] in self._mirror:
                self._native.delete(op["id"])
            self._mirror.pop(op["id"], None)
        elif kind == "deleteCol":
            self._native.delete_col()
            self._mirror.clear()
        elif kind == "tombstone":
            return  # durability handled by preserving the op, no store effect
        else:
            raise ValueError(f"unknown VectorOp: {kind!r}")

    def apply_checkpoint_rows(self, rows: Sequence[Dict[str, Any]]) -> None:
        if not rows:
            return
        ids = [r["id"] for r in rows]
        vectors = [unpack_vector(r["vector"]) for r in rows]
        payloads = [dict(r["payload"]) for r in rows]
        self._native.insert(vectors, payloads, ids)
        for i, vector_id in enumerate(ids):
            self._mirror[vector_id] = (vectors[i], payloads[i])
