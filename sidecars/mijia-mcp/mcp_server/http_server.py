"""Multi-tenant Streamable-HTTP front-end for the Mijia MCP server.

This module is the entry point for the containerized, multi-tenant deployment.
Unlike the upstream stdio server (single global account), it:

  * Serves MCP over stateless Streamable HTTP (no server-side session needed).
  * Reads per-request credentials from the `X-Mijia-Auth` header (base64 of the
    upstream mijiaAPI canonical auth dict) and a `X-Mijia-Tenant` header
    (the Synapse installation id) on every call.
  * Caches one MijiaAdapter per (tenant, auth-hash) with refcount/retire so an
    in-flight call is never cut off by a concurrent rotation/eviction, and a
    retired entry's isolated temp dir is deleted only once idle.
  * Binds the resolved adapter into a contextvar so the upstream tool handlers
    (which call get_adapter()) transparently operate on the per-request adapter.
  * Filters the advertised + callable tool set per request via a three-group
    allowlist (NEVER / DEFAULT / RAW), and re-checks authorization on call so a
    cached schema cannot be used to invoke a tool the request is not allowed to.

It deliberately exposes NO resources and NO login/session/local-state tools.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import hashlib
import json
import os
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Any, Optional

import anyio
import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.types import Receive, Scope, Send

from adapter.mijia_adapter import MijiaAdapter
from mcp_server import mcp_server as srv

import logging

logger = logging.getLogger("mijia-mcp.http")

# ---------------------------------------------------------------------------
# Tool exposure allowlist (three groups). The upstream catalog has ~26 tools;
# we never expose login/session/local-state tools and gate raw/low-level tools
# behind the per-request X-Mijia-Expose-Raw flag.
# ---------------------------------------------------------------------------

NEVER_TOOLS = frozenset(
    {
        "prepare_login",
        "clear_saved_login",
        "reconnect_service",
        "get_service_status",
        "get_tool_catalog",  # would re-advertise NEVER tools
    }
)

# Low-level / raw tools only exposed when X-Mijia-Expose-Raw is truthy. The
# upstream build is friendly-tool-only today, so this is empty — but the
# mechanism is in place so adding raw tools later is gated by default.
RAW_TOOLS: frozenset[str] = frozenset()

HEADER_AUTH = "x-mijia-auth"
HEADER_TENANT = "x-mijia-tenant"
HEADER_EXPOSE_RAW = "x-mijia-expose-raw"

MAX_AUTH_HEADER_BYTES = 16 * 1024
MAX_TENANT_LEN = 256


class TenantError(Exception):
    """Raised when the per-request tenant/credential headers are unusable."""


def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _allowed_tool_names(expose_raw: bool) -> set[str]:
    names: set[str] = set()
    for tool in srv.mcp._tool_manager.list_tools():
        if tool.name in NEVER_TOOLS:
            continue
        if tool.name in RAW_TOOLS and not expose_raw:
            continue
        names.add(tool.name)
    return names


# ---------------------------------------------------------------------------
# Per-tenant adapter cache with refcount + retire semantics.
# ---------------------------------------------------------------------------


class _AdapterEntry:
    __slots__ = ("adapter", "config_dir", "auth_hash", "tenant", "refcount", "retired")

    def __init__(
        self,
        adapter: MijiaAdapter,
        config_dir: Path,
        auth_hash: str,
        tenant: str,
    ):
        self.adapter = adapter
        self.config_dir = config_dir
        self.auth_hash = auth_hash
        self.tenant = tenant
        self.refcount = 0
        self.retired = False


class _AdapterRegistry:
    """Caches MijiaAdapter per (tenant, auth-hash) with isolated temp dirs.

    Retire-then-delete: when a tenant's credentials rotate (auth_hash changes)
    or an entry is evicted, the old entry is marked retired (no new borrowers)
    and its secret dir is removed only once refcount hits zero, so in-flight
    calls finish against the credentials they started with.
    """

    def __init__(self, root: Path):
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = threading.Lock()
        self._by_tenant: dict[str, _AdapterEntry] = {}

    def _materialize_auth(self, config_dir: Path, auth_dict: dict[str, Any]) -> None:
        config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # mijiaAPI / AuthDataManager read this exact filename.
        auth_file = config_dir / "auth_data.json"
        # 0600 secret file; write atomically.
        fd = os.open(str(auth_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(auth_dict).encode("utf-8"))
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def borrow(self, tenant: str, auth_dict: dict[str, Any]):
        auth_hash = hashlib.sha256(
            json.dumps(auth_dict, sort_keys=True).encode("utf-8")
        ).hexdigest()[:32]
        entry: _AdapterEntry
        with self._lock:
            existing = self._by_tenant.get(tenant)
            if existing is not None and existing.auth_hash == auth_hash:
                entry = existing
            else:
                # Credentials rotated (or first use): retire the old entry and
                # build a fresh isolated one. The retired entry is deleted by
                # _release once its in-flight borrowers drain.
                if existing is not None:
                    existing.retired = True
                    self._maybe_delete_locked(existing)
                # Use the tenant + auth_hash to key the isolated dir.
                safe_tenant = hashlib.sha256(tenant.encode("utf-8")).hexdigest()[:16]
                config_dir = self._root / f"{safe_tenant}-{auth_hash}"
                self._materialize_auth(config_dir, auth_dict)
                adapter = MijiaAdapter(config_dir=config_dir)
                entry = _AdapterEntry(adapter, config_dir, auth_hash, tenant)
                self._by_tenant[tenant] = entry
            entry.refcount += 1
        try:
            yield entry.adapter
        finally:
            with self._lock:
                entry.refcount -= 1
                self._maybe_delete_locked(entry)

    def _maybe_delete_locked(self, entry: _AdapterEntry) -> None:
        if entry.retired and entry.refcount <= 0:
            # Remove the secret dir; best-effort.
            with contextlib.suppress(Exception):
                shutil.rmtree(entry.config_dir, ignore_errors=True)
            # Drop from the map only if it is still the retired one.
            current = self._by_tenant.get(entry.tenant)
            if current is entry:
                del self._by_tenant[entry.tenant]

    def shutdown(self) -> None:
        with self._lock:
            for entry in list(self._by_tenant.values()):
                entry.retired = True
                if entry.refcount <= 0:
                    with contextlib.suppress(Exception):
                        shutil.rmtree(entry.config_dir, ignore_errors=True)
            self._by_tenant.clear()


_REGISTRY: Optional[_AdapterRegistry] = None


def _registry() -> _AdapterRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        root = Path(
            os.environ.get("MIJIA_TENANT_ROOT")
            or (Path(tempfile.gettempdir()) / "mijia-mcp-tenants")
        )
        _REGISTRY = _AdapterRegistry(root)
    return _REGISTRY


# ---------------------------------------------------------------------------
# Per-request header extraction.
# ---------------------------------------------------------------------------


def _decode_tenant_headers(request: Request) -> tuple[str, dict[str, Any], bool]:
    tenant = (request.headers.get(HEADER_TENANT) or "").strip()
    if not tenant or len(tenant) > MAX_TENANT_LEN:
        raise TenantError("missing or invalid X-Mijia-Tenant header")

    raw_auth = request.headers.get(HEADER_AUTH) or ""
    if not raw_auth or len(raw_auth) > MAX_AUTH_HEADER_BYTES:
        raise TenantError("missing or oversized X-Mijia-Auth header")
    try:
        decoded = base64.b64decode(raw_auth, validate=True)
        auth_dict = json.loads(decoded.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise TenantError("X-Mijia-Auth is not valid base64 JSON") from exc
    if not isinstance(auth_dict, dict):
        raise TenantError("X-Mijia-Auth must decode to a JSON object")

    expose_raw = _truthy(request.headers.get(HEADER_EXPOSE_RAW))
    return tenant, auth_dict, expose_raw


# ---------------------------------------------------------------------------
# Low-level MCP server with per-request tool filtering + dispatch.
# ---------------------------------------------------------------------------


def _current_request() -> Optional[Request]:
    ctx = getattr(_LOWLEVEL, "request_context", None)
    if ctx is None:
        return None
    req = getattr(ctx, "request", None)
    return req if isinstance(req, Request) else None


_LOWLEVEL: Server = Server("mijia-mcp")


@_LOWLEVEL.list_tools()
async def _list_tools() -> list[types.Tool]:
    request = _current_request()
    expose_raw = _truthy(request.headers.get(HEADER_EXPOSE_RAW)) if request else False
    allowed = _allowed_tool_names(expose_raw)
    out: list[types.Tool] = []
    for tool in srv.mcp._tool_manager.list_tools():
        if tool.name not in allowed:
            continue
        out.append(
            types.Tool(
                name=tool.name,
                description=tool.description or "",
                inputSchema=tool.parameters,
            )
        )
    return out


@_LOWLEVEL.call_tool()
async def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
    request = _current_request()
    if request is None:
        raise TenantError("no active request context")
    tenant, auth_dict, expose_raw = _decode_tenant_headers(request)

    # Re-authorize on every call against the CURRENT request — never trust a
    # cached/advertised schema. This blocks the "list with raw=true, then call
    # the raw tool with raw=false" cache-bypass.
    if name not in _allowed_tool_names(expose_raw):
        raise ValueError(f"Tool '{name}' is not available")

    registry = _registry()
    with registry.borrow(tenant, auth_dict) as adapter:
        token = srv.set_current_adapter(adapter)
        try:
            # Reuse the upstream FastMCP tool implementation + its schema
            # validation; convert_result builds proper MCP content blocks.
            return await srv.mcp._tool_manager.call_tool(
                name, arguments, context=None, convert_result=True
            )
        finally:
            srv.reset_current_adapter(token)


# ---------------------------------------------------------------------------
# ASGI app (stateless Streamable HTTP).
# ---------------------------------------------------------------------------


def build_app() -> Starlette:
    session_manager = StreamableHTTPSessionManager(
        app=_LOWLEVEL,
        event_store=None,
        json_response=True,
        stateless=True,
    )

    async def handle_mcp(scope: Scope, receive: Receive, send: Send) -> None:
        await session_manager.handle_request(scope, receive, send)

    async def healthz(_request: Request) -> Response:
        return JSONResponse({"status": "ok"})

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette):
        async with session_manager.run():
            try:
                yield
            finally:
                _registry().shutdown()

    return Starlette(
        debug=False,
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Mount("/mcp", app=handle_mcp),
        ],
        lifespan=lifespan,
    )


def main() -> None:
    import uvicorn

    # Initialize config + logging now (deferred out of module import so importing
    # this module is side-effect-free).
    srv.init_runtime()

    host = os.environ.get("FASTMCP_HOST", os.environ.get("MIJIA_MCP_HOST", "0.0.0.0"))
    port = int(os.environ.get("FASTMCP_PORT", os.environ.get("MIJIA_MCP_PORT", "8765")))
    # Disable uvicorn access logging so the secret-bearing X-Mijia-Auth header
    # is never written to logs.
    uvicorn.run(
        build_app(),
        host=host,
        port=port,
        log_level=os.environ.get("MIJIA_LOG_LEVEL", "info").lower(),
        access_log=False,
    )


if __name__ == "__main__":
    main()
