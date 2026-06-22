"""The mijia LIB-WRAP ``Adapter`` for the shared ``_mcp_base`` front end (E2).

This is the ONLY mijia-specific extension point left after the migration: the
~421-line bespoke ``mcp_server/http_server.py`` (its registry / build_app /
dispatch / header-decode) was deleted and re-homed into ``_mcp_base``. mijia now
contributes a single small ``Adapter`` whose three hooks wrap the UNCHANGED
``MijiaAdapter`` + the UNCHANGED FastMCP tool surface in ``mcp_server.mcp_server``.

Contract (see ``_mcp_base.adapter.Adapter``):

  * ``build(tenant, cred, workdir)`` — ``cred`` is the decoded ``X-Mijia-Auth``
    JSON dict (``cred_kind="b64_json"``; the base already base64-decoded +
    json.loads'd it). We materialize it to ``workdir/auth_data.json`` (0600,
    filename mijiaAPI-mandated) and construct a per-(tenant,cred) isolated
    ``MijiaAdapter(config_dir=workdir)``. Whether the api filled the header via
    ``${auth_b64:mijiaAccount}`` (QR login) or a ``${config}`` token is invisible
    here — the base hands us the same decoded dict either way (E2).
  * ``list_tools(handle, expose_raw)`` — return the backend's FULL catalog as
    ``types.Tool``; the BASE owns the NEVER/RAW double allowlist, so we never
    pre-filter (matches the old http_server's ``_list_tools`` Tool shape exactly:
    ``name`` / ``description or ""`` / ``inputSchema=tool.parameters``).
  * ``call_tool(handle, name, arguments)`` — VERBATIM preserve the contextvar
    bridge: ``set_current_adapter(handle.client)`` -> ``_tool_manager.call_tool(
    name, arguments, context=None, convert_result=True)`` -> ``reset``. The
    ``convert_result=True`` builds proper MCP content blocks and reuses the
    upstream FastMCP schema validation; dropping it breaks both.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from _mcp_base.adapter import AdapterConfig, TenantHandle

from adapter.mijia_adapter import MijiaAdapter
from mcp_server import mcp_server as srv

if TYPE_CHECKING:  # pragma: no cover - typing only
    import mcp.types as types


class MijiaLibAdapter:
    """LIB-WRAP ``Adapter`` over the in-process ``MijiaAdapter`` + FastMCP tools.

    Stateless except for ``config``; the per-(tenant,cred) ``MijiaAdapter``
    instance lives on the ``TenantHandle`` the registry caches, never here, so
    there is no shared mutable global adapter (cross-tenant state bleed is the
    thing this prevents).
    """

    def __init__(self, config: AdapterConfig):
        self.config = config
        # Initialize config + file/stderr logging once (deferred out of import so
        # importing this module is side-effect-free). Idempotent.
        srv.init_runtime()

    # ------------------------------------------------------------------ build
    def build(self, *, tenant: str, cred: Any, workdir: Path) -> TenantHandle:
        """Materialize the decoded auth dict + construct the per-tenant client.

        ``cred`` is the decoded JSON object from ``X-Mijia-Auth`` (the base parsed
        ``cred_kind="b64_json"``). The workdir was created 0700 by the registry.
        """
        if not isinstance(cred, dict):
            # Defensive: the base guarantees a dict for b64_json, but never trust
            # a non-dict into the mijiaAPI auth file.
            raise ValueError("mijia credential must decode to a JSON object")
        # mijiaAPI / AuthDataManager read this EXACT filename; do not change it.
        auth_file = workdir / "auth_data.json"
        # 0600 secret file; write atomically over an os.open'd fd.
        fd = os.open(str(auth_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(cred).encode("utf-8"))
        finally:
            os.close(fd)
        client = MijiaAdapter(config_dir=workdir)
        return TenantHandle(client=client, workdir=workdir)

    # ------------------------------------------------------------- list/call
    async def list_tools(
        self, handle: TenantHandle, *, expose_raw: bool
    ) -> "list[types.Tool]":
        """Return the backend's FULL tool catalog (base strips NEVER/RAW).

        The catalog is static (the FastMCP ``@mcp.tool`` registrations are
        process-global), so we read it from ``srv.mcp._tool_manager`` without
        needing the per-tenant client.
        """
        import mcp.types as types

        out: list[types.Tool] = []
        for tool in srv.mcp._tool_manager.list_tools():
            out.append(
                types.Tool(
                    name=tool.name,
                    description=tool.description or "",
                    inputSchema=tool.parameters,
                )
            )
        return out

    async def call_tool(
        self, handle: TenantHandle, name: str, arguments: dict[str, Any]
    ) -> Any:
        """Dispatch ``name`` through the upstream FastMCP tool manager bound to
        the per-request adapter via the contextvar bridge.

        This wrapping is LOAD-BEARING and preserved verbatim from the old
        http_server ``_call_tool``: ``set_current_adapter`` binds
        ``handle.client`` so every ``get_adapter()`` inside the tool body resolves
        to THIS tenant's client; ``convert_result=True`` runs the upstream schema
        validation + builds MCP content blocks; ``reset`` unbinds on the way out.
        """
        token = srv.set_current_adapter(handle.client)
        try:
            return await srv.mcp._tool_manager.call_tool(
                name, arguments, context=None, convert_result=True
            )
        finally:
            srv.reset_current_adapter(token)

    # ----------------------------------------------------------------- close
    async def aclose(self, handle: TenantHandle) -> None:
        """Release the per-tenant client.

        The registry rmtrees the 0700 workdir (and thus ``auth_data.json``) after
        this returns. ``MijiaAdapter`` holds an in-process mijiaAPI client with no
        OS handles requiring an explicit async teardown, so this is a structural
        no-op; the contextvar is per-call (set/reset inside ``call_tool``) so
        nothing leaks across the handle's lifetime.
        """
        return None
