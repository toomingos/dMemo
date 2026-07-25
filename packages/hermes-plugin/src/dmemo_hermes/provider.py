"""Hermes ``MemoryProvider`` backed by dMemo.

Derived from Hermes's own ``plugins/memory/mem0`` provider (D18: fork the
host's closest-fit provider rather than inventing a new integration shape),
with the backend replaced by an in-process :class:`DmemoSession`. The
threading model, the 3-second prefetch budget and the circuit breaker are
kept because they are what makes a memory provider safe to put on a hot
path — but the failure modes they guard against are different here: there is
no server to be down, only a chain that may be slow or a flush that may not
land.

Two properties the mem0 provider does not have:

  * nothing leaves this machine unencrypted — turns are embedded locally and
    ECIES-encrypted to the wallet's own public key before upload;
  * ``infer`` is false by default (D17), so no second LLM call ever sees the
    conversation to "extract facts" from it.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

try:  # Hermes provides the ABC; standalone use (tests) does not need it.
    from agent.memory_provider import MemoryProvider  # type: ignore
except Exception:  # pragma: no cover

    class MemoryProvider:  # type: ignore
        pass


from .config import ConfigNotFoundError, DmemoConfig, dmemo_home, load_config
from .session import DmemoSession

logger = logging.getLogger(__name__)

_PREFETCH_WAIT_SECS = 3
_BREAKER_THRESHOLD = 5
_BREAKER_COOLDOWN_SECS = 120
_DEFAULT_USER_ID = "hermes-user"

SEARCH_SCHEMA = {
    "name": "dmemo_search",
    "description": (
        "Search your persistent, encrypted memory of this user (stored on 0G, "
        "restored at session start). Use for anything that could depend on prior "
        "conversations: preferences, facts, people, projects, decisions."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to recall."},
            "top_k": {"type": "integer", "description": "Max results (default 10, max 50)."},
        },
        "required": ["query"],
    },
}

ADD_SCHEMA = {
    "name": "dmemo_add",
    "description": "Store a durable fact in encrypted memory. Stored verbatim — write one self-contained fact.",
    "parameters": {
        "type": "object",
        "properties": {"content": {"type": "string", "description": "The fact to remember."}},
        "required": ["content"],
    },
}

DELETE_SCHEMA = {
    "name": "dmemo_delete",
    "description": "Delete a memory by id (ids come from dmemo_search results).",
    "parameters": {
        "type": "object",
        "properties": {"memory_id": {"type": "string", "description": "Memory id to delete."}},
        "required": ["memory_id"],
    },
}


def _tool_error(message: str) -> str:
    return json.dumps({"error": message})


class DmemoMemoryProvider(MemoryProvider):
    """Private, decentralized memory for Hermes."""

    def __init__(self) -> None:
        self._session: Optional[DmemoSession] = None
        self._config: Optional[DmemoConfig] = None
        self._init_error: Optional[str] = None
        self._user_id = _DEFAULT_USER_ID
        self._agent_id = "hermes"
        self._channel = "cli"
        self._read_only = False
        self._obs_path = os.environ.get("DMEMO_OBS_LOG") or ""
        self._obs_lock = threading.Lock()

        self._sync_thread: Optional[threading.Thread] = None
        self._prefetch_thread: Optional[threading.Thread] = None
        self._prefetch_query = ""
        self._prefetch_result = ""
        self._prefetch_done = False
        self._consecutive_failures = 0
        self._breaker_open_until = 0.0
        self._breaker_lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._prefetch_lock = threading.Lock()
        self._atexit_registered = False

    @property
    def name(self) -> str:
        return "dmemo"

    # -- observability ------------------------------------------------------

    def _observe(self, event: str, data: Dict[str, Any]) -> None:
        """Structured event log — the record of what actually crossed the wire.

        Written as JSONL so a run can be verified after the fact instead of
        taken on trust. Never contains memory text or key material.
        """
        record = {"ts": time.time(), "event": event, **data}
        logger.debug("[dmemo] %s %s", event, data)
        if not self._obs_path:
            return
        try:
            with self._obs_lock:
                with open(self._obs_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(record, default=str) + "\n")
        except Exception:
            pass

    # -- availability / config ---------------------------------------------

    def is_available(self) -> bool:
        # No network here (the ABC forbids it): config presence + importable
        # deps only.
        try:
            load_config()
        except ConfigNotFoundError:
            return False
        except Exception:
            return False
        try:
            import mem0  # noqa: F401
        except Exception:
            return False
        return True

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "private_key",
                "description": "Wallet private key — also the encryption key for your memories (0x-prefixed)",
                "secret": True,
                "required": True,
                "env_var": "DMEMO_PRIVATE_KEY",
                "url": "https://faucet.0g.ai",
            },
            {"key": "network", "description": "0G network", "default": "testnet", "choices": ["testnet", "mainnet"], "env_var": "DMEMO_NETWORK"},
            {"key": "scope", "description": "Agent scope label recorded in each blob", "default": "hermes", "env_var": "DMEMO_SCOPE"},
            {"key": "user_id", "description": "User identifier for memory filtering", "default": _DEFAULT_USER_ID},
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        """Write non-secret config to ``$HERMES_HOME/dmemo.json``."""
        from pathlib import Path

        path = Path(hermes_home) / "dmemo.json"
        existing: Dict[str, Any] = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
        existing.update(values)
        path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        os.chmod(path, 0o600)

    def backup_paths(self) -> List[str]:
        # ~/.dmemo holds the wallet config and the pointer cache — both live
        # outside HERMES_HOME, so `hermes backup` would otherwise miss them.
        # (Memories themselves are on 0G and need no backup.)
        return [str(dmemo_home())]

    # -- lifecycle ----------------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        hermes_home = kwargs.get("hermes_home") or os.path.expanduser("~/.hermes")
        file_cfg: Dict[str, Any] = {}
        try:
            with open(os.path.join(hermes_home, "dmemo.json"), encoding="utf-8") as fh:
                file_cfg = json.load(fh)
        except Exception:
            file_cfg = {}

        env_overlay = dict(os.environ)
        for key, env_key in (("network", "DMEMO_NETWORK"), ("scope", "DMEMO_SCOPE")):
            if file_cfg.get(key) and not env_overlay.get(env_key):
                env_overlay[env_key] = str(file_cfg[key])

        self._user_id = file_cfg.get("user_id") or kwargs.get("user_id") or _DEFAULT_USER_ID
        self._agent_id = file_cfg.get("agent_id") or kwargs.get("agent_identity") or "hermes"
        self._channel = kwargs.get("platform") or "cli"

        # Subagents and cron runs must not write into the user's memory (their
        # prompts are not the user talking), so they get a read-only session.
        self._read_only = kwargs.get("agent_context", "primary") != "primary"

        try:
            self._config = load_config(env_overlay)
            self._config.scope = env_overlay.get("DMEMO_SCOPE") or file_cfg.get("scope") or "hermes"
            t0 = time.perf_counter()
            self._session = DmemoSession.open(self._config, observer=self._observe)
            st = self._session.restore_stats
            logger.info(
                "[dmemo] restored %d memories from %d blob(s) in %.0fms (wallet %s, %s)",
                st.vector_rows, st.chain_length, (time.perf_counter() - t0) * 1000,
                self._session.transport.address, self._config.network,
            )
        except Exception as e:  # noqa: BLE001 — memory must never break the host
            self._init_error = str(e)
            self._session = None
            logger.error("[dmemo] failed to open memory session: %s", e)
            self._observe("provider.init.failed", {"error": str(e)})
            return

        if not self._atexit_registered:
            atexit.register(self._close_session)
            self._atexit_registered = True

    def _close_session(self) -> None:
        session, self._session = self._session, None
        if session is None:
            return
        try:
            session.close()
        except Exception as e:  # noqa: BLE001
            logger.warning("[dmemo] error closing session: %s", e)

    def shutdown(self) -> None:
        for t in (self._prefetch_thread, self._sync_thread):
            if t and t.is_alive():
                t.join(timeout=10.0)
        self._close_session()

    # -- breaker ------------------------------------------------------------

    def _is_breaker_open(self) -> bool:
        with self._breaker_lock:
            if self._consecutive_failures < _BREAKER_THRESHOLD:
                return False
            if time.monotonic() >= self._breaker_open_until:
                self._consecutive_failures = 0
                return False
            return True

    def _record_success(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures = 0

    def _record_failure(self) -> None:
        with self._breaker_lock:
            self._consecutive_failures += 1
            tripped = self._consecutive_failures >= _BREAKER_THRESHOLD
            if tripped:
                self._breaker_open_until = time.monotonic() + _BREAKER_COOLDOWN_SECS
        if tripped:
            logger.warning(
                "[dmemo] circuit breaker tripped after %d consecutive failures; pausing for %ds",
                _BREAKER_THRESHOLD, _BREAKER_COOLDOWN_SECS,
            )

    # -- prompt / recall ----------------------------------------------------

    def system_prompt_block(self) -> str:
        if self._session is None:
            return ""
        st = self._session.restore_stats
        return (
            "# dMemo Memory\n"
            f"Active. Encrypted memory on 0G ({self._config.network if self._config else 'testnet'}), "
            f"wallet {self._session.transport.address}. "
            f"{st.vector_rows} memories restored from {st.chain_length} blob(s) at session start.\n"
            "You have persistent memory of this user from past conversations. "
            "Call dmemo_search before answering anything that could depend on prior context "
            "(preferences, facts, history, people, projects, earlier decisions) — do not rely "
            "on the chat window alone, and do not assume you have no memory.\n"
            "For multi-part questions run several searches with different wording and follow up "
            "on what the first results surface; one search is rarely enough.\n"
            "Tools: dmemo_search to recall, dmemo_add to store a fact, dmemo_delete to remove one by id."
        )

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        self._start_prefetch(message)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        self._start_prefetch(query)

    def _format_results(self, results: List[Dict[str, Any]]) -> str:
        lines = [str(r.get("memory", "")) for r in results if r.get("memory")]
        if not lines:
            return ""
        return "## dMemo Memory\n" + "\n".join(f"- {line}" for line in lines)

    def _consume_prefetch_result(self, query: str) -> Optional[str]:
        with self._prefetch_lock:
            if self._prefetch_query != query or not self._prefetch_done:
                return None
            result = self._prefetch_result
            self._prefetch_result = ""
            self._prefetch_done = False
            return result

    def _start_prefetch(self, query: str) -> None:
        session = self._session
        if not query or session is None or self._is_breaker_open():
            return
        with self._prefetch_lock:
            if self._prefetch_query == query:
                if self._prefetch_done:
                    return
                if self._prefetch_thread and self._prefetch_thread.is_alive():
                    return
            self._prefetch_query = query
            self._prefetch_result = ""
            self._prefetch_done = False

        def _run() -> None:
            body = ""
            try:
                t0 = time.perf_counter()
                results = session.search(query, filters={"user_id": self._user_id}, top_k=10)
                body = self._format_results(results)
                self._observe(
                    "recall.prefetch",
                    {
                        "query": query[:120],
                        "hits": len(results),
                        "ms": round((time.perf_counter() - t0) * 1000, 1),
                        "top": [
                            {"id": r.get("id"), "score": round(float(r.get("score") or 0), 4)}
                            for r in results[:5]
                        ],
                        "injectedChars": len(body),
                    },
                )
                self._record_success()
            except Exception as e:  # noqa: BLE001
                self._record_failure()
                logger.debug("[dmemo] prefetch failed: %s", e)
            with self._prefetch_lock:
                if self._prefetch_query == query:
                    self._prefetch_result = body
                    self._prefetch_done = True

        t = threading.Thread(target=_run, daemon=True, name="dmemo-prefetch")
        with self._prefetch_lock:
            self._prefetch_thread = t
        t.start()

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        cached = self._consume_prefetch_result(query)
        if cached is not None:
            return cached
        self._start_prefetch(query)
        with self._prefetch_lock:
            thread = self._prefetch_thread if self._prefetch_query == query else None
        if thread:
            thread.join(timeout=_PREFETCH_WAIT_SECS)
        cached = self._consume_prefetch_result(query)
        if cached is not None:
            return cached
        # Slow recall: skip injection rather than stall the turn — the
        # dmemo_search tool is still there as the backstop.
        return ""

    # -- capture ------------------------------------------------------------

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        session = self._session
        if session is None or self._read_only or self._is_breaker_open():
            return
        if not (user_content or assistant_content):
            return

        # Same verbatim shape the TypeScript hosts write, so a memory captured
        # in Hermes reads identically when OpenCode or Claude Code restores it.
        text = f"User: {user_content}\n\nAssistant: {assistant_content}"

        def _sync() -> None:
            try:
                t0 = time.perf_counter()
                session.add(
                    text,
                    user_id=self._user_id,
                    agent_id=self._agent_id,
                    metadata={"channel": self._channel, "session_id": session_id} if self._channel else None,
                )
                self._observe(
                    "capture.turn",
                    {"chars": len(text), "ms": round((time.perf_counter() - t0) * 1000, 1), "sessionId": session_id},
                )
                self._record_success()
            except Exception as e:  # noqa: BLE001
                self._record_failure()
                logger.warning("[dmemo] capture failed: %s", e)

        with self._sync_lock:
            if self._sync_thread and self._sync_thread.is_alive():
                self._sync_thread.join(timeout=5.0)
            if self._sync_thread and self._sync_thread.is_alive():
                return  # still busy — skip rather than double-ingest
            self._sync_thread = threading.Thread(target=_sync, daemon=True, name="dmemo-sync")
            self._sync_thread.start()

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        if self._session is not None:
            self._session.flush()

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        if self._session is not None:
            self._session.flush()
        return ""

    def on_memory_write(self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Mirror Hermes's built-in memory-tool writes into dMemo."""
        session = self._session
        if session is None or self._read_only or action not in ("add", "replace") or not content:
            return
        try:
            session.add(content, user_id=self._user_id, agent_id=self._agent_id, metadata={"origin": "builtin-memory"})
            self._observe("capture.memory_write", {"action": action, "target": target, "chars": len(content)})
        except Exception as e:  # noqa: BLE001
            logger.warning("[dmemo] mirroring builtin memory write failed: %s", e)

    # -- tools --------------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA, ADD_SCHEMA, DELETE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        session = self._session
        if session is None:
            return _tool_error(f"dMemo not initialized: {self._init_error or 'unknown error'}")
        if self._is_breaker_open():
            return _tool_error("dMemo temporarily unavailable (multiple consecutive failures). Will retry automatically.")

        if tool_name == "dmemo_search":
            query = args.get("query", "")
            if not query:
                return _tool_error("Missing required parameter: query")
            try:
                top_k = max(1, min(int(args.get("top_k", 10)), 50))
                t0 = time.perf_counter()
                results = session.search(query, filters={"user_id": self._user_id}, top_k=top_k)
                self._record_success()
                self._observe(
                    "recall.tool",
                    {
                        "query": query[:120],
                        "hits": len(results),
                        "ms": round((time.perf_counter() - t0) * 1000, 1),
                        "top": [{"id": r.get("id"), "score": round(float(r.get("score") or 0), 4)} for r in results[:5]],
                    },
                )
                if not results:
                    return json.dumps({"result": "No relevant memories found."})
                items = [
                    {"id": r.get("id"), "memory": r.get("memory", ""), "score": r.get("score", 0)}
                    for r in results
                ]
                return json.dumps({"results": items, "count": len(items)})
            except Exception as e:  # noqa: BLE001
                self._record_failure()
                return _tool_error(f"Search failed: {e}")

        if tool_name == "dmemo_add":
            content = args.get("content", "")
            if not content:
                return _tool_error("Missing required parameter: content")
            if self._read_only:
                return _tool_error("This agent context is read-only for memory.")
            try:
                session.add(content, user_id=self._user_id, agent_id=self._agent_id, metadata={"origin": "tool"})
                self._record_success()
                self._observe("capture.tool_add", {"chars": len(content)})
                return json.dumps({"result": "Fact stored (encrypted, queued for 0G)."})
            except Exception as e:  # noqa: BLE001
                self._record_failure()
                return _tool_error(f"Failed to store: {e}")

        if tool_name == "dmemo_delete":
            memory_id = args.get("memory_id", "")
            if not memory_id:
                return _tool_error("Missing required parameter: memory_id")
            if self._read_only:
                return _tool_error("This agent context is read-only for memory.")
            try:
                session.memory.delete(memory_id)
                session.flush()
                self._record_success()
                self._observe("capture.tool_delete", {"memoryId": memory_id})
                return json.dumps({"result": "Memory deleted.", "memory_id": memory_id})
            except Exception as e:  # noqa: BLE001
                self._record_failure()
                return _tool_error(f"Delete failed: {e}")

        return _tool_error(f"Unknown tool: {tool_name}")


def register(ctx) -> None:
    """Hermes plugin entry point."""
    ctx.register_memory_provider(DmemoMemoryProvider())
