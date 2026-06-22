"""小红书 (xhs) adapter wiring — the THIN per-sidecar contribution.

xhs is a GENERIC MCP-PROXY backend with ``lifecycle="per_tenant"`` (E1/E3: the
ONE ``_mcp_base/proxy.py`` implementation, selected purely by the
``ProxyBackend.lifecycle`` *data* field — there is no second proxy class). This
module contributes NO front-end code; it only:

  * builds the declarative ``AdapterConfig`` (``build_config()``) that
    ``serve.py`` hands to ``_mcp_base.app.main`` — wiring the per-tenant pool
    (``spawn_cmd`` for the UNMODIFIED vendored Go binary bound loopback-only,
    ``backend_env`` minimal-whitelist with the ``TMPDIR`` isolation fix,
    ``port_range`` / ``max_backends`` / idle TTL, ``inject_cred=IgnoreCred()``),
    and
  * defines ``XhsProxyAdapter`` — a thin subclass of the base
    ``GenericProxyAdapter`` that adds the publish-media call pre-hook
    (content-ref → SSRF-guarded presigned GET → realpath-fenced temp file under
    the tenant's 0700 ``media-tmp/``) and the ``title<=20`` / ``content<=1000``
    content-limit enforced BEFORE the backend is reached.

The credential reaches the backend via the per-tenant ``COOKIES_PATH`` file (the
base proxy materializes it), never a per-request HTTP header — hence
``inject_cred=IgnoreCred()``.

Source-level facts re-verified against the pinned fork SHA (see ``UPSTREAM.md``):
  * ``main.go``: ``-port`` flag, full string passed verbatim to
    ``http.Server{Addr: port}`` → ``-port 127.0.0.1:<n>`` binds loopback-only.
  * ``cookies/cookies.go GetCookiesFilePath()``: ``$TMPDIR/cookies.json`` is
    checked and returned FIRST (back-compat short circuit) BEFORE
    ``COOKIES_PATH`` → a per-backend ``TMPDIR`` (sibling of ``COOKIES_PATH``,
    not nested) is MANDATORY or the whole pool collapses to one account.
  * ``routes.go``: health endpoint is ``/health`` (NOT ``/healthz``); MCP is at
    ``/mcp`` + ``/mcp/*path`` (so ``/mcp/`` works).
"""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Optional

# Imported from the ONE shared base. ``serve.py`` ensures ``_mcp_base`` is on
# the path (it lives alongside this sidecar in the runtime image at /app).
from _mcp_base.adapter import AdapterConfig, IgnoreCred, ProxyBackend
from _mcp_base.proxy import GenericProxyAdapter
from _mcp_base.ssrf import EgressError, ExactHostAllowlist, NoEgress

# --- xpzouying tool catalog (verbatim from the pinned mcp_server.go) ----------
# NEVER: login/session/local-state meta tools — operational actions, hidden on
# both list AND call by the base double-allowlist.
NEVER_TOOLS = frozenset(
    {"get_login_qrcode", "check_login_status", "delete_cookies"}
)
# Write tools gated behind the ``expose_write`` flag header (default off).
WRITE_TOOLS = frozenset(
    {
        "publish_content",
        "publish_with_video",
        "post_comment_to_feed",
        "reply_comment_in_feed",
        "like_feed",
        "favorite_feed",
    }
)
# Publish tools whose arguments carry tenant-supplied media content refs that
# must be materialized to a local file before the backend can reach them.
_MEDIA_PUBLISH_TOOLS = frozenset({"publish_content", "publish_with_video"})

# Content-limit caps enforced before the backend is reached (xhs note limits).
MAX_TITLE_LEN = 20
MAX_CONTENT_LEN = 1000

# Loopback port pool + chromium-bound concurrency defaults (overridable by env).
_DEFAULT_PORT_LOW = 18060
_DEFAULT_PORT_HIGH = 18159
_DEFAULT_MAX_BACKENDS = 3
_DEFAULT_IDLE_TTL = 1800.0
_DEFAULT_READY_TIMEOUT = 60.0

_BROWSER_BIN = os.environ.get("ROD_BROWSER_BIN", "/usr/bin/chromium")
_BACKEND_BIN = os.environ.get("XHS_BACKEND_BIN", "/app/bin/xiaohongshu-mcp")


def _storage_hosts() -> list[str]:
    """Exact-host allowlist for the tenant-influenceable publish-media GET.

    Sourced from ``XHS_STORAGE_HOSTS`` (comma-separated). Empty → NoEgress
    structural no-op (publish-with-media is then unavailable, fail-closed),
    which matches the ``local_cas``-only deployment where presign is impossible
    anyway (OD-7 HARD dependency on a ``canPresign=true`` backend).
    """
    raw = os.environ.get("XHS_STORAGE_HOSTS", "")
    return [h.strip() for h in raw.split(",") if h.strip()]


