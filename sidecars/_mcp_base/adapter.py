"""The adapter contract: the *only* per-backend extension point.

`_mcp_base` owns the entire multi-tenant Streamable-HTTP front end (E1: there is
exactly one front-end implementation in the whole repo). A concrete sidecar
contributes a single small ``Adapter`` + a declarative ``AdapterConfig``; it
contributes NO front-end code.

Two adapter KINDS are supported by this one codebase, and they implement the
same ``Adapter`` Protocol:

  * LIB-WRAP  — an in-process Python client (mijia, bilibili). ``build()``
    materializes credentials into a per-tenant 0700 workdir and constructs an
    in-process client handle.
  * MCP-PROXY — ``proxy.py``'s single generic proxy adapter (Notion, xhs). It
    is an MCP *client* to a vendored backend MCP server and an MCP *server* to
    Synapse. Its backend lifecycle ("shared" vs "per_tenant") is a *data field*
    on ``AdapterConfig`` — NOT a second implementation (E3).

The base reads ``header_auth_name`` to find the credential header and
``header_prefix`` to derive the tenant / flag header names; the two are
decoupled (a Notion credential header is ``Notion-Token`` — no ``X-``/``-Auth``
— while xhs is ``X-Xhs-Cookie``; both still derive ``X-<Name>-Tenant`` from the
prefix).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Literal,
    Optional,
    Protocol,
    runtime_checkable,
)

from .ssrf import EgressPolicy, NoEgress

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids importing mcp at module load
    import mcp.types as types

# How the credential header is parsed.
#   b64_json    — base64 of a JSON object (mijia's X-Mijia-Auth).
#   raw_string  — an opaque token / cookie string (Notion / bilibili / xhs).
CredKind = Literal["b64_json", "raw_string"]

# Backend lifecycle for the MCP-PROXY adapter. Data, not a second class:
#   shared      — ONE persistent backend process; one upstream MCP session per
#                 (tenant, cred-hash), credential injected on initialize.
#   per_tenant  — a BackendProcessPool: one lazily-spawned backend child per
#                 (tenant, cred-hash) bound to a unique loopback port.
Lifecycle = Literal["shared", "per_tenant"]


class IgnoreCred:
    """Explicit sentinel for ``ProxyBackend.inject_cred``.

    Used by ``lifecycle="per_tenant"`` backends (xhs) that receive credentials
    via on-disk files / env, NOT via a per-request HTTP header. It is a *named*
    sentinel rather than a falsy ``None`` so a future cookie-capable backend
    cannot silently drop credentials by leaving ``inject_cred`` unset (see the
    §2.11 ratchet-6 invariant).
    """

    __slots__ = ()

    def __call__(self, raw: str) -> dict[str, str]:  # pragma: no cover - never injects
        return {}

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return "IgnoreCred()"


# An InjectCred maps the rendered per-request credential string to the header(s)
# injected on the upstream initialize (shared lifecycle), or is IgnoreCred().
InjectCred = Callable[[str], dict[str, str]]


@dataclass
class ProxyBackend:
    """Backend wiring for the generic MCP-PROXY adapter (``proxy.py``).

    ``lifecycle`` selects between the two MODES of the *one* proxy
    implementation; there is no second proxy class.
    """

    kind: Literal["http", "stdio"] = "http"
    lifecycle: Lifecycle = "shared"

    # --- lifecycle="shared" (Notion): one backend process, spawned once. ------
    url: Optional[str] = None
    command: Optional[list[str]] = None
    inject_cred: InjectCred = field(default_factory=IgnoreCred)
    fixed_headers: dict[str, str] = field(default_factory=dict)

    # --- lifecycle="per_tenant" (xhs): one loopback child per (tenant,cred). --
    # (port, workdir) -> argv for the UNMODIFIED upstream binary, bound
    # loopback-only (127.0.0.1:<port>).
    spawn_cmd: Optional[Callable[[int, Path], list[str]]] = None
    # (workdir) -> explicit minimal env allowlist for the child (NEVER the full
    # os.environ — see §2.4 spawn-env invariant).
    backend_env: Optional[Callable[[Path], dict[str, str]]] = None
    # (port) -> "http://127.0.0.1:{port}/mcp/"
    backend_url: Optional[Callable[[int], str]] = None
    # (port) -> readiness probe URL polled after spawn.
    backend_ready_probe: Optional[Callable[[int], str]] = None
    # Loopback port allocation pool [low, high].
    port_range: Optional[tuple[int, int]] = None
    # Hard cap on concurrent backends (resource + anti-risk-control constraint).
    max_backends: Optional[int] = None
    # Idle-eviction seconds for per-tenant backends.
    backend_idle_ttl: Optional[float] = None


@dataclass
class AdapterConfig:
    """Static, declarative wiring filled by each sidecar's ``serve.py``.

    The base reads these to run the entire front end; the adapter object only
    owns backend-specific build/list/call/close logic.
    """

    # The adapter implementation (LIB-WRAP) OR None when a proxy backend is set
    # (MCP-PROXY: the base constructs the one generic proxy adapter from
    # ``backend``).
    adapter: Optional["Adapter"] = None

    service_name: str = "mcp"  # OTEL_SERVICE_NAME default + low-level Server(name)

    header_prefix: str = ""  # "xhs" -> derives X-Xhs-Tenant / X-Xhs-Expose-Raw
    header_auth_name: str = ""  # EXPLICIT credential header name (not derived)

    cred_kind: CredKind = "raw_string"
    cred_required_keys: tuple[str, ...] = ()  # e.g. bilibili ("SESSDATA","bili_jct")

    never_tools: frozenset[str] = frozenset()  # login/session/meta: hidden on list AND call
    raw_tools: frozenset[str] = frozenset()  # low-level tools gated by expose_raw

    # Logical flag -> header name. Only "expose_raw" is consumed by the base
    # today; declared as a dict so adapters can add more without a base change.
    flag_headers: dict[str, str] = field(default_factory=dict)

    egress_policy: EgressPolicy = field(default_factory=NoEgress)

    # MCP-PROXY backend wiring (None for LIB-WRAP adapters).
    backend: Optional[ProxyBackend] = None

    # Per-tenant secret root; the registry rmtree+mkdir(0700) purges it on
    # startup. MUST be distinct per sidecar (see §2.11 ratchet 8).
    tenant_root: Optional[str] = None

    def tenant_header(self) -> str:
        return f"x-{self.header_prefix}-tenant"

    def expose_raw_header(self) -> str:
        return self.flag_headers.get(
            "expose_raw", f"x-{self.header_prefix}-expose-raw"
        )


@dataclass
class TenantHandle:
    """Opaque per-(tenant,cred) handle owned by an ``_AdapterEntry``.

    LIB-WRAP stores its in-process client in ``client``; MCP-PROXY stores its
    upstream session and, for per_tenant, the backend ``port``/``url``/``pid``.
    Statefulness lives HERE, behind the registry — never in the front-end
    stateless session manager (§4.3).
    """

    client: Any = None  # LIB-WRAP in-process client (e.g. MijiaAdapter)
    session: Any = None  # MCP-PROXY upstream MCP ClientSession
    port: Optional[int] = None  # per_tenant backend loopback port
    url: Optional[str] = None  # per_tenant backend MCP url
    pid: Optional[int] = None  # per_tenant backend child pid
    workdir: Optional[Path] = None
    extra: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class Adapter(Protocol):
    """The per-backend interface. Implemented by LIB-WRAP adapters and by the
    one generic MCP-PROXY adapter (``proxy.GenericProxyAdapter``)."""

    config: AdapterConfig

    def build(
        self, *, tenant: str, cred: Any, workdir: Path
    ) -> TenantHandle:
        """Materialize credentials into ``workdir`` (0700) and construct the
        per-(tenant,cred) backend handle. Called under the registry lock by
        ``_AdapterRegistry.borrow``."""
        ...

    async def list_tools(
        self, handle: TenantHandle, *, expose_raw: bool
    ) -> "list[types.Tool]":
        """Return the backend's full tool catalog. The BASE strips
        NEVER/RAW — the adapter must not pre-filter (the base owns the double
        allowlist for both adapter kinds)."""
        ...

    async def call_tool(
        self, handle: TenantHandle, name: str, arguments: dict[str, Any]
    ) -> Any:
        """Invoke ``name`` on the backend. The base has already re-checked the
        allowlist against the authenticated request before calling this."""
        ...

    async def aclose(self, handle: TenantHandle) -> None:
        """Release the backend (proxy: close the upstream session; per_tenant:
        terminate the child + reclaim the port)."""
        ...
