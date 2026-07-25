"""dMemo for Hermes — private, decentralized agent memory on 0G Storage.

Native Python engine (mem0 OSS in-process, journaling vector store, dmemo/1
blob codec) over a pluggable storage transport. See ``transport.py`` for why
the 0G leg is a seam rather than a second SDK.
"""

from .blob import (
    SPEC_VERSION,
    BlobDecodeError,
    decode_blob,
    encode_blob,
    pack_vector,
    unpack_vector,
)
from .config import DmemoConfig, ConfigNotFoundError, load_config
from .journal import JournalingVectorStore
from .session import (
    DmemoSession,
    FlushLogEntry,
    RestoreChainUnavailableError,
    RestoreStats,
    RestoreTemporarilyUnavailableError,
    apply_restore_chain,
    resolve_restore_chain,
)
from .provider import DmemoMemoryProvider, register
from .transport import (
    BlobCorruptError,
    BlobUnretrievableError,
    NodeBridgeTransport,
    StorageError,
    StorageTransport,
)

__all__ = [
    "SPEC_VERSION",
    "DmemoMemoryProvider",
    "register",
    "BlobCorruptError",
    "BlobDecodeError",
    "BlobUnretrievableError",
    "ConfigNotFoundError",
    "DmemoConfig",
    "DmemoSession",
    "FlushLogEntry",
    "JournalingVectorStore",
    "NodeBridgeTransport",
    "RestoreChainUnavailableError",
    "RestoreStats",
    "RestoreTemporarilyUnavailableError",
    "StorageError",
    "StorageTransport",
    "apply_restore_chain",
    "decode_blob",
    "encode_blob",
    "load_config",
    "pack_vector",
    "resolve_restore_chain",
    "unpack_vector",
]
