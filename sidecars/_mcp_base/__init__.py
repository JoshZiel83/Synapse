"""``_mcp_base`` — the ONE multi-tenant Streamable-HTTP front end for all
Synapse mcp-plugin sidecars (E1: exactly one front-end implementation in the
whole repo).

Each concrete sidecar is a THIN package: it fills an ``AdapterConfig`` (with
either a LIB-WRAP ``Adapter`` or a ``ProxyBackend``) and calls
``_mcp_base.app.main(config)``. It contributes NO front-end code.

This package is a library; it is not built into a deployable image itself.
"""

from __future__ import annotations

from .adapter import (
    Adapter,
    AdapterConfig,
    IgnoreCred,
    ProxyBackend,
    TenantHandle,
)
from .headers import TenantError
from .process import BackendPoolExhausted
from .ssrf import (
    DenyPrivateNetworks,
    EgressError,
    EgressPolicy,
    ExactHostAllowlist,
    NoEgress,
)

__all__ = [
    "Adapter",
    "AdapterConfig",
    "ProxyBackend",
    "TenantHandle",
    "IgnoreCred",
    "BackendPoolExhausted",
    "TenantError",
    "EgressPolicy",
    "EgressError",
    "NoEgress",
    "ExactHostAllowlist",
    "DenyPrivateNetworks",
]