def build_config() -> AdapterConfig:
    """Construct the declarative ``AdapterConfig`` for the xhs per-tenant pool.

    Read entirely from env so the same image serves any deployment; the base
    front end consumes these fields and owns the whole request lifecycle.
    """
    hosts = _storage_hosts()
    egress = ExactHostAllowlist(hosts) if hosts else NoEgress()

    port_low = int(os.environ.get("XHS_PORT_LOW", str(_DEFAULT_PORT_LOW)))
    port_high = int(os.environ.get("XHS_PORT_HIGH", str(_DEFAULT_PORT_HIGH)))
    max_backends = int(
        os.environ.get("XHS_MAX_TENANT_BACKENDS", str(_DEFAULT_MAX_BACKENDS))
    )
    idle_ttl = float(
        os.environ.get("XHS_BACKEND_IDLE_TTL_SECONDS", str(_DEFAULT_IDLE_TTL))
    )

    backend = ProxyBackend(
        kind="http",
        # ← The ONLY difference from Notion ("shared"); pure data, not a second
        # proxy implementation.
        lifecycle="per_tenant",
        # Spawn the UNMODIFIED vendored Go binary, bound LOOPBACK-ONLY. The full
        # "127.0.0.1:<port>" string is passed verbatim to http.Server{Addr} by
        # the upstream main.go, so this binds loopback only (no public listener).
        spawn_cmd=lambda port, workdir: [
            _BACKEND_BIN,
            "-port",
            f"127.0.0.1:{port}",
            "-headless",
            "-bin",
            _BROWSER_BIN,
        ],
        # MINIMAL env whitelist — NEVER the full os.environ (§2.4 spawn-env
        # invariant). TMPDIR is a per-backend sibling of COOKIES_PATH: it plugs
        # the GetCookiesFilePath() "$TMPDIR/cookies.json" back-compat short
        # circuit that would otherwise collapse the whole pool to one account.
        backend_env=_backend_env,
        # The upstream MCP endpoint is /mcp (+ /mcp/*path); canonical trailing
        # slash avoids gin's redirect.
        backend_url=lambda port: f"http://127.0.0.1:{port}/mcp/",
        # Readiness: the upstream health route is /health (NOT /healthz) —
        # verified in routes.go at the pinned SHA.
        backend_ready_probe=lambda port: f"http://127.0.0.1:{port}/health",
        port_range=(port_low, port_high),
        max_backends=max_backends,
        backend_idle_ttl=idle_ttl,
        # Cookie reaches the backend via the COOKIES_PATH file the base proxy
        # materializes — NOT a per-request header. Explicit sentinel (not a
        # falsy None) per the §2.11 ratchet-6 invariant.
        inject_cred=IgnoreCred(),
        fixed_headers={},
    )

    return AdapterConfig(
        adapter=None,  # MCP-PROXY: base constructs the proxy adapter from backend
        service_name="xhs-mcp",
        header_prefix="xhs",  # derives x-xhs-tenant / x-xhs-expose-write
        header_auth_name="x-xhs-cookie",  # explicit cred header (cookie semantic)
        cred_kind="raw_string",  # X-Xhs-Cookie is an opaque cookie string
        cred_required_keys=(),
        never_tools=NEVER_TOOLS,
        raw_tools=WRITE_TOOLS,  # base hides these unless expose_write is set
        flag_headers={"expose_raw": "x-xhs-expose-write"},
        egress_policy=egress,
        backend=backend,
        tenant_root=os.environ.get("XHS_TENANT_ROOT", "/data/tenants"),
    )


def _backend_env(workdir: Path) -> dict[str, str]:
    """Minimal per-backend env. NEVER inherits the full os.environ.

    COOKIES_PATH and TMPDIR are siblings under the tenant 0700 workdir (TMPDIR
    not nested in COOKIES_PATH and vice-versa) so a stray ``$TMPDIR/cookies.json``
    can never alias COOKIES_PATH. HOME is the workdir so rod/chromium has a
    writable, per-backend cache dir.
    """
    return {
        "COOKIES_PATH": str(workdir / "cookies.json"),
        "TMPDIR": str(workdir / "tmp"),
        "ROD_BROWSER_BIN": _BROWSER_BIN,
        "HOME": str(workdir),
        # XHS_PROXY intentionally omitted — per-account egress IP is DEFERRED.
    }


