"""The ONE per-(tenant, cred-hash) adapter cache with refcount + retire
semantics (generalized from mijia's ``_AdapterRegistry``).

CRITICAL change vs mijia: the map is keyed by ``(tenant, cred_hash)`` — NOT by
tenant alone. mijia's ``_by_tenant`` kept at most one entry per tenant and
retired the old one on credential change; ``per_tenant`` (xhs multi-account)
needs N entries per tenant to coexist. ``shared`` (Notion) also wants per-token
sessions to coexist, so this single keying serves both.

Preserved load-bearing invariants:
  * startup ``shutil.rmtree(root)`` then ``mkdir(0o700)`` — a fresh process owns
    no in-memory entries, so any tenant dir on disk is necessarily orphaned.
  * ``borrow()`` ctxmgr refcount; ``_maybe_delete_locked`` rmtrees ONLY at
    refcount==0 (an in-flight borrow is never cut off by a concurrent
    rotation/eviction).
  * idle-TTL eviction (refcount==0 only); 0700 dirs / 0600 secret files.

ALSO owns (single home, so lifecycle state never forks between adapter and
registry — that fork is where a "second pool" would grow):
  * a global ``max_backends`` gate,
  * cross-tenant LRU-idle eviction of idle backends to make room,
  * the loopback ``PortAllocator``.
The adapter only SUPPLIES ``max_entries`` + an eviction predicate + a port range;
it never reaches back to mutate registry-global state.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .adapter import Adapter, TenantHandle
from .process import BackendPoolExhausted, PortAllocator

logger = logging.getLogger("mcp-base.registry")


def _default_idle_ttl() -> float:
    return float(os.environ.get("MCP_ADAPTER_IDLE_TTL_SECONDS", str(30 * 60)))


class _AdapterEntry:
    __slots__ = (
        "handle",
        "config_dir",
        "cred_hash",
        "tenant",
        "key",
        "refcount",
        "retired",
        "last_used",
    )

    def __init__(
        self,
        handle: TenantHandle,
        config_dir: Path,
        cred_hash: str,
        tenant: str,
        key: tuple[str, str],
    ):
        self.handle = handle
        self.config_dir = config_dir
        self.cred_hash = cred_hash
        self.tenant = tenant
        self.key = key
        self.refcount = 0
        self.retired = False
        self.last_used = time.monotonic()


class _AdapterRegistry:
    """Caches one backend handle per (tenant, cred-hash) with isolated 0700
    workdirs and refcount + retire-then-delete lifecycle."""

    def __init__(
        self,
        root: Path,
        adapter: Adapter,
        *,
        idle_ttl: Optional[float] = None,
        max_backends: Optional[int] = None,
        port_range: Optional[tuple[int, int]] = None,
        evict_predicate: Optional[Callable[[_AdapterEntry], bool]] = None,
        aclose_handle: Optional[Callable[[TenantHandle], None]] = None,
    ):
        self._root = root
        self._adapter = adapter
        self._idle_ttl = idle_ttl if idle_ttl is not None else _default_idle_ttl()
        self._max_backends = max_backends
        # The registry owns the port allocator (single home for per_tenant ports).
        self._ports: Optional[PortAllocator] = (
            PortAllocator(port_range) if port_range is not None else None
        )
        # Predicate for cross-tenant LRU-idle eviction targets (default: any
        # idle entry is evictable). The adapter supplies the predicate; it does
        # not mutate registry state itself.
        self._evict_predicate = evict_predicate or (lambda _e: True)
        # Synchronous teardown of a handle (rmtree of secret dir handled here;
        # backend-specific close, e.g. SIGTERM the child, handled by this hook).
        self._aclose_handle = aclose_handle

        # Stateless guarantee: a fresh process owns NO in-memory entries, so any
        # tenant dir on disk is necessarily orphaned from a prior crash/restart.
        if root.exists():
            try:
                shutil.rmtree(root)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to purge stale tenant root %s: %s", root, exc)
        self._root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = threading.Lock()
        self._entries: dict[tuple[str, str], _AdapterEntry] = {}

    @property
    def ports(self) -> Optional[PortAllocator]:
        return self._ports

    @staticmethod
    def _safe_tenant(tenant: str) -> str:
        return hashlib.sha256(tenant.encode("utf-8")).hexdigest()[:16]

    @contextlib.contextmanager
    def borrow(self, tenant: str, cred: Any, cred_hash: str):
        """Borrow the (tenant, cred_hash) handle. Builds it on first use under a
        global ``max_backends`` gate; refcounts it for the duration of the
        ``with`` block; deletes the secret dir only once refcount hits zero."""
        key = (tenant, cred_hash)
        with self._lock:
            self._evict_idle_locked()
            entry = self._entries.get(key)
            if entry is None or entry.retired:
                entry = self._build_locked(tenant, cred, cred_hash, key)
            entry.refcount += 1
            entry.last_used = time.monotonic()
        try:
            yield entry.handle
        finally:
            with self._lock:
                entry.refcount -= 1
                entry.last_used = time.monotonic()
                self._maybe_delete_locked(entry)

    def _build_locked(
        self, tenant: str, cred: Any, cred_hash: str, key: tuple[str, str]
    ) -> _AdapterEntry:
        # Enforce the global backend cap, evicting an idle (refcount==0) entry to
        # make room (cross-tenant LRU). Never evict an in-flight backend.
        self._enforce_max_backends_locked()
        config_dir = self._root / f"{self._safe_tenant(tenant)}-{cred_hash}"
        config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        handle = self._adapter.build(tenant=tenant, cred=cred, workdir=config_dir)
        entry = _AdapterEntry(handle, config_dir, cred_hash, tenant, key)
        self._entries[key] = entry
        return entry

    def _enforce_max_backends_locked(self) -> None:
        if self._max_backends is None:
            return
        while len(self._entries) >= self._max_backends:
            victim = self._lru_idle_victim_locked()
            if victim is None:
                # No idle backend to evict — fail closed, retriable. Never thrash.
                raise BackendPoolExhausted(
                    f"max_backends={self._max_backends} reached and all backends are in-flight"
                )
            victim.retired = True
            self._maybe_delete_locked(victim)

    def _lru_idle_victim_locked(self) -> Optional[_AdapterEntry]:
        candidates = [
            e
            for e in self._entries.values()
            if e.refcount <= 0 and not e.retired and self._evict_predicate(e)
        ]
        if not candidates:
            return None
        return min(candidates, key=lambda e: e.last_used)

    def _evict_idle_locked(self) -> None:
        if self._idle_ttl <= 0:
            return
        now = time.monotonic()
        for entry in list(self._entries.values()):
            if (
                entry.refcount <= 0
                and not entry.retired
                and now - entry.last_used > self._idle_ttl
            ):
                entry.retired = True
                self._maybe_delete_locked(entry)

    def _maybe_delete_locked(self, entry: _AdapterEntry) -> None:
        if not (entry.retired and entry.refcount <= 0):
            return
        # Backend-specific teardown (close upstream session / SIGTERM child +
        # reclaim port) runs first, THEN the secret dir is removed. The aclose
        # hook is responsible for releasing any allocated port only after the
        # child is confirmed exited.
        if self._aclose_handle is not None:
            with contextlib.suppress(Exception):
                self._aclose_handle(entry.handle)
        with contextlib.suppress(Exception):
            shutil.rmtree(entry.config_dir, ignore_errors=True)
        current = self._entries.get(entry.key)
        if current is entry:
            del self._entries[entry.key]

    def shutdown(self) -> None:
        with self._lock:
            for entry in list(self._entries.values()):
                entry.retired = True
                if entry.refcount <= 0:
                    if self._aclose_handle is not None:
                        with contextlib.suppress(Exception):
                            self._aclose_handle(entry.handle)
                    with contextlib.suppress(Exception):
                        shutil.rmtree(entry.config_dir, ignore_errors=True)
            self._entries.clear()

    # --- test/introspection helpers ---------------------------------------
    def _entry_count(self) -> int:
        with self._lock:
            return len(self._entries)

    def _keys(self) -> list[tuple[str, str]]:
        with self._lock:
            return list(self._entries.keys())
