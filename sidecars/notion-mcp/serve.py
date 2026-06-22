"""Notion MCP sidecar entrypoint (E1: NO front-end code lives here).

This module only builds an ``AdapterConfig`` for the ONE generic MCP-PROXY
adapter (``_mcp_base.proxy.GenericProxyAdapter``, ``lifecycle="shared"``) and
hands it to the single shared front end (``_mcp_base.app.main``). There is no
``StreamableHTTPSessionManager`` / ``@list_tools`` / ``@call_tool`` /
``_AdapterRegistry`` here — those exist exactly once, in ``_mcp_base``.

Backend wiring (see docs/mcp-plugins-batch-integrations-impl-plan.md §4.3):

  * The vendored Node ``@notionhq/notion-mcp-server`` (pinned 2.4.0, see
    UPSTREAM.md) is spawned ONCE by the base as a loopback-only child
    (``127.0.0.1:9766``) with Streamable-HTTP transport and per-request Notion
    token passthrough enabled.
  * Two DISTINCT credentials cross the adapter↔backend loopback link and must
    never be confused (the "double-bearer" hazard, §4.3):
      - the GATEWAY bearer (``--auth-token`` / ``Authorization: Bearer ...``) —
        a random value minted IN-PROCESS here, shared between the spawned child
        and this proxy's outbound MCP client. It authenticates the loopback
        transport. It is NOT the Notion token and is never exposed to Synapse.
      - the per-tenant NOTION integration token (``ntn_...``) — arrives per
        request in the ``Notion-Token`` header from the api and is injected on
        the upstream MCP ``initialize`` (``inject_cred``). The backend's token
        passthrough binds it to that MCP session, which the base's
        per-(tenant, token-hash) registry entry holds for its lifetime.
  * We deliberately do NOT pin ``Notion-Version``: upstream sources it
    per-operation from its OpenAPI spec (page-markdown endpoints need
    2026-03-11 while the rest use 2025-09-03); a fixed header would break the
    endpoints that require the other version. See ``token.notionHeadersForToken``
    in the vendored source, which intentionally omits it.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from _mcp_base.adapter import AdapterConfig, ProxyBackend
from _mcp_base.app import main
from _mcp_base.ssrf import NoEgress

# Loopback port for the vendored Node backend. NEVER published/exposed by the
# container (the Python base on FASTMCP_PORT is the only listener — E1); the api
# reaches this sidecar at the base port, not this inner port.
_BACKEND_HOST = "127.0.0.1"
_BACKEND_PORT = int(os.environ.get("NOTION_BACKEND_PORT", "9766"))
_BACKEND_URL = f"http://{_BACKEND_HOST}:{_BACKEND_PORT}/mcp"

# Absolute path to the vendored Node server's bin. The Dockerfile runs `npm ci`
# under vendor/notion-mcp/, so the pinned package resolves under node_modules.
# Overridable for local runs / tests.
_NOTION_CLI = os.environ.get(
    "NOTION_MCP_CLI",
    str(
        Path(__file__).resolve().parent
        / "vendor"
        / "notion-mcp"
        / "node_modules"
        / "@notionhq"
        / "notion-mcp-server"
        / "bin"
        / "cli.mjs"
    ),
)
_NODE_BIN = os.environ.get("NOTION_NODE_BIN", "node")

# The gateway bearer for the adapter↔backend loopback link. Minted in-process,
# per process, as a random value — NEVER a ${...} api-template placeholder, never
# logged, never sent to Synapse. The SAME value is given to the spawned child
# (--auth-token) and to this proxy's outbound client (Authorization header), so
# the express gateway middleware in the backend accepts our forwarded requests.
_GATEWAY_TOKEN = secrets.token_hex(32)


def _backend_env(_workdir: Path) -> dict[str, str]:
    """Explicit MINIMAL env for the spawned Node child (§2.4 / ratchet 7).

    NEVER inherit the base's full ``os.environ`` (it carries OTEL exporter
    endpoints, ``FASTMCP_*``, ``*_TENANT_ROOT`` and other values the backend has
    no business seeing). Pass only what Node + express need to run:

      * ``PATH``    — to resolve the node runtime / shared libs.
      * ``HOME`` / ``TMPDIR`` — express/node scratch (the auth-token file is NOT
        written because we always pass --auth-token, but keep a sane tmp).
      * ``NODE_ENV=production``.

    Deliberately absent: ``NOTION_TOKEN`` / ``OPENAPI_MCP_HEADERS`` (so the ONLY
    Notion-token source is per-request passthrough), the gateway token (it is on
    the argv, not the env), and every OTEL/FASTMCP/tenant-root variable.
    """
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "NODE_ENV": "production",
    }
    return env


def build_config() -> AdapterConfig:
    return AdapterConfig(
        service_name="notion-mcp",  # OTEL_SERVICE_NAME + low-level Server(name)
        header_prefix="notion",  # derives x-notion-tenant / x-notion-expose-raw
        header_auth_name="notion-token",  # explicit credential header (NOT derived)
        cred_kind="raw_string",  # keeps 16KB cap + CRLF/control-char rejection (§4.2)
        # never_tools: empty — the vendored backend exposes no login/session/meta
        # tool (token passthrough + OpenAPI-derived REST tools only). Confirmed
        # against the pinned 2.4.0 tools/list (buildOrder); revisit on bump.
        never_tools=frozenset(),
        # raw_tools: empty for v1. The vendored 2.4.0 surface is curated
        # OpenAPI-derived Notion REST tools; there is no separate "low-level raw"
        # tier to gate. exposeRawTools remains wired (X-Notion-Expose-Raw) so a
        # future raw tier can be gated without a seed/contract change.
        raw_tools=frozenset(),
        egress_policy=NoEgress(),  # forwards to loopback; the adapter never fetches
        backend=ProxyBackend(
            kind="http",
            lifecycle="shared",  # ONE backend process; per-(tenant,token) upstream session
            command=[
                _NODE_BIN,
                _NOTION_CLI,
                "--transport",
                "http",
                "--enable-token-passthrough",
                "--auth-token",
                _GATEWAY_TOKEN,
                "--host",
                _BACKEND_HOST,
                "--port",
                str(_BACKEND_PORT),
            ],
            backend_env=_backend_env,
            url=_BACKEND_URL,
            # Run a readiness wait after spawn (the base probes ``url``; an
            # unauthenticated GET /mcp returns 400, which means "listening").
            backend_ready_probe=lambda _port: _BACKEND_URL,
            # Per-tenant Notion token -> upstream initialize header. The backend's
            # passthrough binds it to that MCP session.
            inject_cred=lambda raw: {"Notion-Token": raw},
            # The gateway bearer is FIXED on every upstream request: it is the
            # loopback transport credential the express gateway middleware
            # checks. Distinct from the Notion token above (double-bearer).
            fixed_headers={"Authorization": f"Bearer {_GATEWAY_TOKEN}"},
        ),
    )


if __name__ == "__main__":
    main(build_config())
