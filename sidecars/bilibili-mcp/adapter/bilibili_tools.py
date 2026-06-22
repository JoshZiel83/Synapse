"""Hand-written tool surface over ``Nemo2011/bilibili-api`` (GPL-3.0).

Per plan §6.4, none of these tools come from a ready-made community MCP server:
every read/write tool here is a thin wrapper this module implements directly on
top of the ``bilibili_api`` library (the only place ``send_danmaku`` /
``send_dynamic`` exist). The catalog returned by :func:`list_tools` is the FULL
surface; the base (``_mcp_base.dispatch``) owns the double allowlist and strips
``never_tools`` / ``raw_tools`` — this module never pre-filters (Adapter
Protocol contract).

Two process-global, tenant-independent settings are applied exactly once at
boot (``boot_global_client``): ``select_client("curl_cffi")`` and
``request_settings.set_enable_fpgen(True)``. These are NOT part of the per-tenant
``Credential`` (they are module/process state), so they are set once and NEVER
mutated per request — mutating them per tenant would leak across tenants
(plan §6.1 CAVEAT / §6.11 process-global-leak risk).

All write tools surface the upstream JSON ``code`` / ``message``: Bilibili
returns ``200`` with an error ``code`` (e.g. missing ``bili_jct`` / wrong CSRF)
rather than an HTTP error, so a naive wrapper would make a failed write look
like a success (plan §6.4 / §6.11 bili_jct-silent-failure).

The ``bilibili_api`` import is LAZY (inside functions) so this module imports —
and ``python -m py_compile`` passes — without the GPL upstream library present;
the dependency is only required at actual tool-call time inside the container.
"""

from __future__ import annotations

import json
import threading
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover - typing only
    import mcp.types as types


# --------------------------------------------------------------------------- #
# Process-global client/fpgen boot (tenant-INDEPENDENT — set once, never per req)
# --------------------------------------------------------------------------- #
_BOOT_LOCK = threading.Lock()
_BOOTED = False


def boot_global_client() -> None:
    """Apply the process-global anti-risk-control client settings exactly once.

    ``select_client("curl_cffi")`` + ``set_enable_fpgen(True)`` are PROCESS-level
    globals in ``bilibili_api`` (NOT attached to any ``Credential``). They must be
    set once at startup and never touched per tenant. Idempotent + thread-safe.
    """
    global _BOOTED
    with _BOOT_LOCK:
        if _BOOTED:
            return
        try:
            import bilibili_api
        except Exception:  # pragma: no cover - dep-deferred (offline build env)
            # The library is installed in the container image; in a build/lint
            # environment without it we simply skip booting. Tool calls will
            # raise a clear ImportError later if it is genuinely missing.
            _BOOTED = True
            return
        # select_client: prefer the curl_cffi HTTP client for TLS/JA3
        # fingerprint generation; plain aiohttp is far more detectable.
        select_client = getattr(bilibili_api, "select_client", None)
        if callable(select_client):
            try:
                select_client("curl_cffi")
            except Exception:  # pragma: no cover - older lib / client missing
                pass
        # Enable fingerprint generation on the shared request settings.
        request_settings = getattr(bilibili_api, "request_settings", None)
        set_fpgen = getattr(request_settings, "set_enable_fpgen", None)
        if callable(set_fpgen):
            try:
                set_fpgen(True)
            except Exception:  # pragma: no cover
                pass
        _BOOTED = True


# --------------------------------------------------------------------------- #
# Tool catalog (names are STABLE; the base double-allowlist gates RAW/NEVER)
# --------------------------------------------------------------------------- #
# Read tools — public-data reads (still authenticated via the cookie Credential).
READ_TOOLS: tuple[str, ...] = (
    "search_video",
    "get_video_info",
    "get_video_comments",
    "get_video_danmaku",
    "get_video_subtitle",
    "get_hot_videos",
    "search_user",
)

# Write tools exposed by default (lower-risk engagement actions). These wrap the
# corresponding ``bilibili_api`` calls and all require ``bili_jct`` (CSRF).
WRITE_TOOLS_DEFAULT: tuple[str, ...] = (
    "send_comment",
    "like_video",
    "pay_video_coin",
    "triple_video",
    "set_video_favorite",
)

# High-risk write tools — gated behind ``exposeRawTools`` via the base's RAW set
# (plan §6.4). Highest ban risk + most custom code.
WRITE_TOOLS_RAW: tuple[str, ...] = (
    "send_danmaku",
    "send_dynamic",
)

ALL_TOOL_NAMES: tuple[str, ...] = (
    READ_TOOLS + WRITE_TOOLS_DEFAULT + WRITE_TOOLS_RAW
)

# Names that perform a write (require bili_jct + per-account write rate-limit).
WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    WRITE_TOOLS_DEFAULT + WRITE_TOOLS_RAW
)


