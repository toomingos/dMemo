"""Hermes plugin entry point for dMemo.

Thin on purpose: everything real lives in the ``dmemo_hermes`` package so the
engine is testable without a Hermes process. This file only bridges Hermes's
plugin protocol to it.
"""

from __future__ import annotations

import os
import sys


def _ensure_importable() -> None:
    """Allow a source checkout to be used without a pip install.

    ``DMEMO_HERMES_SRC`` points at ``packages/hermes-plugin/src``. Set by the
    local install script; unset in a normal pip/uv install, where the package
    is already on the path.
    """
    src = os.environ.get("DMEMO_HERMES_SRC")
    if src and src not in sys.path and os.path.isdir(src):
        sys.path.insert(0, src)


def register(ctx) -> None:
    _ensure_importable()
    from dmemo_hermes.provider import DmemoMemoryProvider

    ctx.register_memory_provider(DmemoMemoryProvider())
