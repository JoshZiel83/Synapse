# Upstream provenance

This sidecar is a **LIB-WRAP** (E3.a): it wraps the upstream Python library
[`Nemo2011/bilibili-api`](https://github.com/Nemo2011/bilibili-api) in-process.
It does NOT vendor a Node/Go MCP backend (there is no `vendor/` subtree and no
MCP-PROXY); the upstream is installed from PyPI as `bilibili-api-python`.

- **Upstream library:** `Nemo2011/bilibili-api`
  ([PyPI `bilibili-api-python`](https://pypi.org/project/bilibili-api-python/))
- **Pinned version:** `bilibili-api-python==17.1.1` (see `requirements.txt`;
  re-verify on bump — the **wbi mixin-key rotation** lives in this library and is
  the #1 breakage point, so a pin + the health self-test are load-bearing).
- **Upstream license:** **GPL-3.0** (`GNU General Public License v3.0`). The full
  text is retained verbatim in `LICENSE` in this directory.
- **What lives upstream (we do NOT re-implement):** wbi signing, the
  `Credential` model, the HTTP client selection (`curl_cffi`) + fingerprint
  generation (`fpgen`), and the entire `video` / `comment` / `dynamic` / `search`
  / `hot` / `user` API surface.

## GPL-3.0 acceptance — arms-length process isolation (F2, locked-in accept)

**Decision (locked, F2): accept `Nemo2011/bilibili-api` (GPL-3.0) as this
sidecar's upstream library.** `adapter/bilibili_tools.py` imports it, so this
sidecar is a **GPL-3.0 derivative work**. It is distributed and run as an
**independent, arms-length process**:

- The GPL code lives **only** inside this independently deployed
  `sidecars/bilibili-mcp/` process. Its **only** interface to the Synapse
  monorepo (MIT/Apache) is **MCP over HTTP** through the shared base front end
  (`_mcp_base`, `:8768/mcp/`). There is **no source-level link** and **no
  in-process bundle** into any proprietary / license-incompatible code.
- GPL-3.0 copyleft propagates along the **link / distribution** boundary; an
  arms-length independent process communicating over MCP/HTTP does NOT pull the
  monorepo into the GPL derivative.
- **PROHIBITED:** bundling `bilibili-api-python` or `adapter/bilibili_tools.py`
  into any proprietary in-process bundle (e.g. the `device-runtime` or `api`
  process). It may run **only** as this standalone sidecar.
- **env double-gate:** `MCP_ENABLE_BILIBILI` + `BILIBILI_MCP_URL` guarantee a
  deployment that has not opted in never surfaces this sidecar.

This is the same process-isolation conclusion as the Xiaohongshu sidecar
(vendored Go backend via the generic MCP-proxy), reached by a different
mechanism — here the GPL boundary is "independent sidecar process + MCP/HTTP
protocol surface".

## Synapse-specific changes vs upstream

`Nemo2011/bilibili-api` is a plain Python library with no server. Everything
server-/multi-tenant-side is Synapse-authored on top of the shared base:

1. **Shared multi-tenant Streamable-HTTP front end** (`_mcp_base`, not in this
   directory): the one stateless `StreamableHTTPSessionManager` front end +
   `_AdapterRegistry` (refcount / retire / startup-purge / idle-TTL) +
   `decode_tenant_headers` + the `tools/list` & `tools/call` double allowlist +
   `access_log=False` + OTLP continuation. This sidecar contributes NO front end.
2. **`BilibiliAdapter`** (`adapter/bilibili_adapter.py`): a LIB-WRAP adapter that
   parses the per-request cookie credential (`X-Bili-Cookie`) into a fresh
   per-instance `Credential` — real per-(tenant, cookie-hash) isolation, since
   the upstream library's isolation boundary is the `Credential` object.
3. **Process-global vs per-tenant split**: `select_client("curl_cffi")` and
   `request_settings.set_enable_fpgen(True)` are applied **once at boot**
   (`adapter/bilibili_tools.boot_global_client`) and **never** mutated per
   tenant — they are process globals; mutating them per request would leak across
   tenants. Per-account differences live only in the per-instance `Credential`
   and the per-handle rate limiter.
4. **Hand-written tool surface** (`adapter/bilibili_tools.py`): read +
   default-write + raw-write wrappers directly over the library (no ready-made
   community server provides this set). High-risk `send_danmaku` / `send_dynamic`
   are placed in the adapter's `raw_tools` set and gated behind
   `exposeRawTools`.
5. **Write-credential assertion**: write tools assert `bili_jct` (CSRF) and
   surface the upstream JSON `code` / `message`. Bilibili returns
   `200`-with-error-code for a missing/blank CSRF, so a naive wrapper would make a
   failed write look like a success.
6. **Per-account rate limiting + risk-control quarantine**: a per-handle
   token-bucket (min-interval) limiter with a captcha/-412 cooldown
   (`_TokenBucketLimiter`); a flagged cookie is quarantined and subsequent calls
   fast-fail.
7. **SSRF egress guard**: an exact-host allowlist (`ExactHostAllowlist`) of
   Bilibili hosts is wired (near-structural in v1 — no tenant-influenceable
   download path — but inherited fail-closed by any future download tool).
8. **No secret on disk**: unlike mijia (which caches `auth_data.json`), the cookie
   lives only in the in-memory `Credential`; the registry's 0700 workdir is used
   only for ephemeral scratch.
9. **Binary exclusion (v1)**: no video/subtitle-as-file download tool (avoids
   ffmpeg / multi-GB blobs / local-path issues); reads return JSON/inline text.

## Syncing upstream

On a `bilibili-api-python` bump: re-pin in `requirements.txt`, re-verify the
wbi-signing path still works via the health self-test (cheap authenticated read),
and confirm the tool wrappers in `adapter/bilibili_tools.py` still match the
library's `video` / `comment` / `dynamic` / `search` / `hot` / `user` signatures.
Re-confirm the GPL-3.0 `LICENSE` is still the upstream's verbatim text.
