"""Session lifecycle: restore a wallet's chain, journal writes, flush blobs.

Python port of ``core/session.ts``. The rules that matter are the ones that
decide whether memory survives, and they are ported verbatim rather than
reinterpreted:

  * walk ``prevRootHash`` back from the newest Submit-log candidate until a
    checkpoint or the chain root, and discard a candidate entirely if any
    blob in its ancestry fails — a delta means nothing without the exact
    state it was diffed against;
  * refuse-don't-degrade: if a NEWER candidate was abandoned for a reason
    that is not confirmed corruption, do not open onto an older one. Opening
    would cache the older pointer and orphan a head that was probably just
    temporarily unreachable. Refusing is recoverable; degrading is not;
  * on replay failure, truncate to the last blob that applied cleanly and
    report it — never silently return an empty store, which is
    indistinguishable from "this wallet has no memories";
  * flush is fire-and-forget and fails open (retry once, then drop the
    batch and count it) — memory must never break the host.
"""

from __future__ import annotations

import logging
import math
import os
import queue
import shutil
import sqlite3
import tempfile
import threading
import time
import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import blob as blobmod
from .blob import SPEC_VERSION, decode_blob, encode_blob, history_row, history_tuples
from .config import DmemoConfig
from .embedder import embedder_identity, identity_equals, resolve_embedder_config
from .journal import JournalingVectorStore
from .transport import (
    BlobCorruptError,
    DownloadResult,
    NodeBridgeTransport,
    ResolvedPointer,
    StorageTransport,
    BlobUnretrievableError,
)

logger = logging.getLogger("dmemo")


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        return f"{version('mem0ai')}+python"
    except Exception:
        return "unknown+python"


class RestoreChainUnavailableError(Exception):
    """No candidate produced a complete, restorable chain."""

    def __init__(self, candidates: Sequence[ResolvedPointer], skipped: List[Dict[str, str]]) -> None:
        any_corrupt = any(s["reason"] == "corrupt" for s in skipped)
        verdict = (
            "at least one blob is confirmed corrupt/unreplayable — this chain segment is unrecoverable"
            if any_corrupt
            else "every failure looks transient/unretrievable — this may be temporary; retry before assuming data loss"
        )
        rng = f"txSeq {candidates[-1].tx_seq}..{candidates[0].tx_seq}" if candidates else "(no candidates)"
        super().__init__(
            f"dmemo restore failed: none of the {len(candidates)} most recent on-chain pointers ({rng}) "
            f"produced a complete, restorable chain ({len(skipped)} blob(s) skipped — {verdict})"
        )
        self.skipped = skipped


class RestoreTemporarilyUnavailableError(Exception):
    """A newer, probably-intact head was unreachable — refuse rather than orphan it."""

    def __init__(self, candidates: Sequence[ResolvedPointer], skipped: List[Dict[str, str]]) -> None:
        rng = f"txSeq {candidates[-1].tx_seq}..{candidates[0].tx_seq}" if candidates else "(no candidates)"
        super().__init__(
            f"dmemo restore deferred: the newest blob(s) in this wallet's chain ({rng}) are temporarily "
            f"unreachable (NOT confirmed corrupt) while an older blob resolved cleanly. Refusing to open onto "
            f"that older blob rather than permanently orphaning the current head — your memory is intact; "
            f"retry later ({len(skipped)} blob(s) currently unreachable)."
        )
        self.skipped = skipped


@dataclass
class ChainEntry:
    root_hash: str
    blob: Dict[str, Any]


@dataclass
class RestoreStats:
    restored: bool = False
    chain_length: int = 0
    pointer_resolve_ms: float = 0.0
    download_ms: float = 0.0
    verify_ms: float = 0.0
    decrypt_ms: float = 0.0
    replay_ms: float = 0.0
    total_ms: float = 0.0
    reembed_migrated: bool = False
    dangling_pointers_skipped: int = 0
    skipped_blobs: List[Dict[str, str]] = field(default_factory=list)
    vector_rows: int = 0
    history_rows: int = 0


