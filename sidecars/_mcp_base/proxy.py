"""The ONE generic MCP-PROXY adapter, parameterized by
``ProxyBackend.lifecycle`` (E3: one implementation, two MODES, zero per-backend
string branches).

To Synapse it is an MCP server (via the base front end); to a vendored backend
MCP server it is an MCP client — a forwarding bridge.

  * ``lifecycle="shared"`` (Notion) — ONE persistent backend process spawned
    once; per-(tenant, cred-hash) the adapter holds an upstream MCP session with
    the credential injected on ``initialize``. ``inject_cred`` maps the rendered
    credential to upstream header(s).
  * ``lifecycle="per_tenant"`` (xhs) — a ``BackendProcessPool`` lazily spawns one
    UNMODIFIED backend child per (tenant, cred-hash), bound to a unique loopback
    port, with its own ``backend_env`` (COOKIES_PATH / TMPDIR under its 0700
    dir); requests route by tenant. ``inject_cred`` is ``IgnoreCred()`` — the
    credential reaches the backend via a file, never a per-request header.

The lifecycle split is a SINGLE ``Literal["shared","per_tenant"]`` switch inside
``build()`` / ``aclose()``; there are no ``notion``/``xhs`` name conditions.

``IgnoreCred`` and ``BackendPoolExhausted`` are defined in ``adapter`` /
``process`` respectively and re-exported here for the adapter contract.
"""

from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path
from typing import Any, Optional

from .adapter import AdapterConfig, IgnoreCred, ProxyBackend, TenantHandle
from .process import (
    BackendPoolExhausted,
    ChildProcessSupervisor,
    ReadinessProbe,
    is_process_alive,
)

__all__ = ["GenericProxyAdapter", "IgnoreCred", "BackendPoolExhausted"]


class _UpstreamSession:
    """Wraps one upstream MCP ClientSession, driven on a dedicated event loop
    thread so the synchronous registry/adapter surface can talk to the async MCP
    client without owning the front-end event loop.

    Lazily (re)connects: an upstream session can die outside the base's
    idle-clock (server restart / token revocation / server-side timeout), so
    ``list_tools`` / ``call_tool`` health-check and re-initialize on failure
    rather than handing a stale session to an in-flight call (§4.3).
    """

    def __init__(self, url: str, init_headers: dict[str, str]):
        self._url = url
        self._init_headers = init_headers
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._session = None
        self._ctx_stack = None

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is not None:
            return self._loop
        loop = asyncio.new_event_loop()

        def _run() -> None:
            asyncio.set_event_loop(loop)
            loop.run_forever()

        thread = threading.Thread(target=_run, name="mcp-proxy-upstream", daemon=True)
        thread.start()
        self._loop = loop
        self._thread = thread
        return loop

    def _submit(self, coro):
        loop = self._ensure_loop()
        return asyncio.run_coroutine_threadsafe(coro, loop).result()

    async def _connect(self) -> None:
        from contextlib import AsyncExitStack

        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        stack = AsyncExitStack()
        read, write, _ = await stack.enter_async_context(
            streamablehttp_client(self._url, headers=self._init_headers)
        )
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        self._ctx_stack = stack
        self._session = session

    async def _disconnect(self) -> None:
        if self._ctx_stack is not None:
            try:
                await self._ctx_stack.aclose()
            finally:
                self._ctx_stack = None
                self._session = None

    def _ensure_session(self):
        if self._session is not None:
            return self._session
        self._submit(self._connect())
        return self._session

    def _reconnect(self):
        self._submit(self._disconnect())
        self._submit(self._connect())
        return self._session

    def list_tools(self):
        with self._lock:
            self._ensure_session()
            try:
                return self._submit(self._session.list_tools()).tools
            except Exception:
                self._reconnect()
                return self._submit(self._session.list_tools()).tools

    def call_tool(self, name: str, arguments: dict[str, Any]):
        with self._lock:
            self._ensure_session()
            try:
                return self._submit(self._session.call_tool(name, arguments))
            except Exception:
                self._reconnect()
                return self._submit(self._session.call_tool(name, arguments))

    def close(self) -> None:
        with self._lock:
            if self._loop is None:
                return
            try:
                self._submit(self._disconnect())
            finally:
                self._loop.call_soon_threadsafe(self._loop.stop)
                if self._thread is not None:
                    self._thread.join(timeout=5)
                with _suppress():
                    self._loop.close()
                self._loop = None
                self._thread = None


class _suppress:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return True


class _SharedBackend:
    """The single persistent backend process for ``lifecycle="shared"``."""

    def __init__(self, config: AdapterConfig):
        self._config = config
        self._backend = config.backend
        self._proc = None
        self._lock = threading.Lock()
        self._supervisor = ChildProcessSupervisor()

    def ensure_started(self) -> None:
        if self._backend.command is None:
            return  # already-running external backend addressed by url
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return
            import subprocess

            env = (
                self._backend.backend_env(Path("."))
                if self._backend.backend_env is not None
                else {}
            )
            self._proc = subprocess.Popen(self._backend.command, env=env)
            if self._backend.backend_ready_probe is not None:
                # The shared backend's readiness URL is fixed (port baked into
                # command); probe via its declared url if a probe is provided.
                ReadinessProbe().wait(self._backend.url or "")

    def stop(self) -> None:
        with self._lock:
            if self._proc is not None:
                self._supervisor.terminate(self._proc)
                self._proc = None


