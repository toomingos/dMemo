"""Local embedder selection + identity (D6), matching ``core/embedder.ts``.

Selection order is the same on both runtimes — explicit config, then a
running Ollama, then FastEmbed — because the *embedder identity* recorded in
every blob's envelope is what decides whether a restored chain has to be
re-embedded. Two hosts that pick different embedders for the same wallet
would re-embed each other's memories on every switch.

One deliberate translation lives here: fastembed-js calls the model
``fast-bge-small-en-v1.5`` and fastembed-python calls the identical ONNX
export ``BAAI/bge-small-en-v1.5``. Same weights, same 384-dim space — so the
identity written to the blob uses the TypeScript spelling on both sides.
The identity denotes an embedding space, not an SDK's string table.
"""

from __future__ import annotations

import logging
import os
import urllib.request
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

OLLAMA_HOST = os.environ.get("OLLAMA_HOST") or "http://localhost:11434"
OLLAMA_MODEL = "nomic-embed-text"

# fastembed-python model id -> the canonical identity spelling shared with
# the TypeScript SDK.
FASTEMBED_MODEL_PY = "BAAI/bge-small-en-v1.5"
FASTEMBED_MODEL_ID = "fast-bge-small-en-v1.5"
_CANONICAL_MODEL_NAMES = {FASTEMBED_MODEL_PY: FASTEMBED_MODEL_ID}


def _ollama_reachable(timeout: float = 0.4) -> bool:
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def _ollama_importable() -> bool:
    # mem0's Ollama embedder prompts on stdin ("install it now? [y/N]") when
    # the client library is missing — inside a Hermes plugin that would hang
    # the agent, so it is only ever selected when the import already works.
    try:
        import ollama  # noqa: F401

        return True
    except Exception:
        return False


def resolve_embedder_config(
    provider: Optional[str] = None, model: Optional[str] = None
) -> Tuple[Dict[str, Any], str, str]:
    """Return ``(mem0_embedder_block, provider, canonical_model)``."""
    if provider:
        return (
            {"provider": provider, "config": {"model": model} if model else {}},
            provider,
            _CANONICAL_MODEL_NAMES.get(model or "", model or ""),
        )

    if _ollama_reachable() and _ollama_importable():
        return (
            {"provider": "ollama", "config": {"model": OLLAMA_MODEL, "ollama_base_url": OLLAMA_HOST}},
            "ollama",
            OLLAMA_MODEL,
        )

    if _ollama_reachable():
        logger.warning(
            "[dmemo] Ollama is reachable at %s but the `ollama` python package is not installed — "
            "falling back to fastembed. A TypeScript dMemo host on this wallet would pick Ollama, "
            "so switching hosts will trigger a one-time re-embed.",
            OLLAMA_HOST,
        )

    return (
        {"provider": "fastembed", "config": {"model": FASTEMBED_MODEL_PY}},
        "fastembed",
        FASTEMBED_MODEL_ID,
    )


def embedder_identity(memory: Any, provider: str, model: str) -> Dict[str, Any]:
    """Probe the live embedder for its true dimension (never assume it)."""
    probe = memory.embedding_model.embed("dmemo dimension probe")
    return {"provider": provider, "model": model, "dim": len(probe)}


def identity_equals(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return a["provider"] == b["provider"] and a["model"] == b["model"] and a["dim"] == b["dim"]