@dataclass
class FlushLogEntry:
    kind: str
    root_hash: str
    seq: int
    upload_ms: float
    cost_wei: int
    bytes: int
    vector_ops: int
    history_entries: int


#: Mirrors UPLOAD_TIMEOUT_MS_PER_KB in core/src/storage/client.ts — the Node
#: bridge scales its own upload budget the same way, and a close deadline that
#: does not track it will tear down a live upload.
_UPLOAD_TIMEOUT_SECS_PER_KB = 0.6
#: Slack for encode + cost accounting + pointer save after the upload returns.
_CLOSE_GRACE_SECS = 30.0


def _classify(e: Exception) -> str:
    if isinstance(e, (BlobCorruptError, blobmod.BlobDecodeError)):
        return "corrupt"
    if isinstance(e, BlobUnretrievableError):
        return e.reason
    # Never invent a 'corrupt' verdict we cannot back up: an unclassified
    # throw biases to 'transient', which makes restore refuse rather than
    # mistake a bug for confirmed data loss.
    return "transient"


def resolve_restore_chain(
    candidates: Sequence[ResolvedPointer],
    download_and_verify: Callable[[str], DownloadResult],
) -> Dict[str, Any]:
    """Pure chain walk-back. Injectable download so it is testable offline."""
    skipped: List[Dict[str, str]] = []
    download_ms = verify_ms = decrypt_ms = decode_ms = 0.0

    for candidate in candidates:
        attempt: List[ChainEntry] = []
        cursor: Optional[str] = candidate.root_hash
        ok = True

        while cursor:
            try:
                dl = download_and_verify(cursor)
            except Exception as e:  # noqa: BLE001 — classified, then walked back
                reason = _classify(e)
                # Only the candidate's own head can be our abandoned upload:
                # the marker records one unconfirmed submission and nothing was
                # ever chained onto it, so an unreachable ancestor is a real
                # outage and must still defer.
                if reason != "corrupt" and candidate.orphan_suspect and cursor == candidate.root_hash:
                    reason = "orphaned"
                skipped.append({"rootHash": cursor, "reason": reason, "detail": str(e)})
                ok = False
                break
            download_ms += dl.download_ms
            verify_ms += dl.verify_ms
            decrypt_ms += dl.decrypt_ms

            t0 = time.perf_counter()
            try:
                decoded = decode_blob(dl.plaintext)
            except Exception as e:  # noqa: BLE001
                decode_ms += (time.perf_counter() - t0) * 1000
                skipped.append({"rootHash": cursor, "reason": "corrupt", "detail": str(e)})
                ok = False
                break
            decode_ms += (time.perf_counter() - t0) * 1000

            attempt.append(ChainEntry(root_hash=cursor, blob=decoded))
            if decoded["kind"] == "checkpoint":
                break
            cursor = decoded["meta"]["prevRootHash"]

        if ok:
            if any(s["reason"] not in ("corrupt", "orphaned") for s in skipped):
                raise RestoreTemporarilyUnavailableError(candidates, skipped)
            return {
                "pointer": candidate,
                "chain": attempt,
                "skipped": skipped,
                "downloadMs": download_ms,
                "verifyMs": verify_ms,
                "decryptMs": decrypt_ms,
                "decodeMs": decode_ms,
            }

    raise RestoreChainUnavailableError(candidates, skipped)


def apply_restore_chain(
    chain_oldest_first: Sequence[ChainEntry],
    apply_checkpoint: Callable[[List[Dict[str, Any]]], None],
    apply_op: Callable[[Dict[str, Any]], None],
) -> Dict[str, Any]:
    """Replay an oldest-first chain, truncating at the first unreplayable blob."""
    history: Dict[str, Dict[str, Any]] = {}
    skipped: List[Dict[str, str]] = []
    last_good: Optional[ChainEntry] = None
    applied = 0

    for entry in chain_oldest_first:
        try:
            if entry.blob["kind"] == "checkpoint":
                apply_checkpoint(entry.blob["vectors"])
            else:
                for op in entry.blob["vectorOps"]:
                    apply_op(op)
        except Exception as e:  # noqa: BLE001
            skipped.append({"rootHash": entry.root_hash, "reason": "corrupt", "detail": f"unreplayable: {e}"})
            break
        for entry_id, record in entry.blob["historyEntries"]:
            history[entry_id] = record
        last_good = entry
        applied += 1

    return {"lastGood": last_good, "appliedCount": applied, "history": history, "skipped": skipped}