class GenericProxyAdapter:
    """The one MCP-PROXY adapter. ``config.backend.lifecycle`` selects the MODE.

    ``config`` is the ``AdapterConfig``; the base reads ``never_tools`` /
    ``raw_tools`` and owns the double allowlist, so this adapter forwards the
    backend's FULL catalog and never pre-filters.
    """

    def __init__(self, config: AdapterConfig):
        if config.backend is None:
            raise ValueError("GenericProxyAdapter requires config.backend")
        self.config = config
        self._backend: ProxyBackend = config.backend
        self._registry = None
        self._shared: Optional[_SharedBackend] = None
        self._supervisor = ChildProcessSupervisor()
        self._probe = ReadinessProbe()
        if self._backend.lifecycle == "shared":
            self._shared = _SharedBackend(config)

    def bind_registry(self, registry) -> None:
        # The registry owns the port allocator + max_backends gate; the adapter
        # only reads the allocator it was given (never mutates registry-global
        # state — that fork is where a "second pool" would grow).
        self._registry = registry

    # ------------------------------------------------------------------ build
    def build(self, *, tenant: str, cred: Any, workdir: Path) -> TenantHandle:
        """Synchronous per-(tenant,cred) setup. The single lifecycle switch."""
        lifecycle = self._backend.lifecycle
        if lifecycle == "shared":
            return self._build_shared(cred, workdir)
        if lifecycle == "per_tenant":
            return self._build_per_tenant(cred, workdir)
        raise ValueError(f"unknown lifecycle: {lifecycle!r}")  # pragma: no cover

    def _build_shared(self, cred: Any, workdir: Path) -> TenantHandle:
        self._shared.ensure_started()
        init_headers = self._init_headers(cred)
        session = _UpstreamSession(self._backend.url, init_headers)
        return TenantHandle(session=session, url=self._backend.url, workdir=workdir)

    def _build_per_tenant(self, cred: Any, workdir: Path) -> TenantHandle:
        import subprocess

        allocator = self._require_allocator()
        port = allocator.acquire()
        try:
            # Materialize a real cookie/credential string to the backend's file
            # (IgnoreCred backends receive creds via file, not header).
            self._materialize_cred(cred, workdir)
            (workdir / "tmp").mkdir(parents=True, exist_ok=True, mode=0o700)
            argv = self._backend.spawn_cmd(port, workdir)
            env = (
                self._backend.backend_env(workdir)
                if self._backend.backend_env is not None
                else {}
            )
            proc = subprocess.Popen(argv, env=env)
            ready_url = (
                self._backend.backend_ready_probe(port)
                if self._backend.backend_ready_probe is not None
                else (self._backend.backend_url(port) if self._backend.backend_url else "")
            )
            ok = self._probe.wait(
                ready_url, is_alive=lambda: proc.poll() is None
            )
            if not ok:
                self._supervisor.terminate(proc)
                allocator.release(port)
                raise BackendPoolExhausted(
                    f"backend on port {port} failed to become ready"
                )
            url = self._backend.backend_url(port)
            session = _UpstreamSession(url, {})
            return TenantHandle(
                session=session,
                port=port,
                url=url,
                pid=proc.pid,
                workdir=workdir,
                extra={"proc": proc},
            )
        except BaseException:
            allocator.release(port)
            raise

    # ------------------------------------------------------------- list/call
    async def list_tools(self, handle: TenantHandle, *, expose_raw: bool):
        # The base strips NEVER/RAW; forward the backend's full catalog.
        return await asyncio.to_thread(handle.session.list_tools)

    async def call_tool(self, handle: TenantHandle, name: str, arguments: dict[str, Any]):
        return await asyncio.to_thread(handle.session.call_tool, name, arguments)

    # ----------------------------------------------------------------- close
    async def aclose(self, handle: TenantHandle) -> None:
        await asyncio.to_thread(self.aclose_sync, handle)

    def aclose_sync(self, handle: TenantHandle) -> None:
        """Synchronous teardown invoked by the registry under its lock path.

        Strict order: close upstream session -> SIGTERM/SIGKILL child + waitpid
        (confirm exit) -> release the port. The port is NEVER re-allocatable
        before the child is confirmed exited."""
        if handle.session is not None:
            with _suppress():
                handle.session.close()
        proc = handle.extra.get("proc") if handle.extra else None
        if proc is not None:
            self._supervisor.terminate(proc)
        if handle.port is not None and self._registry is not None:
            allocator = self._registry.ports
            if allocator is not None:
                allocator.release(handle.port)

    def stop_shared(self) -> None:
        if self._shared is not None:
            self._shared.stop()

    # --------------------------------------------------------------- helpers
    def _init_headers(self, cred: Any) -> dict[str, str]:
        inject = self._backend.inject_cred
        headers = dict(self._backend.fixed_headers)
        if not isinstance(inject, IgnoreCred):
            headers.update(inject(cred if isinstance(cred, str) else str(cred)))
        return headers

    def _materialize_cred(self, cred: Any, workdir: Path) -> None:
        # Only write a credential file when a real per-tenant credential string
        # is present (per_tenant backends read it via COOKIES_PATH). The backend
        # env maps COOKIES_PATH into this workdir.
        if not isinstance(cred, str) or not cred:
            return
        cookie_path = workdir / "cookies.json"
        fd = os.open(str(cookie_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, cred.encode("utf-8"))
        finally:
            os.close(fd)

    def _require_allocator(self):
        if self._registry is None or self._registry.ports is None:
            raise ValueError(
                "per_tenant proxy requires a registry with a port allocator"
            )
        return self._registry.ports
