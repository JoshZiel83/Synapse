"""``BilibiliAdapter`` — a LIB-WRAP adapter (E3.a) implementing the
``_mcp_base.adapter.Adapter`` Protocol over ``Nemo2011/bilibili-api`` (GPL-3.0).

Per-(tenant, cookie-hash) isolation is REAL, not a logical label: the registry
hands ``build()`` the rendered cookie string and an isolated 0700 workdir; this
adapter parses the cookie into a fresh per-instance ``Credential`` (the upstream
library's isolation boundary — attached to each ``video.Video(...)`` /
``comment`` call). There is no shared mutable account state between tenants.

Two upstream settings are PROCESS-global (not part of ``Credential``):
``select_client("curl_cffi")`` and ``request_settings.set_enable_fpgen(True)``.
They are applied ONCE at boot via ``bilibili_tools.boot_global_client`` and never
touched per tenant — mutating them per request would leak across tenants
(plan §6.1 CAVEAT / §6.11). Per-account differences live ONLY in the per-instance
``Credential`` + the per-handle rate limiter.

The ``bilibili_api`` import is LAZY (inside ``build`` / tool call) so this module
imports and ``python -m py_compile`` passes without the GPL upstream present.

No secret is written to disk: the cookie lives only in the in-memory
``Credential`` (unlike mijia, which caches ``auth_data.json``). The 0700 workdir
is still provided by the registry and used only for ephemeral scratch.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

# Import the base contract relative to ``sidecars/`` on PYTHONPATH (same import
# root the container uses: ``COPY sidecars/_mcp_base`` + ``COPY
# sidecars/bilibili-mcp`` under /app, PYTHONPATH=/app).
from _mcp_base.adapter import AdapterConfig, TenantHandle
from _mcp_base.ssrf import ExactHostAllowlist

from . import bilibili_tools

if TYPE_CHECKING:  # pragma: no cover - typing only
    import mcp.types as types


# Bilibili API hosts the adapter may legitimately reach. Net-new exact-host
# allowlist (plan §2.3/E5): v1 has no tenant-influenceable download path, so the
# SSRF guard is near-structural here, but it is wired so a future download tool
# inherits a fail-closed allowlist rather than allow-all.
BILIBILI_EGRESS_HOSTS: frozenset[str] = frozenset(
    {
        "api.bilibili.com",
        "app.bilibili.com",
        "passport.bilibili.com",
        "api.vc.bilibili.com",
        "api.live.bilibili.com",
        "comment.bilibili.com",
        "www.bilibili.com",
        "bilibili.com",
        "data.bilibili.com",
    }
)


# Per-account write caps (plan §6.8 — conservative defaults; owner tunes lower
# before production). Read interval is also throttled with jitter.
_DEFAULT_WRITE_INTERVAL_S = 60.0
_DEFAULT_READ_INTERVAL_S = 2.0
_QUARANTINE_S = 30 * 60.0  # captcha / -412 cooldown


class RateLimited(Exception):
    """Raised when a per-account rate-limit / quarantine blocks a call."""


class _TokenBucketLimiter:
    """Per-account min-interval limiter with a captcha/-412 quarantine.

    Lives on the per-(tenant, cookie-hash) handle; its lifetime is tied to that
    handle (idle-TTL retire resets the in-memory counters — accepted v1, see
    plan §6.8 limiter-lifetime gotcha).
    """

    def __init__(
        self,
        *,
        write_interval: float = _DEFAULT_WRITE_INTERVAL_S,
        read_interval: float = _DEFAULT_READ_INTERVAL_S,
        quarantine_s: float = _QUARANTINE_S,
    ):
        self._write_interval = write_interval
        self._read_interval = read_interval
        self._quarantine_s = quarantine_s
        self._lock = threading.Lock()
        self._last_write = 0.0
        self._last_read = 0.0
        self._quarantined_until = 0.0

    def quarantine(self) -> None:
        with self._lock:
            self._quarantined_until = time.monotonic() + self._quarantine_s

    def check(self, *, is_write: bool) -> None:
        """Raise ``RateLimited`` if this call must be blocked right now."""
        now = time.monotonic()
        with self._lock:
            if now < self._quarantined_until:
                remaining = int(self._quarantined_until - now)
                raise RateLimited(
                    f"account quarantined after captcha/-412; retry in "
                    f"~{remaining}s"
                )
            interval = self._write_interval if is_write else self._read_interval
            last = self._last_write if is_write else self._last_read
            if last and now - last < interval:
                wait = round(interval - (now - last), 1)
                raise RateLimited(
                    f"per-account rate limit: wait ~{wait}s before the next "
                    f"{'write' if is_write else 'read'}"
                )
            if is_write:
                self._last_write = now
            else:
                self._last_read = now


# Cookie keys mapped onto the upstream ``Credential(...)`` constructor.
_COOKIE_KEYS: tuple[str, ...] = (
    "sessdata",
    "bili_jct",
    "buvid3",
    "dedeuserid",
    "ac_time_value",
)


def _parse_cookie(raw: str) -> dict[str, str]:
    """Parse the rendered cookie credential into a key->value dict.

    Tolerates BOTH shapes the seed allows (plan §6.1):
      * a cookie string ``"SESSDATA=...; bili_jct=...; buvid3=..."``
      * a JSON object ``{"SESSDATA": "...", "bili_jct": "..."}``
    Keys are normalized to lower-case so ``SESSDATA`` / ``sessdata`` /
    ``DedeUserID`` all map onto the ``Credential`` kwargs.
    """
    raw = (raw or "").strip()
    parsed: dict[str, str] = {}
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
        except ValueError:
            obj = None
        if isinstance(obj, dict):
            for key, value in obj.items():
                if value is None:
                    continue
                parsed[str(key).strip().lower()] = str(value).strip()
            return parsed
    # Cookie-pair string: "k=v; k2=v2".
    for pair in raw.split(";"):
        if "=" not in pair:
            continue
        key, _, value = pair.partition("=")
        key = key.strip().lower()
        if key:
            parsed[key] = value.strip()
    return parsed


def _build_credential(raw: str) -> Any:
    """Construct a fresh per-instance ``bilibili_api.Credential`` from a cookie.

    Lazy import: raises ``ImportError`` with a clear message if the GPL upstream
    library is not installed (build/lint env).
    """
    try:
        from bilibili_api import Credential
    except ImportError as exc:  # pragma: no cover - dep-deferred build env
        raise ImportError(
            "bilibili-api-python is not installed; the Bilibili adapter "
            "requires it (see requirements.txt)."
        ) from exc
    fields = _parse_cookie(raw)
    return Credential(
        sessdata=fields.get("sessdata"),
        bili_jct=fields.get("bili_jct"),
        buvid3=fields.get("buvid3"),
        dedeuserid=fields.get("dedeuserid"),
        ac_time_value=fields.get("ac_time_value"),
    )


class _BilibiliClient:
    """The in-process per-tenant handle payload: a Credential + a rate limiter.

    Stored on ``TenantHandle.client``. Statefulness lives HERE behind the
    registry, never in the stateless front-end session manager (§4.3).
    """

    __slots__ = ("credential", "limiter", "workdir")

    def __init__(self, credential: Any, limiter: _TokenBucketLimiter, workdir: Path):
        self.credential = credential
        self.limiter = limiter
        self.workdir = workdir


def _is_risk_control_error(exc: BaseException) -> bool:
    """Heuristic: does this upstream error indicate captcha / -412 risk control?"""
    text = str(exc).lower()
    if "-412" in text or "412" in text and "risk" in text:
        return True
    return any(token in text for token in ("captcha", "geetest", "风控", "请求被拦截"))


class BilibiliAdapter:
    """LIB-WRAP adapter over ``Nemo2011/bilibili-api`` (GPL-3.0).

    Implements the ``_mcp_base.adapter.Adapter`` Protocol. The base owns the
    front end, the registry, header decoding, and the double allowlist; this
    adapter only declares wiring (via :meth:`config`) and owns
    build/list/call/close.
    """

    SERVICE_NAME = "bilibili-mcp"

    def __init__(self) -> None:
        # Apply the process-global client/fpgen settings exactly once at
        # construction (tenant-independent; safe to call repeatedly).
        bilibili_tools.boot_global_client()
        self.config = self._build_config()

    # ------------------------------------------------------------------ wiring
    @staticmethod
    def _build_config() -> AdapterConfig:
        return AdapterConfig(
            adapter=None,  # set by serve.py after construction (avoids self-ref)
            service_name=BilibiliAdapter.SERVICE_NAME,
            header_prefix="bili",  # -> x-bili-tenant
            header_auth_name="x-bili-cookie",  # explicit cred header (cookie semantic)
            cred_kind="raw_string",
            cred_required_keys=("SESSDATA", "bili_jct"),
            # The seed forwards the gate as X-Bili-Expose-Write (config key
            # exposeWriteTools). Remap the "expose_raw" flag onto that exact
            # header so the seed toggle actually reaches the base's RAW gate;
            # without this the base would derive x-bili-expose-raw (never sent)
            # and the raw write tools would be permanently hidden. Mirrors the
            # xhs adapter's flag_headers={"expose_raw": "x-xhs-expose-write"}.
            flag_headers={"expose_raw": "x-bili-expose-write"},
            # NEVER: no login/session/download tool exists; declare an explicit
            # (empty) set. RAW gates ALL write tools (comment/coin/like/favorite/
            # triple AND danmaku/dynamic) behind X-Bili-Expose-Write, so the
            # seed's "write tools off by default" consent UI holds: a
            # side-effecting write (pay_video_coin spends coins, send_comment
            # posts publicly) must never fire unless the user explicitly opted in.
            never_tools=frozenset(),
            raw_tools=frozenset(
                bilibili_tools.WRITE_TOOLS_DEFAULT + bilibili_tools.WRITE_TOOLS_RAW
            ),
            egress_policy=ExactHostAllowlist(BILIBILI_EGRESS_HOSTS),
            tenant_root=None,  # set by serve.py from BILIBILI_TENANT_ROOT
        )

    # ------------------------------------------------------------------- build
    def build(self, *, tenant: str, cred: Any, workdir: Path) -> TenantHandle:
        """Construct a fresh per-(tenant, cookie-hash) Credential + limiter.

        ``cred`` is the raw cookie STRING (``cred_kind="raw_string"``). No secret
        is written to disk; the cookie lives only in the in-memory Credential.
        """
        raw = cred if isinstance(cred, str) else str(cred)
        credential = _build_credential(raw)
        limiter = _TokenBucketLimiter()
        client = _BilibiliClient(credential, limiter, workdir)
        return TenantHandle(client=client, workdir=workdir)

    # -------------------------------------------------------------- list/call
    async def list_tools(
        self, handle: TenantHandle, *, expose_raw: bool
    ) -> "list[types.Tool]":
        # Return the FULL catalog; the base strips NEVER/RAW per the
        # authenticated request (never pre-filter here).
        return bilibili_tools.build_catalog()

    async def call_tool(
        self, handle: TenantHandle, name: str, arguments: dict[str, Any]
    ) -> Any:
        client: _BilibiliClient = handle.client
        is_write = name in bilibili_tools.WRITE_TOOL_NAMES
        client.limiter.check(is_write=is_write)
        try:
            return await bilibili_tools.call(
                name, arguments or {}, credential=client.credential
            )
        except BaseException as exc:
            # Quarantine the account on a risk-control signal so subsequent
            # calls fast-fail rather than hammering Bilibili into a harder ban.
            if _is_risk_control_error(exc):
                client.limiter.quarantine()
            raise

    # ----------------------------------------------------------------- close
    async def aclose(self, handle: TenantHandle) -> None:
        # No external resource to release: the Credential is plain in-memory
        # state and the registry rmtrees the 0700 workdir. Drop references.
        handle.client = None