class DmemoSession:
    """An open mem0 engine wired to one wallet's on-chain memory chain."""

    def __init__(
        self,
        *,
        memory: Any,
        journal: JournalingVectorStore,
        transport: StorageTransport,
        config: DmemoConfig,
        scope: str,
        workdir: str,
        history_db_path: str,
        embedder_id: Dict[str, Any],
        seq: int,
        prev_root_hash: Optional[str],
        deltas_since_checkpoint: int,
        history_flushed_count: int,
        restore_stats: RestoreStats,
        observer: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    ) -> None:
        self.memory = memory
        self.journal = journal
        self.transport = transport
        self.config = config
        self.scope = scope
        self.restore_stats = restore_stats
        self.flush_log: List[FlushLogEntry] = []
        self.dropped_flush_batches = 0

        self._workdir = workdir
        self._history_db_path = history_db_path
        self._embedder_id = embedder_id
        self._seq = seq
        self._prev_root_hash = prev_root_hash
        self._deltas_since_checkpoint = deltas_since_checkpoint
        self._history_flushed_count = history_flushed_count
        self._observe = observer or (lambda event, data: None)

        self._closed = False
        # Teardown released the mem0 SQLite handle and the storage transport.
        # A flush that is still running past that point must not rebuild its
        # blob (the history read would hit a closed database) or retry into a
        # dead bridge — it has already lost, and saying so plainly beats a
        # confusing second failure.
        self._torn_down = False
        #: Size of the blob currently being uploaded — sets the close budget.
        self._inflight_bytes = 0
        # `close()` runs a final flush on the calling thread while the worker
        # may still be inside one. Without this they interleave: two threads
        # draining the same journal, bumping the same seq, chaining onto each
        # other's prevRootHash.
        self._flush_lock = threading.Lock()
        self._flush_queue: "queue.Queue[Optional[threading.Event]]" = queue.Queue()
        self._flush_thread = threading.Thread(target=self._flush_worker, name="dmemo-flush", daemon=True)
        self._flush_thread.start()

    # -- open ---------------------------------------------------------------

    @staticmethod
    def open(
        config: DmemoConfig,
        *,
        scope: Optional[str] = None,
        transport: Optional[StorageTransport] = None,
        observer: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        bridge_stderr: Optional[Any] = None,
    ) -> "DmemoSession":
        observe = observer or (lambda event, data: None)
        t_open = time.perf_counter()

        # mem0 reads MEM0_TELEMETRY at import time (gotcha 13) — set it before
        # the import below, not after.
        os.environ["MEM0_TELEMETRY"] = "false"
        os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
        from mem0 import Memory

        scope = scope or config.scope
        owned_transport = transport is None
        if transport is None:
            transport = NodeBridgeTransport(
                config.private_key,
                network=config.network,
                network_overrides=config.network_overrides,
                pointer_cache_path=config.pointer_cache_path,
                upload_timeout_ms=config.upload_timeout_ms,
                download_timeout_ms=config.download_timeout_ms,
                stderr_sink=bridge_stderr,
            )
        observe("transport.ready", {"address": transport.address, "network": config.network})

        embedder_block, provider, model = resolve_embedder_config(
            config.embedder_provider, config.embedder_model
        )

        workdir = tempfile.mkdtemp(prefix=f"dmemo-{transport.address[2:10]}-")
        history_db_path = os.path.join(workdir, "history.db")

        memory = Memory.from_config(
            {
                "vector_store": {
                    "provider": "faiss",
                    "config": {
                        "collection_name": "memories",
                        "path": os.path.join(workdir, "vectors-probe"),
                        "distance_strategy": "cosine",
                    },
                },
                "embedder": embedder_block,
                # Never called: dMemo always passes infer=False, so no turn
                # text is ever sent to an LLM. The block exists only because
                # mem0 validates the slot eagerly at construction.
                "llm": {
                    "provider": "openai",
                    "config": {"api_key": "unused-dmemo-infer-false", "model": "gpt-5-mini"},
                },
                "history_db_path": history_db_path,
                "version": "v1.1",
            }
        )

        # The store's index has a fixed width, and mem0 defaults it to 1536 —
        # so the real dimension has to come from the live embedder, and the
        # store has to be built after it. Probing beats a model->dims table:
        # a table is a second source of truth that silently goes stale.
        embedder_id = embedder_identity(memory, provider, model)
        observe("embedder.resolved", dict(embedder_id))

        from mem0.utils.factory import VectorStoreFactory

        native = VectorStoreFactory.create(
            "faiss",
            {
                "collection_name": "memories",
                "path": os.path.join(workdir, "vectors"),
                "distance_strategy": "cosine",
                "embedding_model_dims": embedder_id["dim"],
            },
        )
        journal = JournalingVectorStore(native)
        # Post-init property swap (gotcha 11): mem0 has no custom-store
        # registration hook, in either language.
        memory.vector_store = journal

        stats = RestoreStats()
        seq = 0
        prev_root_hash: Optional[str] = None
        deltas_since_checkpoint = 0
        history_flushed_count = 0

        t0 = time.perf_counter()
        candidates = transport.resolve_candidates()
        stats.pointer_resolve_ms = (time.perf_counter() - t0) * 1000
        observe(
            "pointers.resolved",
            {
                "count": len(candidates),
                "ms": round(stats.pointer_resolve_ms, 1),
                "head": candidates[0].root_hash if candidates else None,
                "headTxSeq": candidates[0].tx_seq if candidates else None,
            },
        )

        pointer: Optional[ResolvedPointer] = None
        chain: List[ChainEntry] = []
        replay_ms = 0.0

        if candidates:
            def _download(root_hash: str) -> DownloadResult:
                dl = transport.download_and_verify(root_hash)
                observe(
                    "blob.downloaded",
                    {
                        "rootHash": root_hash,
                        "bytes": len(dl.plaintext),
                        "downloadMs": round(dl.download_ms, 1),
                        "verifyMs": round(dl.verify_ms, 1),
                        "decryptMs": round(dl.decrypt_ms, 1),
                    },
                )
                return dl

            result = resolve_restore_chain(candidates, _download)
            pointer = result["pointer"]
            chain = result["chain"]
            stats.download_ms += result["downloadMs"]
            stats.verify_ms += result["verifyMs"]
            stats.decrypt_ms += result["decryptMs"]
            replay_ms += result["decodeMs"]
            stats.skipped_blobs.extend(result["skipped"])
            stats.dangling_pointers_skipped += len(result["skipped"])
            for s in result["skipped"]:
                logger.warning("[dmemo] blob %s skipped during restore (%s): %s; walking back", s["rootHash"], s["reason"], s["detail"])

        if pointer is not None:
            chain.reverse()  # oldest -> newest
            observe(
                "chain.resolved",
                {
                    "length": len(chain),
                    "blobs": [
                        {"seq": c.blob["meta"]["seq"], "kind": c.blob["kind"], "rootHash": c.root_hash}
                        for c in chain
                    ],
                },
            )

            t_apply = time.perf_counter()
            applied = apply_restore_chain(chain, journal.apply_checkpoint_rows, journal.apply_replay_op)
            stats.skipped_blobs.extend(applied["skipped"])
            stats.dangling_pointers_skipped += len(applied["skipped"])
            for s in applied["skipped"]:
                logger.error(
                    "[dmemo] blob %s decoded but failed to replay (%s); restoring only the %d older blob(s) applied so far",
                    s["rootHash"], s["detail"], applied["appliedCount"],
                )

            last_good: Optional[ChainEntry] = applied["lastGood"]
            if last_good is None:
                raise RestoreChainUnavailableError(candidates, stats.skipped_blobs)

            _restore_history(history_db_path, applied["history"])
            replay_ms += (time.perf_counter() - t_apply) * 1000

            seq = last_good.blob["meta"]["seq"] + 1
            prev_root_hash = last_good.root_hash
            history_flushed_count = len(applied["history"])
            deltas_since_checkpoint = (
                applied["appliedCount"] - 1 if chain[0].blob["kind"] == "checkpoint" else applied["appliedCount"]
            )

            if applied["appliedCount"] == len(chain):
                transport.save_pointer(pointer)

            stats.replay_ms = replay_ms
            stats.restored = True
            stats.chain_length = applied["appliedCount"]
            stats.vector_rows = journal.row_count
            stats.history_rows = history_flushed_count
            stats.total_ms = (
                stats.pointer_resolve_ms + stats.download_ms + stats.verify_ms + stats.decrypt_ms + stats.replay_ms
            )

            restored_identity = last_good.blob["meta"]["embedder"]
            if not identity_equals(embedder_id, restored_identity):
                observe("embedder.mismatch", {"restored": restored_identity, "current": embedder_id})
                _reembed_migration(memory, journal, embedder_id)
                stats.reembed_migrated = True
        else:
            stats.total_ms = stats.pointer_resolve_ms

        observe(
            "session.open",
            {
                "restored": stats.restored,
                "chainLength": stats.chain_length,
                "vectorRows": stats.vector_rows,
                "historyRows": stats.history_rows,
                "reembedMigrated": stats.reembed_migrated,
                "skipped": stats.skipped_blobs,
                "totalMs": round((time.perf_counter() - t_open) * 1000, 1),
            },
        )

        session = DmemoSession(
            memory=memory,
            journal=journal,
            transport=transport,
            config=config,
            scope=scope,
            workdir=workdir,
            history_db_path=history_db_path,
            embedder_id=embedder_id,
            seq=seq,
            prev_root_hash=prev_root_hash,
            deltas_since_checkpoint=deltas_since_checkpoint,
            history_flushed_count=history_flushed_count,
            restore_stats=stats,
            observer=observer,
        )
        session._owns_transport = owned_transport
        return session

    _owns_transport = True

    # -- engine passthrough --------------------------------------------------

    def add(self, messages: Any, *, user_id: str, agent_id: Optional[str] = None, metadata: Optional[Dict] = None) -> Any:
        kwargs: Dict[str, Any] = {"user_id": user_id, "infer": self.config.infer}
        if agent_id:
            kwargs["agent_id"] = agent_id
        if metadata:
            kwargs["metadata"] = metadata
        result = self.memory.add(messages, **kwargs)
        self.flush()
        return result

    def search(self, query: str, *, filters: Dict[str, Any], top_k: int = 10) -> List[Dict[str, Any]]:
        response = self.memory.search(query, filters=filters, top_k=top_k)
        if isinstance(response, dict):
            return response.get("results", [])
        return response or []

    # -- flush ---------------------------------------------------------------

    def flush(self) -> None:
        """Fire-and-forget (D4): never blocks the caller, never raises."""
        if self._closed:
            return
        self._flush_queue.put(None)

    def _queue_drain_marker(self) -> threading.Event:
        """Queue a marker behind everything pending; it sets once the worker
        reaches it, i.e. once every earlier flush has finished."""
        done = threading.Event()
        self._flush_queue.put(done)
        return done

    def wait_for_pending_flush(self, timeout: Optional[float] = None) -> None:
        self._queue_drain_marker().wait(timeout)

    def _close_budget_secs(self) -> float:
        """How long teardown should wait for a flush that is already uploading.

        Must track the *upload* budget, not a fixed number: a checkpoint is
        orders of magnitude larger than a delta, and a close deadline shorter
        than the upload it is waiting on tears the transport out from under a
        live upload — losing a flush that was seconds from succeeding.
        """
        kb = math.ceil(self._inflight_bytes / 1024)
        return self.config.upload_timeout_ms / 1000 + kb * _UPLOAD_TIMEOUT_SECS_PER_KB + _CLOSE_GRACE_SECS

    def close(self, timeout: Optional[float] = None) -> None:
        if self._closed:
            return
        # Poll rather than compute the deadline once: the flush thread publishes
        # `_inflight_bytes` only after it has encoded the blob, so a close that
        # lands in the window between "flush started" and "size known" would
        # budget for a zero-byte upload and then tear down a half-megabyte
        # checkpoint mid-flight. Recomputing each tick lets the real size raise
        # the deadline as soon as it exists.
        done = self._queue_drain_marker()
        started = time.monotonic()
        budget = self._close_budget_secs() if timeout is None else timeout
        while not done.wait(1.0):
            budget = self._close_budget_secs() if timeout is None else timeout
            if time.monotonic() - started >= budget:
                break
        self._closed = True
        # Only flush on this thread once the worker is definitely idle —
        # otherwise both drain the same journal concurrently. If the worker is
        # still uploading past the whole budget, skip: there is nothing left
        # this thread can usefully do except get out of the way.
        acquired = self._flush_lock.acquire(timeout=1.0)
        if acquired:
            try:
                self._run_flush_locked()
            finally:
                self._flush_lock.release()
        else:
            logger.warning("[dmemo] flush still running after %.0fs — skipping the final flush", budget)
        self._flush_queue.put(None)  # wake the worker so it can see _closed
        # Set BEFORE releasing the resources a running flush is holding, so it
        # sees "torn down" rather than a closed-database error from its retry.
        self._torn_down = True
        try:
            self.memory.db.connection.close()
        except Exception:
            pass
        if self._owns_transport:
            try:
                self.transport.close()
            except Exception:
                pass
        shutil.rmtree(self._workdir, ignore_errors=True)
        self._observe(
            "session.close",
            {
                "flushes": len(self.flush_log),
                "droppedBatches": self.dropped_flush_batches,
                "totalBytes": sum(f.bytes for f in self.flush_log),
                "totalCostWei": str(sum(f.cost_wei for f in self.flush_log)),
            },
        )

    def _flush_worker(self) -> None:
        while True:
            item = self._flush_queue.get()
            try:
                if self._closed and item is None:
                    return
                self._run_flush()
            except Exception as e:  # noqa: BLE001 — the worker must never die
                logger.error("[dmemo] flush worker error: %s", e)
            finally:
                if item is not None:
                    item.set()
                self._flush_queue.task_done()

    def _run_flush(self) -> None:
        with self._flush_lock:
            self._run_flush_locked()

    def _run_flush_locked(self) -> None:
        if self._torn_down:
            return
        vector_ops = self.journal.drain_journal()
        history_entries = self._drain_new_history()
        if not vector_ops and not history_entries:
            return
        try:
            self._upload_flush_blob(vector_ops, history_entries)
        except Exception as e1:  # noqa: BLE001
            if self._torn_down:
                # Teardown killed this upload; a retry would only rebuild the
                # blob against a closed database and report that instead.
                self.dropped_flush_batches += 1
                self._observe(
                    "flush.dropped",
                    {"vectorOps": len(vector_ops), "historyEntries": len(history_entries), "error": f"torn down mid-flush: {e1}"},
                )
                return
            logger.warning("[dmemo] flush upload failed, retrying once: %s", e1)
            try:
                self._upload_flush_blob(vector_ops, history_entries)
            except Exception as e2:  # noqa: BLE001 — fail open, never break the host
                self.dropped_flush_batches += 1
                logger.error(
                    "[dmemo] flush failed twice — dropping this batch (fail-open, %d vector ops / "
                    "%d history entries not persisted remotely this round): %s",
                    len(vector_ops), len(history_entries), e2,
                )
                self._observe("flush.dropped", {"vectorOps": len(vector_ops), "historyEntries": len(history_entries), "error": str(e2)})

    # -- blob construction ---------------------------------------------------

    def _history_rows(self) -> List[Dict[str, Any]]:
        conn = self.memory.db.connection
        cur = conn.execute(
            "SELECT id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted "
            "FROM history ORDER BY rowid"
        )
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def _drain_new_history(self) -> List[Tuple[str, Dict[str, Any]]]:
        rows = self._history_rows()
        fresh = rows[self._history_flushed_count :]
        # Drained eagerly, symmetric with the journal: a double-failed flush
        # drops the batch rather than resending it forever.
        self._history_flushed_count = len(rows)
        return history_tuples(fresh)

    def _build_meta(self) -> Dict[str, Any]:
        return {
            "specVersion": SPEC_VERSION,
            "walletAddress": self.transport.address,
            "agentScope": self.scope,
            "seq": self._seq,
            "prevRootHash": self._prev_root_hash,
            "embedder": self._embedder_id,
            "engine": {"name": "mem0-oss", "version": _engine_version()},
            "createdAt": _now_iso(),
        }

    def _build_checkpoint(self, meta: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "kind": "checkpoint",
            "meta": meta,
            "vectors": self.journal.snapshot_rows(),
            "historyEntries": history_tuples(self._history_rows()),
        }

    def _upload_flush_blob(self, vector_ops: List[Dict[str, Any]], history_entries: List[Tuple[str, Dict[str, Any]]]) -> None:
        candidate_delta_count = self._deltas_since_checkpoint + 1
        force_checkpoint = candidate_delta_count >= self.config.checkpoint_every_n_flushes

        meta = self._build_meta()
        if force_checkpoint:
            blob = self._build_checkpoint(meta)
        else:
            delta = {"kind": "delta", "meta": meta, "vectorOps": vector_ops, "historyEntries": history_entries}
            encoded = encode_blob(delta)
            blob = self._build_checkpoint(meta) if len(encoded) > self.config.checkpoint_size_threshold_bytes else delta

        plaintext = encode_blob(blob)
        self._inflight_bytes = len(plaintext)
        self._observe(
            "flush.upload.start",
            {"kind": blob["kind"], "seq": meta["seq"], "bytes": len(plaintext), "vectorOps": len(vector_ops), "historyEntries": len(history_entries)},
        )
        upload = self.transport.upload(plaintext)

        self._seq += 1
        self._prev_root_hash = upload.root_hash
        self._deltas_since_checkpoint = 0 if blob["kind"] == "checkpoint" else candidate_delta_count
        entry = FlushLogEntry(
            kind=blob["kind"],
            root_hash=upload.root_hash,
            seq=meta["seq"],
            upload_ms=upload.upload_ms,
            cost_wei=upload.cost_wei,
            bytes=len(plaintext),
            vector_ops=len(vector_ops),
            history_entries=len(history_entries),
        )
        self.flush_log.append(entry)
        self._observe(
            "flush.upload.done",
            {
                "kind": entry.kind,
                "seq": entry.seq,
                "rootHash": entry.root_hash,
                "txHash": upload.tx_hash,
                "txSeq": upload.tx_seq,
                "bytes": entry.bytes,
                "uploadMs": round(entry.upload_ms, 1),
                "costWei": str(entry.cost_wei),
            },
        )


