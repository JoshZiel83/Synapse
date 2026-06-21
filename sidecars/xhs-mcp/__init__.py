"""xhs-mcp sidecar — 小红书 (Xiaohongshu) read+write via the ONE shared
``_mcp_base`` front end + the generic MCP-PROXY adapter in
``lifecycle="per_tenant"`` mode, orchestrating per-(tenant,cookie) UNMODIFIED
vendored Go ``xpzouying/xiaohongshu-mcp`` backends bound loopback-only.

Thin package: ``serve.py`` (builds the AdapterConfig + calls
``_mcp_base.app.main``) + ``adapter/`` (per_tenant wiring + publish pre-hook) +
``vendor/xiaohongshu-mcp/`` (pinned Go source; see ``UPSTREAM.md``). No
front-end code lives here.
"""
