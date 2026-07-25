"""The storage seam: everything dMemo needs from 0G, and nothing else.

``StorageTransport`` is the only place the Python provider touches the
chain. The engine above it (mem0, journal, blob codec, session) never learns
whether the bytes went out over a native SDK or a subprocess — which is the
point: a pure-Python 0G client can be dropped in later without touching a
line above this file.

``NodeBridgeTransport`` is the implementation that exists today. It speaks
line-delimited JSON to ``bridge/storage-bridge.mjs``, which delegates to the
same ``@dmemo/core`` ``StorageClient`` the TypeScript hosts run in
production — so uploads are ECIES-encrypted to the wallet's own pubkey and
every download is Merkle self-verified against the on-chain root before
decryption (gotcha 1), with no second implementation of that logic to keep in
sync.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol


class StorageError(Exception):
    """Base for every failure that crossed the storage seam."""


class BlobUnretrievableError(StorageError):
    """The blob could not be fetched — NOT proof that it is gone.

    ``reason`` is ``'transient'`` or ``'unretrievable'``; restore's
    refuse-don't-degrade rule keys off exactly this distinction.
    """

    def __init__(self, message: str, reason: str = "transient") -> None:
        super().__init__(message)
        self.reason = reason


class BlobCorruptError(StorageError):
    """Definitive, deterministic failure on Merkle-valid bytes. Never retry."""


@dataclass
class UploadResult:
    tx_hash: str
    root_hash: str
    tx_seq: int
    upload_ms: float
    cost_wei: int
    bytes: int


@dataclass
class DownloadResult:
    plaintext: bytes
    download_ms: float
    verify_ms: float
    decrypt_ms: float


@dataclass
class ResolvedPointer:
    root_hash: str
    tx_seq: int
    block_number: int
    elapsed_ms: float
    #: This pointer is newer than the last upload this client confirmed, and a
    #: local marker says it abandoned an upload in that block range. The Submit
    #: tx mines before segment data is durable, so an abandoned upload leaves a
    #: paid-for pointer with nothing behind it — permanently. Restore treats an
    #: unreachable one as its own wreckage and walks back, rather than deferring
    #: forever on a blob nobody will ever be able to fetch.
    orphan_suspect: bool = False


class StorageTransport(Protocol):
    """The whole storage contract — four calls."""

    @property
    def address(self) -> str: ...

    def upload(self, plaintext: bytes) -> UploadResult: ...

    def download_and_verify(self, root_hash: str) -> DownloadResult: ...

    def resolve_candidates(self, max_candidates: Optional[int] = None) -> List[ResolvedPointer]: ...

    def save_pointer(self, pointer: ResolvedPointer) -> None: ...

    def close(self) -> None: ...


# Inside the package, so it ships in the wheel. The Node side still needs
# `@dmemo/core` resolvable from here — Node walks up to the package root's
# node_modules, so an `npm install` at the install prefix is the prerequisite.
_BRIDGE_ENTRY = Path(__file__).resolve().parent / "bridge" / "storage-bridge.mjs"


class NodeBridgeTransport:
    """StorageTransport backed by a long-lived Node child running @dmemo/core."""

    def __init__(
        self,
        private_key: str,
        *,
        network: str = "testnet",
        network_overrides: Optional[Dict[str, Any]] = None,
        pointer_cache_path: Optional[str] = None,
        upload_timeout_ms: Optional[int] = None,
        download_timeout_ms: Optional[int] = None,
        bridge_entry: Optional[str] = None,
        node_bin: Optional[str] = None,
        stderr_sink: Optional[Any] = None,
    ) -> None:
        entry = Path(bridge_entry or os.environ.get("DMEMO_BRIDGE_ENTRY") or _BRIDGE_ENTRY)
        if not entry.exists():
            raise StorageError(f"dmemo storage bridge not found at {entry}")
        node = node_bin or os.environ.get("DMEMO_NODE_BIN") or shutil.which("node")
        if not node:
            raise StorageError("node executable not found — the dMemo storage bridge needs Node >= 18 on PATH")

        self._lock = threading.Lock()
        self._next_id = 0
        self._proc = subprocess.Popen(
            [node, str(entry)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr_sink if stderr_sink is not None else subprocess.DEVNULL,
            cwd=str(entry.parent),
            text=True,
            bufsize=1,
        )
        info = self._call(
            "init",
            privateKey=private_key,
            network=network,
            networkOverrides=network_overrides or {},
            pointerCachePath=pointer_cache_path,
            uploadTimeoutMs=upload_timeout_ms,
            downloadTimeoutMs=download_timeout_ms,
        )
        self._address: str = info["address"]
        self.network_info: Dict[str, Any] = info

    # -- protocol ----------------------------------------------------------

    def _call(self, op: str, **kwargs: Any) -> Dict[str, Any]:
        with self._lock:
            if self._proc.poll() is not None:
                raise StorageError(f"storage bridge exited with code {self._proc.returncode}")
            self._next_id += 1
            req = {"id": self._next_id, "op": op, **kwargs}
            assert self._proc.stdin and self._proc.stdout
            self._proc.stdin.write(json.dumps(req) + "\n")
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
            if not line:
                raise StorageError("storage bridge closed its stdout unexpectedly")
            resp = json.loads(line)

        if resp.get("ok"):
            return resp.get("result") or {}
        err = resp.get("error") or {}
        name = err.get("name", "Error")
        message = f"{name}: {err.get('message', 'unknown bridge error')}"
        if name == "BlobUnretrievableError":
            raise BlobUnretrievableError(message, err.get("reason", "transient"))
        if name in ("BlobCorruptError", "BlobDecodeError", "MerkleVerifyError"):
            raise BlobCorruptError(message)
        raise StorageError(message)

    # -- StorageTransport --------------------------------------------------

    @property
    def address(self) -> str:
        return self._address

    def balance_wei(self) -> int:
        return int(self._call("balance")["wei"])

    def upload(self, plaintext: bytes) -> UploadResult:
        import base64

        r = self._call("upload", plaintextB64=base64.b64encode(plaintext).decode("ascii"))
        return UploadResult(
            tx_hash=r["txHash"],
            root_hash=r["rootHash"],
            tx_seq=r["txSeq"],
            upload_ms=r["uploadMs"],
            cost_wei=int(r["costWei"]),
            bytes=r["bytes"],
        )

    def download_and_verify(self, root_hash: str) -> DownloadResult:
        import base64

        r = self._call("download", rootHash=root_hash)
        return DownloadResult(
            plaintext=base64.b64decode(r["plaintextB64"]),
            download_ms=r["downloadMs"],
            verify_ms=r["verifyMs"],
            decrypt_ms=r["decryptMs"],
        )

    def resolve_candidates(self, max_candidates: Optional[int] = None) -> List[ResolvedPointer]:
        r = self._call("candidates", max=max_candidates)
        return [
            ResolvedPointer(
                root_hash=c["rootHash"],
                tx_seq=c["txSeq"],
                block_number=c["blockNumber"],
                elapsed_ms=c.get("elapsedMs", 0.0),
                orphan_suspect=bool(c.get("orphanSuspect", False)),
            )
            for c in r["candidates"]
        ]

    def save_pointer(self, pointer: ResolvedPointer) -> None:
        self._call(
            "savePointer",
            rootHash=pointer.root_hash,
            txSeq=pointer.tx_seq,
            blockNumber=pointer.block_number,
        )

    def close(self) -> None:
        proc = self._proc
        if proc.poll() is not None:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
