"""Low-level MCP ``Server`` wiring: the ``@list_tools`` / ``@call_tool`` handlers
that ``app.py`` mounts (generalized from mijia's http_server dispatch).

The double allowlist lives HERE and is identical for both adapter kinds (the
base owns it; adapters only declare ``never_tools`` / ``raw_tools``):

  * ``@list_tools`` decodes the tenant headers (requiring a valid tenant+cred
    before advertising ANY tool — blocks unauthenticated schema enumeration),
    derives ``expose_raw`` from the AUTHENTICATED request, fetches the backend's
    full catalog via the adapter, and strips NEVER / (RAW unless expose_raw).
  * ``@call_tool`` decodes the headers again and RE-CHECKS the allowlist against
    the current request before dispatching (blocks "list with raw=true, then
    call raw with raw=false").

The low-level ``Server(name)`` is parameterized by ``config.service_name`` — it
must never hardcode a service name (§2.11 ratchet 9).
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, AsyncIterator, Optional

from .adapter import AdapterConfig
from .headers import DecodedHeaders, TenantError, decode_tenant_headers


def allowed_tool_names(
    catalog_names, *, never: frozenset[str], raw: frozenset[str], expose_raw: bool
) -> set[str]:
    """The double-allowlist filter, factored out so it is testable without the
    mcp SDK. Strips NEVER tools always, and RAW tools unless ``expose_raw``."""
    out: set[str] = set()
    for name in catalog_names:
        if name in never:
            continue
        if name in raw and not expose_raw:
            continue
        out.add(name)
    return out


class Dispatcher:
    """Owns the low-level MCP Server + its per-request tool filtering.

    Constructed once per process by ``app.build_app``. Holds a reference to the
    registry (for ``borrow``) and the adapter (for ``list_tools``/``call_tool``).
    """

    def __init__(self, config: AdapterConfig, adapter, registry):
        # Imported lazily so importing this module is cheap and dep-light; the
        # mcp SDK is only needed when actually building the server.
        import mcp.types as types
        from mcp.server.lowlevel import Server

        self._types = types
        self._config = config
        self._adapter = adapter
        self._registry = registry
        self._server: Server = Server(config.service_name)
        self._wire()

    @property
    def server(self):
        return self._server

    def _current_request(self):
        ctx = getattr(self._server, "request_context", None)
        if ctx is None:
            return None
        return getattr(ctx, "request", None)

    def _decode(self) -> DecodedHeaders:
        request = self._current_request()
        if request is None:
            raise TenantError("no active request context")
        return decode_tenant_headers(request.headers, self._config)

    def _allowed(self, catalog_names, expose_raw: bool) -> set[str]:
        return allowed_tool_names(
            catalog_names,
            never=self._config.never_tools,
            raw=self._config.raw_tools,
            expose_raw=expose_raw,
        )

    @contextlib.asynccontextmanager
    async def _borrow(self, decoded: DecodedHeaders) -> "AsyncIterator[Any]":
        """Async wrapper around the SYNCHRONOUS ``registry.borrow`` ctxmgr.

        The borrow's enter (``adapter.build`` — a blocking subprocess.Popen +
        readiness poll for the proxy per_tenant cold path) and exit (blocking
        teardown) are run via ``asyncio.to_thread`` so a booting/teardown of one
        tenant's backend never stalls the single front-end event loop and the
        other tenants' in-flight requests. The adapter ``list_tools`` /
        ``call_tool`` between enter and exit stay on the loop (they already
        offload their own blocking I/O via ``asyncio.to_thread``)."""
        cm = self._registry.borrow(
            decoded.tenant, decoded.cred, decoded.auth_hash
        )
        handle = await asyncio.to_thread(cm.__enter__)
        try:
            yield handle
        except BaseException as exc:
            if not await asyncio.to_thread(cm.__exit__, type(exc), exc, None):
                raise
        else:
            await asyncio.to_thread(cm.__exit__, None, None, None)

    def _wire(self) -> None:
        types = self._types

        @self._server.list_tools()
        async def _list_tools() -> "list[types.Tool]":
            # Require a valid tenant/credential before advertising anything, and
            # derive expose_raw from the authenticated request (not a bare
            # header) so an unauthenticated caller cannot enumerate schemas —
            # including the raw set — by setting the expose-raw header alone.
            decoded = self._decode()
            async with self._borrow(decoded) as handle:
                catalog = await self._adapter.list_tools(
                    handle, expose_raw=decoded.expose_raw
                )
            allowed = self._allowed(
                (t.name for t in catalog), decoded.expose_raw
            )
            return [t for t in catalog if t.name in allowed]

        @self._server.call_tool()
        async def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
            # Re-authorize on every call against the CURRENT request — never
            # trust a cached/advertised schema. Blocks "list with raw=true, then
            # call the raw tool with raw=false".
            decoded = self._decode()
            async with self._borrow(decoded) as handle:
                catalog = await self._adapter.list_tools(
                    handle, expose_raw=decoded.expose_raw
                )
                allowed = self._allowed(
                    (t.name for t in catalog), decoded.expose_raw
                )
                if name not in allowed:
                    raise ValueError(f"Tool '{name}' is not available")
                return await self._adapter.call_tool(handle, name, arguments)
