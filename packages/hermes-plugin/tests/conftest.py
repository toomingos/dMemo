"""Shared fixtures.

The 0G leg is the one part of the stack a unit test has no business talking
to, so it is replaced here by an in-memory transport implementing the same
``StorageTransport`` protocol. Everything above the seam — codec, journal,
mem0 engine, restore, provider — is the real thing.
"""

from __future__ import annotations

import hashlib
from typing import Dict, List, Optional

import pytest

from dmemo_hermes.config import DmemoConfig
from dmemo_hermes.transport import DownloadResult, ResolvedPointer, UploadResult


class FakeTransport:
    """In-memory stand-in for 0G. Content-addressed, like the real thing."""

    def __init__(self) -> None:
        self.blobs: Dict[str, bytes] = {}
        self.order: List[str] = []
        self.address = "0x00000000000000000000000000000000000000ff"
        self.unretrievable: set = set()
        self.saved_pointers: List[str] = []
        #: Roots the client would have flagged from its own abandoned-upload marker.
        self.orphan_suspects: set = set()

    def upload(self, plaintext: bytes) -> UploadResult:
        root = "0x" + hashlib.sha256(plaintext).hexdigest()
        self.blobs[root] = plaintext
        self.order.append(root)
        return UploadResult(
            tx_hash="0xtx", root_hash=root, tx_seq=len(self.order),
            upload_ms=1.0, cost_wei=0, bytes=len(plaintext),
        )

    def download_and_verify(self, root_hash: str) -> DownloadResult:
        if root_hash in self.unretrievable or root_hash not in self.blobs:
            from dmemo_hermes.transport import BlobUnretrievableError

            raise BlobUnretrievableError(f"no such blob {root_hash}", reason="not-found")
        return DownloadResult(
            plaintext=self.blobs[root_hash], download_ms=1.0, verify_ms=0.1, decrypt_ms=0.1
        )

    def resolve_candidates(self, max_candidates: Optional[int] = None) -> List[ResolvedPointer]:
        # Newest first, mirroring the Submit-log scan order.
        return [
            ResolvedPointer(
                root_hash=r,
                tx_seq=i + 1,
                block_number=i + 1,
                elapsed_ms=0.0,
                orphan_suspect=r in self.orphan_suspects,
            )
            for i, r in reversed(list(enumerate(self.order)))
        ]

    def save_pointer(self, pointer) -> None:
        self.saved_pointers.append(getattr(pointer, "root_hash", pointer))

    def close(self) -> None:
        pass


@pytest.fixture
def transport() -> FakeTransport:
    return FakeTransport()


@pytest.fixture
def config() -> DmemoConfig:
    return DmemoConfig(private_key="0x" + "11" * 32, network="testnet", scope="test")
