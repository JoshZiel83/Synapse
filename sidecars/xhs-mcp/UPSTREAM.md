# Upstream provenance — xhs-mcp backend

The Go MCP backend under `vendor/xiaohongshu-mcp/` is a **verbatim vendored
copy** (no source modifications) of
[`xpzouying/xiaohongshu-mcp`](https://github.com/xpzouying/xiaohongshu-mcp),
compiled into the sidecar image and orchestrated as a per-(tenant,cookie)
loopback backend pool by the shared `_mcp_base` proxy adapter
(`lifecycle="per_tenant"`).

- **Vendored at commit (pin):** `ec9b84b88e516e2571eaaea9c59c9e4745df7761`
  (cloned `--depth 1` from `HEAD` on 2026-06-21; `.git` removed; `go.mod` /
  `go.sum` retained).
- **Module path:** `github.com/xpzouying/xiaohongshu-mcp` — `go 1.24.0`
  (build stage MUST use `golang:1.24`+, NOT `golang:1.23`).
- **Synapse-specific changes to the Go source:** **NONE.** We vendor + pin only.
  All multi-tenant behavior is achieved by ORCHESTRATION in `_mcp_base` +
  `adapter/xhs_adapter.py` (spawn N unmodified processes, each its own
  `-port 127.0.0.1:<n>` + `COOKIES_PATH` + `TMPDIR`). No fork.

## ⚠ Upstream LICENSE status (compliance — re-verify before shipping)

**As of the pinned SHA the upstream repo declares NO license** — there is no
`LICENSE` file anywhere in the tree, and the GitHub repo metadata reports
`license: null` (verified 2026-06-21). The batch plan (§7.3) assumed "MIT
LICENSE verbatim"; that assumption is **FALSE** for this repo at this SHA.

We therefore did **NOT** add a fabricated `LICENSE` file (doing so would be
incorrect). Under default copyright, "no license" means the upstream author
retains all rights and there is no grant to redistribute/modify. **Vendoring +
compiling this source has unresolved licensing risk** and must be cleared before
this sidecar is shipped (options: obtain an explicit license/permission from the
author; pin a later SHA that adds a license; or replace the backend). This is an
open compliance item, NOT something the build can paper over.

## Source-level facts re-verified at this SHA (load-bearing for the pool)

Re-verify ALL of these on any SHA bump — they are per-release mutable and the
per-tenant isolation collapses silently if any drifts:

1. **`-port` flag, loopback bind** (`main.go`): `flag.StringVar(&port, "port",
":18060", ...)`; the **entire** `port` string is passed verbatim to
   `appServer.Start(port)` → `http.Server{Addr: port}`. So
   `-port 127.0.0.1:<n>` binds loopback-only. Other flags: `-headless` (bool,
   default `true`), `-bin` (browser binary; env fallback `ROD_BROWSER_BIN`).
   **There is no `--auth-token`-style gateway flag** — the backend is an
   unauthenticated MCP+HTTP server holding a live logged-in session.
2. **`COOKIES_PATH` env + `/tmp` short circuit** (`cookies/cookies.go
GetCookiesFilePath()`): resolution order is
   **`$TMPDIR/cookies.json` (if it exists) → `COOKIES_PATH` env → cwd
   `cookies.json`**. `os.TempDir()` is checked and returned FIRST. `os.TempDir()`
   honors `$TMPDIR` on Linux. → **Each backend MUST get its own `TMPDIR`**
   (a sibling of its `COOKIES_PATH` under the tenant 0700 dir) or a stray
   `$TMPDIR/cookies.json` silently overrides `COOKIES_PATH` and the whole pool
   collapses to one account = cross-tenant credential pollution. Empty
   `COOKIES_PATH` falls back to a bare cwd `cookies.json` (NOT tmp/home) — the
   pool must never leave it unset.
3. **MCP endpoint + health route** (`routes.go`): MCP is `router.Any("/mcp")` +
   `router.Any("/mcp/*path")` (so `/mcp/` works). **Health is `GET /health`**
   (`healthHandler`) — **NOT `/healthz`**. The readiness probe must use
   `/health`.
4. **Tool names** (`mcp_server.go`, verbatim):
   - read: `list_feeds`, `search_feeds`, `get_feed_detail`, `user_profile`
     (the plan marked `list_feeds`/`user_profile` TENTATIVE; both are CONFIRMED
     present at this SHA).
   - write: `publish_content`, `publish_with_video`, `post_comment_to_feed`,
     `reply_comment_in_feed`, `like_feed`, `favorite_feed`.
   - NEVER (login/session/local-state meta — operational, never a model tool):
     `check_login_status`, `get_login_qrcode`, `delete_cookies`.
5. **Browser**: each backend drives its own headless Chromium via go-rod/rod
   (`-headless` default true). Chromium download is a shared cache, not
   per-process; browser RAM is the binding constraint (see
   `XHS_MAX_TENANT_BACKENDS` / `mem_limit` / `shm_size`).

## Threat model (must be stated, not assumed away)

Per-tenant **account** isolation is real (each tenant has its own
process / cookie file / loopback port / 0700 dir). It rests ENTIRELY on:
(i) loopback-only bind (`-port 127.0.0.1:<n>`, verified) and (ii) the
`_mcp_base` proxy being the ONLY client in the container. Because the backend
has **no gateway token**, any co-resident third-party workload in this container
would pierce the isolation. The CI ratchet must assert that no xhs backend port
appears in compose `ports:`/`expose:` (only the base's 8769 is exposed), and the
container must carry no third-party workload. The only remaining residual is the
**shared container egress IP** (all pool backends share it; xhs risk-control caps
~3 accounts/IP, hence `XHS_MAX_TENANT_BACKENDS` default 3); per-account egress IP
(`XHS_PROXY`) is DEFERRED.

## Syncing upstream

On a SHA bump: re-clone, re-diff, re-verify facts 1–5 above (especially the
`/tmp` short circuit, the `-port` verbatim bind, and `/health` vs `/healthz`),
re-run `tools/list` against the pinned backend to lock the tool allowlist, and
**re-check the LICENSE status** (it may have been added/changed).
