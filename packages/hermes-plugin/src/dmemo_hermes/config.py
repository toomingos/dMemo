"""Config resolution — same env surface and precedence as ``core/config.ts``.

A real environment variable wins; otherwise ``${DMEMO_HOME:-~/.dmemo}/config.json``
(written by ``dmemo setup`` / ``dmemo connect``) fills the gaps; otherwise the
documented default. Identical rules on both runtimes means one wallet
configured once works for every host, which is the point of D14.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_CHECKPOINT_K = 2
DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES = 64 * 1024
DEFAULT_UPLOAD_TIMEOUT_MS = 120_000


class ConfigNotFoundError(Exception):
    pass


def dmemo_home(env: Optional[Dict[str, str]] = None) -> Path:
    env = env if env is not None else os.environ  # type: ignore[assignment]
    return Path(env.get("DMEMO_HOME") or (Path.home() / ".dmemo"))


def dmemo_config_path(env: Optional[Dict[str, str]] = None) -> Path:
    return dmemo_home(env) / "config.json"


def read_config_file(env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Never throws: missing or malformed file both mean "nothing here"."""
    try:
        parsed = json.loads(dmemo_config_path(env).read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _as_bool(value: Optional[str], fallback: bool) -> bool:
    if value is None or not value.strip():
        return fallback
    return value.strip().lower() in ("true", "1")


def _as_int(value: Optional[str], fallback: int) -> int:
    try:
        return int(str(value).strip())
    except Exception:
        return fallback


@dataclass
class DmemoConfig:
    private_key: str
    network: str = "testnet"
    scope: str = "default"
    infer: bool = False
    checkpoint_every_n_flushes: int = DEFAULT_CHECKPOINT_K
    checkpoint_size_threshold_bytes: int = DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES
    upload_timeout_ms: int = DEFAULT_UPLOAD_TIMEOUT_MS
    download_timeout_ms: Optional[int] = None
    pointer_cache_path: Optional[str] = None
    network_overrides: Dict[str, Any] = field(default_factory=dict)
    embedder_provider: Optional[str] = None
    embedder_model: Optional[str] = None

    def redacted(self) -> Dict[str, Any]:
        """Everything except the key — safe to log."""
        out = {k: v for k, v in self.__dict__.items() if k != "private_key"}
        out["private_key"] = f"<{len(self.private_key)} chars, redacted>"
        return out


def load_config(env: Optional[Dict[str, str]] = None) -> DmemoConfig:
    env = dict(env if env is not None else os.environ)
    file_env = read_config_file(env)
    for key, value in file_env.items():
        if env.get(key) is None and isinstance(value, str):
            env[key] = value

    private_key = env.get("DMEMO_PRIVATE_KEY")
    if not private_key:
        raise ConfigNotFoundError(
            "dMemo is not configured: no DMEMO_PRIVATE_KEY in the environment, and no config file at "
            f"{dmemo_config_path()}. Run `npx @dmemo/cli setup` (or `dmemo connect`) to configure a wallet."
        )

    network = env.get("DMEMO_NETWORK") or "testnet"
    if network not in ("testnet", "mainnet"):
        raise ValueError(f'invalid DMEMO_NETWORK "{network}" — must be "testnet" or "mainnet"')

    overrides = {
        "rpcUrl": env.get("DMEMO_RPC_URL"),
        "indexerUrl": env.get("DMEMO_INDEXER_URL"),
        "flowAddress": env.get("DMEMO_FLOW_ADDRESS"),
        "routerUrl": env.get("DMEMO_ROUTER_URL"),
    }

    return DmemoConfig(
        private_key=private_key,
        network=network,
        scope=env.get("DMEMO_SCOPE") or "default",
        infer=_as_bool(env.get("DMEMO_INFER"), False),
        checkpoint_every_n_flushes=_as_int(env.get("DMEMO_CHECKPOINT_K"), DEFAULT_CHECKPOINT_K),
        checkpoint_size_threshold_bytes=_as_int(
            env.get("DMEMO_CHECKPOINT_SIZE_THRESHOLD_BYTES"), DEFAULT_CHECKPOINT_SIZE_THRESHOLD_BYTES
        ),
        upload_timeout_ms=_as_int(env.get("DMEMO_UPLOAD_TIMEOUT_MS"), DEFAULT_UPLOAD_TIMEOUT_MS),
        download_timeout_ms=_as_int(env["DMEMO_DOWNLOAD_TIMEOUT_MS"], 0) or None
        if env.get("DMEMO_DOWNLOAD_TIMEOUT_MS")
        else None,
        pointer_cache_path=env.get("DMEMO_POINTER_CACHE_PATH"),
        network_overrides={k: v for k, v in overrides.items() if v},
        embedder_provider=env.get("DMEMO_EMBEDDER_PROVIDER"),
        embedder_model=env.get("DMEMO_EMBEDDER_MODEL"),
    )