# --- field names carrying tenant-supplied media content refs -----------------
# The seed accepts image/video as Synapse content refs (CAS blob id /
# presigned URL); we look for any of these argument keys on a publish call.
_IMAGE_REF_KEYS = ("images", "image_refs", "imageUrls", "image_urls", "images_ref")
_VIDEO_REF_KEYS = ("video", "video_ref", "videoUrl", "video_url")
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


class XhsProxyAdapter(GenericProxyAdapter):
    """Thin proxy subclass adding the publish-media pre-hook + content limits.

    Everything else (per-tenant spawn/route/teardown, list_tools, aclose) is the
    base ``GenericProxyAdapter`` unchanged. ``call_tool`` is the ONLY override:
    it enforces content limits and materializes media refs into a realpath-fenced
    temp file under the tenant's 0700 ``media-tmp/`` (SSRF-guarded) before
    forwarding to the loopback backend, then best-effort deletes them after.
    """

    async def call_tool(
        self, handle: Any, name: str, arguments: dict[str, Any]
    ) -> Any:
        if name in WRITE_TOOLS:
            self._enforce_content_limits(name, arguments)
        if name in _MEDIA_PUBLISH_TOOLS:
            media_dir = self._tenant_media_dir(handle)
            staged: list[Path] = []
            try:
                arguments = self._materialize_media(
                    arguments, media_dir, staged
                )
                return await super().call_tool(handle, name, arguments)
            finally:
                for path in staged:
                    try:
                        path.unlink()
                    except OSError:
                        pass
        return await super().call_tool(handle, name, arguments)

    # ------------------------------------------------------------- cookie file
    def _materialize_cred(self, cred: Any, workdir: Path) -> None:
        """Write the per-tenant cookie as the go-rod JSON cookie ARRAY the
        vendored xpzouying backend expects — NOT a raw ``k=v; k2=v2`` string.

        The upstream persists cookies as ``json.Marshal([]*proto.NetworkCookie)``
        (service.go saveCookies) and feeds the file verbatim into go-rod
        ``WithCookies`` (browser/browser.go:62), which unmarshals a JSON array of
        cookie objects. The base default ``_materialize_cred`` writes the raw
        Cookie-header string, which deserializes to nothing → the headless browser
        starts UNAUTHENTICATED and every per-tenant backend silently runs
        logged-out. So xhs overrides it to emit the array shape.

        NOTE (flagged alongside the UPSTREAM.md LICENSE blocker): the exact field
        set go-rod requires (domain vs url, secure/httpOnly/expires) must be
        confirmed with a live round-trip through the real backend loader before
        xhs is relied on; this writes the minimal {name,value,domain,path}. A user
        who pastes the rod-exported JSON array directly is passed through verbatim.
        """
        if not isinstance(cred, str) or not cred:
            return
        stripped = cred.strip()
        if stripped.startswith("["):
            payload = stripped.encode("utf-8")
        else:
            cookies = [
                {
                    "name": name,
                    "value": value,
                    "domain": ".xiaohongshu.com",
                    "path": "/",
                }
                for name, value in self._parse_cookie_pairs(stripped)
            ]
            payload = json.dumps(cookies).encode("utf-8")
        cookie_path = workdir / "cookies.json"
        fd = os.open(
            str(cookie_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)

    @staticmethod
    def _parse_cookie_pairs(raw: str) -> list[tuple[str, str]]:
        """Parse a ``k=v; k2=v2`` Cookie string (or a JSON object) into
        ``(name, value)`` pairs, tolerating either input shape."""
        raw = raw.strip()
        if raw.startswith("{"):
            try:
                obj = json.loads(raw)
            except ValueError:
                obj = None
            if isinstance(obj, dict):
                return [
                    (str(k), str(v)) for k, v in obj.items() if v is not None
                ]
        pairs: list[tuple[str, str]] = []
        for part in raw.split(";"):
            if "=" not in part:
                continue
            name, _, value = part.partition("=")
            name = name.strip()
            if name:
                pairs.append((name, value.strip()))
        return pairs

    # ------------------------------------------------------------------ limits
    @staticmethod
    def _enforce_content_limits(name: str, arguments: dict[str, Any]) -> None:
        title = arguments.get("title")
        if isinstance(title, str) and len(title) > MAX_TITLE_LEN:
            raise ValueError(
                f"title exceeds {MAX_TITLE_LEN} characters ({len(title)})"
            )
        content = arguments.get("content")
        if isinstance(content, str) and len(content) > MAX_CONTENT_LEN:
            raise ValueError(
                f"content exceeds {MAX_CONTENT_LEN} characters ({len(content)})"
            )

    # ------------------------------------------------------------------- media
    def _tenant_media_dir(self, handle: Any) -> Path:
        workdir = getattr(handle, "workdir", None)
        if workdir is None:
            raise ValueError("xhs media publish requires a tenant workdir")
        media_dir = Path(workdir) / "media-tmp"
        media_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        return media_dir

    def _materialize_media(
        self,
        arguments: dict[str, Any],
        media_dir: Path,
        staged: list[Path],
    ) -> dict[str, Any]:
        """Replace content-ref/URL media args with local temp file paths.

        Only http(s) URL refs are downloaded (through the SSRF egress policy);
        non-URL values are passed through untouched (already a local path the
        backend can read, or a CAS id the upstream is given as-is in deployments
        that don't presign). Each download lands in ``media-tmp/`` with a
        proxy-generated filename and is realpath-fenced to that directory.
        """
        out = dict(arguments)
        for key in _IMAGE_REF_KEYS:
            if key in out:
                out[key] = self._materialize_value(out[key], media_dir, staged)
        for key in _VIDEO_REF_KEYS:
            if key in out:
                out[key] = self._materialize_value(out[key], media_dir, staged)
        return out

    def _materialize_value(
        self, value: Any, media_dir: Path, staged: list[Path]
    ) -> Any:
        if isinstance(value, str):
            return self._maybe_download(value, media_dir, staged)
        if isinstance(value, (list, tuple)):
            return [
                self._maybe_download(v, media_dir, staged)
                if isinstance(v, str)
                else v
                for v in value
            ]
        return value

    def _maybe_download(
        self, ref: str, media_dir: Path, staged: list[Path]
    ) -> str:
        if not _URL_RE.match(ref):
            # Not a URL — leave as-is (local path / CAS id resolved upstream).
            return ref
        return str(self._download(ref, media_dir, staged))

    def _download(self, url: str, media_dir: Path, staged: list[Path]) -> Path:
        """SSRF-guarded presigned GET into a realpath-fenced temp file.

        The egress policy is checked on the initial URL AND re-checked on every
        redirect hop. The destination filename is proxy-generated (never derived
        from the URL/content-ref) and verified via realpath to live inside
        ``media-tmp/`` (blocks traversal / symlink escape toward cookies.json).
        """
        import urllib.request

        policy = self.config.egress_policy
        if isinstance(policy, NoEgress):
            raise EgressError(
                "xhs publish-with-media requires a presign-capable content "
                "backend and an XHS_STORAGE_HOSTS allowlist (local_cas-only "
                "deployments cannot presign)"
            )

        dest = (media_dir / uuid.uuid4().hex).resolve()
        media_root = media_dir.resolve()
        # Realpath fence: dest must be strictly inside media-tmp/.
        if media_root not in dest.parents and dest != media_root:
            raise EgressError("computed media path escaped media-tmp/")

        current = url
        opener = urllib.request.build_opener(_NoRedirect())
        for _hop in range(_MAX_REDIRECTS + 1):
            policy.assert_allowed(current)
            req = urllib.request.Request(current, method="GET")
            try:
                resp = opener.open(req, timeout=_DOWNLOAD_TIMEOUT)  # noqa: S310
            except urllib.error.HTTPError as exc:
                # 3xx surfaces here because redirects are disabled; follow once
                # we've re-checked the target against the egress policy.
                if exc.code in (301, 302, 303, 307, 308):
                    location = exc.headers.get("Location")
                    if not location:
                        raise EgressError("redirect without Location")
                    current = _resolve_redirect(current, location)
                    continue
                raise
            with resp:
                fd = os.open(
                    str(dest),
                    os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
                    0o600,
                )
                try:
                    while True:
                        chunk = resp.read(_CHUNK)
                        if not chunk:
                            break
                        os.write(fd, chunk)
                finally:
                    os.close(fd)
            staged.append(dest)
            # Final realpath fence after the file exists (defeat symlink swap).
            real = dest.resolve()
            if media_root not in real.parents:
                try:
                    dest.unlink()
                finally:
                    staged.remove(dest)
                raise EgressError("materialized media escaped media-tmp/")
            return dest
        raise EgressError("too many redirects")


_MAX_REDIRECTS = 5
_DOWNLOAD_TIMEOUT = 30.0
_CHUNK = 64 * 1024


def _resolve_redirect(base: str, location: str) -> str:
    from urllib.parse import urljoin

    return urljoin(base, location)


class _NoRedirect:
    """A urllib handler that turns 3xx into HTTPError instead of auto-following,
    so the egress policy can re-check each hop (DenyPrivateNetworks weakness +
    SSRF-via-redirect defense)."""

    def http_error_301(self, req, fp, code, msg, headers):  # noqa: D401
        from urllib.error import HTTPError

        raise HTTPError(req.full_url, code, msg, headers, fp)

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


# Late import so module import stays cheap and dep-light for unit tests.
import urllib.error  # noqa: E402
