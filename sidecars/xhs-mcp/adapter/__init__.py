"""xhs-mcp adapter wiring (the thin per-sidecar contribution)."""

from .xhs_adapter import (
    NEVER_TOOLS,
    WRITE_TOOLS,
    XhsProxyAdapter,
    build_config,
)

__all__ = ["build_config", "XhsProxyAdapter", "NEVER_TOOLS", "WRITE_TOOLS"]
