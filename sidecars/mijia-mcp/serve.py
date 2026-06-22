"""mijia-mcp container entry point (E2): the thin ``serve.py`` over ``_mcp_base``.

Run as ``python -m serve`` (the Dockerfile CMD). This module builds the static
``AdapterConfig`` wiring for mijia and hands it to the ONE shared front end
(``_mcp_base.app.main``); it constructs NO front end of its own (E1).

The old ``mcp_server/http_server.py`` (~421 lines of registry / build_app /
dispatch / header-decode) is DELETED — that logic now lives in ``_mcp_base`` and
mijia keeps only ``MijiaLibAdapter`` (the LIB-WRAP adapter) + the unchanged
``MijiaAdapter`` + FastMCP tool surface.

Header / env compatibility with the seed (``builtin-plugins/mijia/index.ts``) is
deliberately lockstep-unchanged:
  * ``X-Mijia-Auth``    (b64 JSON of the mijiaAPI canonical auth dict)
  * ``X-Mijia-Tenant``  (the installation id; derived from ``header_prefix``)
  * ``X-Mijia-Expose-Raw`` (gates the raw-tool set; derived from ``header_prefix``)
so ``${auth_b64:mijiaAccount}`` / ``${runtime:installationId}`` /
``${config:exposeRawMiotTools}`` in the seed entryPoint keep working verbatim.

``MIJIA_LOG_LEVEL`` is still honored: the base reads
``f"{header_prefix.upper()}_LOG_LEVEL"`` = ``MIJIA_LOG_LEVEL`` for uvicorn.
"""

from __future__ import annotations

import os

from _mcp_base.adapter import AdapterConfig
from _mcp_base.app import main as base_main
from _mcp_base.ssrf import NoEgress

from adapter.mijia_lib_adapter import MijiaLibAdapter

# Login / session / meta tools: hidden on BOTH list AND call (the base owns this
# allowlist). These manage account binding / local QR state and must never be
# reachable in the multi-tenant deployment — credentials are pushed per request,
# not negotiated in-band. ``get_tool_catalog`` is excluded because it would
# re-advertise the NEVER set.
MIJIA_NEVER_TOOLS = frozenset(
    {
        "prepare_login",
        "clear_saved_login",
        "reconnect_service",
        "get_service_status",
        "get_tool_catalog",
    }
)


def build_config() -> AdapterConfig:
    """Construct the static mijia ``AdapterConfig`` (LIB-WRAP, lifecycle N/A)."""
    config = AdapterConfig(
        service_name="mijia-mcp",
        header_prefix="mijia",  # derives X-Mijia-Tenant / X-Mijia-Expose-Raw
        header_auth_name="x-mijia-auth",  # explicit credential header
        cred_kind="b64_json",  # base64 of the mijiaAPI canonical auth JSON dict
        never_tools=MIJIA_NEVER_TOOLS,
        raw_tools=frozenset(),  # the friendly-tool-only build exposes no raw tools
        egress_policy=NoEgress(),  # mijia makes no tenant-influenceable fetch
        tenant_root=os.environ.get("MIJIA_TENANT_ROOT"),
    )
    # The LIB-WRAP adapter is supplied directly (no ProxyBackend).
    config.adapter = MijiaLibAdapter(config)
    return config


def main() -> None:
    base_main(build_config())


if __name__ == "__main__":
    main()
