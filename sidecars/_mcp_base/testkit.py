"""Shared test helpers for the base + concrete sidecars.

Kept dependency-light: importing this module must not require the mcp/uvicorn
runtime (the heavy deps live behind functions in app/dispatch/proxy). The
helpers here let unit tests exercise the registry, headers, allowlist, and the
per_tenant primitives without a live MCP backend.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .adapter import Adapter, AdapterConfig, TenantHandle


class CaseInsensitiveHeaders:
    """Minimal Starlette-like headers: case-insensitive ``.get``."""

    def __init__(self, mapping: Optional[dict] = None):
        self._data = {str(k).lower(): v for k, v in (mapping or {}).items()}

    def get(self, name: str, default=None):
        return self._data.get(str(name).lower(), default)

    def __setitem__(self, name: str, value) -> None:
        self._data[str(name).lower()] = value


@dataclass
class FakeTool:
    """A stand-in for ``mcp.types.Tool`` (only ``.name`` is used by the base)."""

    name: str
    description: str = ""
    inputSchema: dict = field(default_factory=dict)


@dataclass
class RecordingAdapter:
    """An in-memory ``Adapter`` for tests: records builds/closes, serves a fixed
    tool catalog, echoes call arguments. No external dependencies."""

    config: AdapterConfig
    catalog: list[FakeTool] = field(default_factory=list)
    built: list[tuple[str, Any]] = field(default_factory=list)
    closed: list[Path] = field(default_factory=list)

    def build(self, *, tenant: str, cred: Any, workdir: Path) -> TenantHandle:
        # Mirror mijia's 0600 secret-file discipline so isolation tests can
        # assert perms without a real backend.
        import os

        workdir.mkdir(parents=True, exist_ok=True, mode=0o700)
        secret_file = workdir / "auth_data.json"
        payload = json.dumps(cred if isinstance(cred, (dict, list)) else {"raw": cred})
        fd = os.open(str(secret_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, payload.encode("utf-8"))
        finally:
            os.close(fd)
        self.built.append((tenant, cred))
        return TenantHandle(client=secret_file, workdir=workdir)

    async def list_tools(self, handle: TenantHandle, *, expose_raw: bool):
        return list(self.catalog)

    async def call_tool(self, handle: TenantHandle, name: str, arguments: dict[str, Any]):
        return {"tool": name, "arguments": arguments}

    async def aclose(self, handle: TenantHandle) -> None:
        if handle.workdir is not None:
            self.closed.append(handle.workdir)


def make_config(**overrides) -> AdapterConfig:
    """An ``AdapterConfig`` with sane LIB-WRAP defaults for tests."""
    base = dict(
        service_name="test-mcp",
        header_prefix="test",
        header_auth_name="x-test-auth",
        cred_kind="b64_json",
    )
    base.update(overrides)
    return AdapterConfig(**base)


def b64_json_header(obj: dict) -> str:
    import base64

    return base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii")