# --------------------------------------------------------------------------- #
# Tool schema catalog (returned to the base; never pre-filtered here)
# --------------------------------------------------------------------------- #
def _tool(name: str, description: str, properties: dict[str, Any], required: list[str]):
    import mcp.types as types

    return types.Tool(
        name=name,
        description=description,
        inputSchema={
            "type": "object",
            "properties": properties,
            "required": required,
        },
    )


_STR = {"type": "string"}
_INT = {"type": "integer"}
_BOOL = {"type": "boolean"}


def build_catalog() -> "list[types.Tool]":
    """Return the FULL tool catalog (read + default-write + raw-write).

    The base strips ``never_tools`` / ``raw_tools`` per the authenticated
    request; this function never pre-filters.
    """
    return [
        # ---- read ----------------------------------------------------------
        _tool(
            "search_video",
            "Search Bilibili videos by keyword.",
            {"keyword": _STR, "page": _INT},
            ["keyword"],
        ),
        _tool(
            "get_video_info",
            "Get metadata for a video by BVID or AVID.",
            {"bvid": _STR, "aid": _INT},
            [],
        ),
        _tool(
            "get_video_comments",
            "Get top-level comments for a video.",
            {"bvid": _STR, "aid": _INT, "page": _INT},
            [],
        ),
        _tool(
            "get_video_danmaku",
            "Get the danmaku (bullet-comment) list for a video page.",
            {"bvid": _STR, "aid": _INT, "page_index": _INT},
            [],
        ),
        _tool(
            "get_video_subtitle",
            "Get subtitle text for a video page (returned as inline text).",
            {"bvid": _STR, "aid": _INT, "page_index": _INT},
            [],
        ),
        _tool(
            "get_hot_videos",
            "Get the currently popular/hot videos.",
            {"page": _INT, "page_size": _INT},
            [],
        ),
        _tool(
            "search_user",
            "Search Bilibili users by keyword.",
            {"keyword": _STR, "page": _INT},
            ["keyword"],
        ),
        # ---- default write -------------------------------------------------
        _tool(
            "send_comment",
            "Post a top-level comment on a video. Requires bili_jct.",
            {"bvid": _STR, "aid": _INT, "text": _STR},
            ["text"],
        ),
        _tool(
            "like_video",
            "Like (or unlike) a video. Requires bili_jct.",
            {"bvid": _STR, "aid": _INT, "like": _BOOL},
            [],
        ),
        _tool(
            "pay_video_coin",
            "Give coin(s) to a video. Requires bili_jct.",
            {"bvid": _STR, "aid": _INT, "num": _INT, "like": _BOOL},
            [],
        ),
        _tool(
            "triple_video",
            "Triple-action (like + coin + favorite) a video. Requires bili_jct.",
            {"bvid": _STR, "aid": _INT},
            [],
        ),
        _tool(
            "set_video_favorite",
            "Add/remove a video to/from favorite folders. Requires bili_jct.",
            {
                "bvid": _STR,
                "aid": _INT,
                "add_media_ids": {"type": "array", "items": _INT},
                "del_media_ids": {"type": "array", "items": _INT},
            },
            [],
        ),
        # ---- raw write (gated behind exposeRawTools) -----------------------
        _tool(
            "send_danmaku",
            "Send a danmaku (bullet comment) onto a video. HIGH ban risk; "
            "requires bili_jct.",
            {"bvid": _STR, "aid": _INT, "text": _STR, "page_index": _INT},
            ["text"],
        ),
        _tool(
            "send_dynamic",
            "Publish a text dynamic (动态) to the account's feed. HIGH ban "
            "risk; requires bili_jct.",
            {"text": _STR},
            ["text"],
        ),
    ]


# --------------------------------------------------------------------------- #
# Tool dispatch (LAZY import of bilibili_api inside each handler)
# --------------------------------------------------------------------------- #
class WriteCredentialError(Exception):
    """Raised when a write tool is invoked without a usable ``bili_jct``."""


def _content(payload: Any) -> "list[types.TextContent]":
    import mcp.types as types

    text = payload if isinstance(payload, str) else json.dumps(
        payload, ensure_ascii=False, default=str
    )
    return [types.TextContent(type="text", text=text)]


def _require_video_id(arguments: dict[str, Any]) -> dict[str, Any]:
    bvid = arguments.get("bvid")
    aid = arguments.get("aid")
    if not bvid and aid in (None, ""):
        raise ValueError("either 'bvid' or 'aid' is required")
    out: dict[str, Any] = {}
    if bvid:
        out["bvid"] = str(bvid)
    if aid not in (None, ""):
        out["aid"] = int(aid)
    return out


def _assert_write_credential(credential: Any) -> None:
    """Reject a write whose Credential lacks ``bili_jct`` (CSRF token).

    Bilibili returns 200-with-error-code for a missing/blank CSRF; failing
    closed here gives the caller a clear error instead of a silent no-op.
    """
    bili_jct = getattr(credential, "bili_jct", None)
    if not bili_jct:
        raise WriteCredentialError(
            "this write requires bili_jct (CSRF token); the connected cookie "
            "is missing it — re-copy the full cookie including bili_jct"
        )


