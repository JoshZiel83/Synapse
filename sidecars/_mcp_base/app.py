"""THE one front end (E1): the only place in the whole repo that constructs a
``StreamableHTTPSessionManager`` (CI ratchet 1).

``build_app(config)`` returns the Starlette app:
  * ``StreamableHTTPSessionManager(stateless=True, json_response=True,
    event_store=None)`` — the Synapse-facing transport is stateless for every
    sidecar; any backend statefulness is sealed behind the registry/adapter
    handle, never leaked into this manager (§4.3).
  * ``Route("/healthz", GET) -> {"status":"ok"}``
  * ``Mount("/mcp", ...)`` — canonical URL carries a trailing slash (``/mcp/``)
    to avoid Starlette's 307 on a bare ``/mcp``.
  * ``lifespan`` runs ``session_manager.run()`` and shuts the registry down.

``main()`` runs uvicorn with ``access_log=False`` (security-critical: the
secret-bearing credential / cookie header is never written to logs) and host/port
from ``FASTMCP_HOST`` / ``FASTMCP_PORT``.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from pathlib import Path
from typing import Optional

from .adapter import AdapterConfig


def _build_registry(config: AdapterConfig):
    """Construct the one registry for ``config``, choosing LIB-WRAP vs the
    generic MCP-PROXY adapter purely by whether ``config.backend`` is set."""
    from .registry import _AdapterRegistry

    root = Path(
        config.tenant_root
        or os.environ.get("MCP_TENANT_ROOT")
        or (Path(tempfile.gettempdir()) / f"{config.service_name}-tenants")
    )

    if config.backend is not None:
        # MCP-PROXY: the base constructs the ONE generic proxy adapter; its
        # lifecycle ("shared"/"per_tenant") is a data field, not a second class.
        from .proxy import GenericProxyAdapter

        # Seam: a sidecar MAY pre-supply a GenericProxyAdapter *subclass* via
        # `config.adapter` (e.g. xhs overrides call_tool to materialize publish
        # media before forwarding). A subclass adds a hook, NOT a second front
        # end or a second proxy implementation, so E1/E3 hold; it must still BE a
        # GenericProxyAdapter so the registry's bind_registry/aclose_sync wiring
        # is unchanged. Otherwise the base constructs the default proxy adapter.
        if config.adapter is not None:
            adapter = config.adapter
            if not isinstance(adapter, GenericProxyAdapter):
                raise ValueError(
                    "config.adapter for a proxy backend must subclass "
                    "GenericProxyAdapter (one proxy implementation; E3)"
                )
        else:
            adapter = GenericProxyAdapter(config)
        port_range = (
            config.backend.port_range
            if config.backend.lifecycle == "per_tenant"
            else None
        )
        max_backends = (
            config.backend.max_backends
            if config.backend.lifecycle == "per_tenant"
            else None
        )
        idle_ttl = (
            config.backend.backend_idle_ttl
            if config.backend.lifecycle == "per_tenant"
            else None
        )
        registry = _AdapterRegistry(
            root,
            adapter,
            idle_ttl=idle_ttl,
            max_backends=max_backends,
            port_range=port_range,
            aclose_handle=adapter.aclose_sync,
        )
        adapter.bind_registry(registry)
        return adapter, registry

    # LIB-WRAP: the adapter is supplied directly.
    adapter = config.adapter
    if adapter is None:
        raise ValueError("AdapterConfig requires either `adapter` or `backend`")
    registry = _AdapterRegistry(root, adapter)
    return adapter, registry


def build_app(config: AdapterConfig):
    """Build the Starlette app for ``config`` (the one front end)."""
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, Response
    from starlette.routing import Mount, Route

    from .dispatch import Dispatcher
    from .tracing import instrument_app, setup_tracing

    # OTLP tracing: no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
    setup_tracing(default_service_name=config.service_name)

    adapter, registry = _build_registry(config)
    dispatcher = Dispatcher(config, adapter, registry)

    session_manager = StreamableHTTPSessionManager(
        app=dispatcher.server,
        event_store=None,
        json_response=True,
        stateless=True,
    )

    async def handle_mcp(scope, receive, send) -> None:
        await session_manager.handle_request(scope, receive, send)

    async def healthz(_request: Request) -> Response:
        return JSONResponse({"status": "ok"})

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette):
        async with session_manager.run():
            try:
                yield
            finally:
                registry.shutdown()

    app = Starlette(
        debug=False,
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Mount("/mcp", app=handle_mcp),
        ],
        lifespan=lifespan,
    )
    # Each request becomes a span continuing the api-injected traceparent.
    instrument_app(app)
    return app


def main(config: AdapterConfig) -> None:
    """Run uvicorn for ``config``. ``access_log=False`` is security-critical."""
    import uvicorn

    host = os.environ.get("FASTMCP_HOST", "0.0.0.0")
    port = int(os.environ.get("FASTMCP_PORT", "8765"))
    log_level = os.environ.get(
        f"{config.header_prefix.upper()}_LOG_LEVEL",
        os.environ.get("MCP_LOG_LEVEL", "info"),
    ).lower()
    # Disable uvicorn access logging so the secret-bearing credential / cookie
    # header is never written to logs.
    uvicorn.run(
        build_app(config),
        host=host,
        port=port,
        log_level=log_level,
        access_log=False,
    )