def _restore_history(history_db_path: str, history: Dict[str, Dict[str, Any]]) -> None:
    """Write a restored chain's history records into mem0's own table.

    Ids are preserved so the next flush's ``drain`` sees exactly the rows the
    chain already carries and does not re-upload them.
    """
    if not history:
        return
    conn = sqlite3.connect(history_db_path)
    try:
        conn.executemany(
            "INSERT OR IGNORE INTO history (id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted) "
            "VALUES (:id, :memory_id, :old_memory, :new_memory, :event, :created_at, :updated_at, :is_deleted)",
            [history_row(rec) for rec in history.values()],
        )
        conn.commit()
    finally:
        conn.close()


def _reembed_migration(memory: Any, journal: JournalingVectorStore, new_identity: Dict[str, Any]) -> None:
    """Re-embed restored memories when the chain's embedder is not ours.

    Journaled as ``update`` ops so the fix is durable on the next flush, not
    just patched in RAM for this session.
    """
    rows = journal.snapshot_rows()
    if not rows:
        return
    logger.warning(
        "[dmemo] embedder identity mismatch at restore — re-embedding %d memories with %s/%s (dim %s)",
        len(rows), new_identity["provider"], new_identity["model"], new_identity["dim"],
    )
    for row in rows:
        text = row["payload"].get("data")
        if not isinstance(text, str) or not text:
            continue
        journal.update(row["id"], memory.embedding_model.embed(text), row["payload"])