async def call(
    name: str,
    arguments: dict[str, Any],
    *,
    credential: Any,
) -> "list[types.TextContent]":
    """Invoke tool ``name`` against ``credential`` (a per-tenant Credential).

    Imports ``bilibili_api`` lazily; raises ``ImportError`` with a clear message
    if the GPL upstream library is not installed (build/lint env).
    """
    try:
        from bilibili_api import comment, dynamic, hot, search, user, video
    except ImportError as exc:  # pragma: no cover - dep-deferred build env
        raise ImportError(
            "bilibili-api-python is not installed in this environment; the "
            "Bilibili tool surface requires it (see requirements.txt)."
        ) from exc

    handler = _HANDLERS.get(name)
    if handler is None:
        raise ValueError(f"unknown tool: {name!r}")
    modules = {
        "comment": comment,
        "dynamic": dynamic,
        "hot": hot,
        "search": search,
        "user": user,
        "video": video,
    }
    if name in WRITE_TOOL_NAMES:
        _assert_write_credential(credential)
    return await handler(arguments, credential, modules)


# Each handler returns mcp TextContent. Read handlers wrap public reads; write
# handlers surface the upstream JSON code/message verbatim.
async def _h_search_video(args, credential, m):
    res = await m["search"].search_by_type(
        args["keyword"],
        search_type=m["search"].SearchObjectType.VIDEO,
        page=int(args.get("page", 1)),
    )
    return _content(res)


async def _h_get_video_info(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    return _content(await v.get_info())


async def _h_get_video_comments(args, credential, m):
    ids = _require_video_id(args)
    v = m["video"].Video(credential=credential, **ids)
    aid = ids.get("aid") or v.get_aid()
    res = await m["comment"].get_comments(
        oid=int(aid),
        type_=m["comment"].CommentResourceType.VIDEO,
        page_index=int(args.get("page", 1)),
        credential=credential,
    )
    return _content(res)


async def _h_get_video_danmaku(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    danmakus = await v.get_danmakus(page_index=int(args.get("page_index", 0)))
    return _content([str(d) for d in danmakus])


async def _h_get_video_subtitle(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    sub = await v.get_subtitle(page_index=int(args.get("page_index", 0)))
    return _content(sub)


async def _h_get_hot_videos(args, credential, m):
    res = await m["hot"].get_hot_videos(
        pn=int(args.get("page", 1)), ps=int(args.get("page_size", 20))
    )
    return _content(res)


async def _h_search_user(args, credential, m):
    res = await m["search"].search_by_type(
        args["keyword"],
        search_type=m["search"].SearchObjectType.USER,
        page=int(args.get("page", 1)),
    )
    return _content(res)


async def _h_send_comment(args, credential, m):
    ids = _require_video_id(args)
    v = m["video"].Video(credential=credential, **ids)
    aid = ids.get("aid") or v.get_aid()
    res = await m["comment"].send_comment(
        text=args["text"],
        oid=int(aid),
        type_=m["comment"].CommentResourceType.VIDEO,
        credential=credential,
    )
    return _content(res)


async def _h_like_video(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    res = await v.like(status=bool(args.get("like", True)))
    return _content(res)


async def _h_pay_video_coin(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    res = await v.pay_coin(
        num=int(args.get("num", 1)), like=bool(args.get("like", False))
    )
    return _content(res)


async def _h_triple_video(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    res = await v.triple()
    return _content(res)


async def _h_set_video_favorite(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    res = await v.set_favorite(
        add_media_ids=args.get("add_media_ids"),
        del_media_ids=args.get("del_media_ids"),
    )
    return _content(res)


async def _h_send_danmaku(args, credential, m):
    v = m["video"].Video(credential=credential, **_require_video_id(args))
    dm = m["video"].Danmaku(text=args["text"])
    res = await v.send_danmaku(
        page_index=int(args.get("page_index", 0)), danmaku=dm
    )
    return _content(res)


async def _h_send_dynamic(args, credential, m):
    builder = m["dynamic"].BuildDynamic.empty().add_text(args["text"])
    res = await m["dynamic"].send_dynamic(builder, credential=credential)
    return _content(res)


_HANDlerType = Callable[..., Any]
_HANDLERS: dict[str, _HANDlerType] = {
    "search_video": _h_search_video,
    "get_video_info": _h_get_video_info,
    "get_video_comments": _h_get_video_comments,
    "get_video_danmaku": _h_get_video_danmaku,
    "get_video_subtitle": _h_get_video_subtitle,
    "get_hot_videos": _h_get_hot_videos,
    "search_user": _h_search_user,
    "send_comment": _h_send_comment,
    "like_video": _h_like_video,
    "pay_video_coin": _h_pay_video_coin,
    "triple_video": _h_triple_video,
    "set_video_favorite": _h_set_video_favorite,
    "send_danmaku": _h_send_danmaku,
    "send_dynamic": _h_send_dynamic,
}
