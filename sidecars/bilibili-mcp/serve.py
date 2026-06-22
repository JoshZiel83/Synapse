"""Thin entrypoint for the Bilibili MCP sidecar (LIB-WRAP).

E1: this sidecar contributes NO front end. It builds an ``AdapterConfig`` (with a
``BilibiliAdapter`` LIB-WRAP adapter) and hands it to ``_mcp_base.app.main`` — the
ONE Streamable-HTTP front end in the repo. There is no ``http_server.py`` / no
``StreamableHTTPSessionManager`` construction here.

Container CMD: ``python -m serve`` (PYTHONPATH=/app, with ``_mcp_base`` and
``bilibili-mcp`` both copied under /app).
"""

from __future__ import annotations

import os

from _mcp_base.app import main

from adapter.bilibili_adapter import BilibiliAdapter


def build_config():
    adapter = BilibiliAdapter()
    config = adapter.config
    # Wire the adapter object into its config (LIB-WRAP: the base reads
    # config.adapter) and set the per-sidecar tenant root. BILIBILI_TENANT_ROOT
    # MUST be distinct from every other sidecar — the registry rmtree's the
    # whole root on startup, so a shared root would cross-purge (plan §6.3).
    config.adapter = adapter
    config.tenant_root = os.environ.get("BILIBILI_TENANT_ROOT")
    return config


def run() -> None:
    main(build_config())


if __name__ == "__main__":
    run()
