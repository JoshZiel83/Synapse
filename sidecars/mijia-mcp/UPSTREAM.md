# Upstream provenance

This directory is a **fork** of [`javen-yan/miot-mcp`](https://github.com/javen-yan/miot-mcp),
vendored into the Synapse monorepo as a containerized sidecar.

- **Forked from commit:** `080ec75` (`Merge pull request #7 from javen-yan/mijia-api-3`)
- **Upstream license:** MIT (see `LICENSE`, retained verbatim).
- **Underlying library:** [`mijiaAPI`](https://github.com/Do1e/mijia-api) (the
  fork wraps it; QR login, RC4 signing, and miot-spec parsing live there — we
  deliberately do NOT re-implement them).

## Synapse-specific changes vs upstream

1. **Multi-tenant Streamable HTTP** (`mcp_server/http_server.py`, new): upstream
   is stdio + single global account. We added a stateless Streamable-HTTP front
   end on the low-level `mcp.server.lowlevel.Server` +
   `StreamableHTTPSessionManager(stateless=True)`.
2. **Per-request credentials**: each request carries the Xiaomi auth dict in the
   `X-Mijia-Auth` header (base64 of the upstream mijiaAPI canonical dict) and the
   tenant id in `X-Mijia-Tenant`. There is no baked-in account.
3. **Per-tenant isolation**: `MijiaAdapter.__init__(config_dir=...)` now accepts
   an isolated auth directory; the HTTP layer caches one adapter per
   `(tenant, auth-hash)` with refcount + retire-then-delete so credential
   rotation/eviction never cuts off an in-flight call, and secret dirs (0700,
   `auth_data.json` 0600) are removed once idle. The module-global `_adapter`
   singleton is gone in the multi-tenant path (contextvar-bound per request).
4. **No import side effects**: config loading + file logging moved out of module
   top-level into `init_runtime()`; importing the server no longer touches
   `~/.miot-mcp` or creates `run.log`.
5. **Tool allowlist**: login/session/local-state tools
   (`prepare_login`, `clear_saved_login`, `reconnect_service`,
   `get_service_status`) and the `get_tool_catalog` meta-tool are never exposed;
   raw/low-level tools are gated behind `X-Mijia-Expose-Raw`. The allowlist is
   enforced on both `tools/list` AND `tools/call` (so a cached schema cannot be
   used to bypass it).
6. **No resources**: upstream `@mcp.resource` endpoints are not registered by the
   HTTP front end.

Login (QR) is handled on the **Synapse side** (the `mijia_qr_login` auth driver),
which produces the canonical auth dict that is forwarded here per request. This
sidecar only consumes credentials; it does not run the QR onboarding flow.

## Syncing upstream

When pulling upstream changes, re-apply the items above (they are localized to
`mcp_server/http_server.py`, the `get_adapter`/`init_runtime` changes in
`mcp_server/mcp_server.py`, and the `config_dir` parameter in
`adapter/mijia_adapter.py`) and re-verify the pinned versions in
`requirements.txt` against the low-level SDK API.
