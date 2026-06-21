"""Header decode + double-allowlist tests (dependency-light: no mcp runtime)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _mcp_base.adapter import AdapterConfig  # noqa: E402
from _mcp_base.dispatch import allowed_tool_names  # noqa: E402
from _mcp_base.headers import (  # noqa: E402
    MAX_AUTH_HEADER_BYTES,
    TenantError,
    decode_tenant_headers,
)
from _mcp_base.testkit import CaseInsensitiveHeaders, b64_json_header, make_config  # noqa: E402


def test_b64_json_credential_decode():
    cfg = make_config()  # cred_kind=b64_json, prefix=test, auth=x-test-auth
    auth = b64_json_header({"serviceToken": "t"})
    h = CaseInsensitiveHeaders(
        {"X-Test-Tenant": "inst", "X-Test-Auth": auth, "X-Test-Expose-Raw": "1"}
    )
    decoded = decode_tenant_headers(h, cfg)
    assert decoded.tenant == "inst"
    assert decoded.cred == {"serviceToken": "t"}
    assert decoded.expose_raw is True
    assert len(decoded.auth_hash) == 32


def test_raw_string_credential_decode_and_required_keys():
    cfg = AdapterConfig(
        service_name="bili-mcp",
        header_prefix="bili",
        header_auth_name="x-bili-cookie",
        cred_kind="raw_string",
        cred_required_keys=("SESSDATA", "bili_jct"),
    )
    good = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": "SESSDATA=a; bili_jct=b"}
    )
    decoded = decode_tenant_headers(good, cfg)
    assert decoded.cred == "SESSDATA=a; bili_jct=b"

    missing = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": "SESSDATA=a"}
    )
    try:
        decode_tenant_headers(missing, cfg)
        raised = False
    except TenantError:
        raised = True
    assert raised, "missing required cookie key must raise"


def test_raw_string_required_keys_case_insensitive_and_json():
    # The bilibili adapter advertises tolerance for lowercase cookie keys and a
    # JSON object shape; the header gate must accept both (not fail-closed on a
    # legitimately-formatted credential).
    cfg = AdapterConfig(
        header_prefix="bili",
        header_auth_name="x-bili-cookie",
        cred_kind="raw_string",
        cred_required_keys=("SESSDATA", "bili_jct"),
    )
    # Lowercase cookie-pair string.
    lower = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": "sessdata=a; bili_jct=b"}
    )
    assert decode_tenant_headers(lower, cfg).cred == "sessdata=a; bili_jct=b"
    # JSON object shape.
    js = '{"sessdata":"a","bili_jct":"b"}'
    jheaders = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": js}
    )
    assert decode_tenant_headers(jheaders, cfg).cred == js
    # Still fails closed when a required key is genuinely absent.
    bad = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": "sessdata=a"}
    )
    try:
        decode_tenant_headers(bad, cfg)
        raised = False
    except TenantError:
        raised = True
    assert raised, "a genuinely missing required key must still raise"


def test_raw_string_rejects_crlf_control_chars():
    cfg = AdapterConfig(
        header_prefix="x", header_auth_name="x-x-auth", cred_kind="raw_string"
    )
    bad = CaseInsensitiveHeaders(
        {"X-X-Tenant": "inst", "X-X-Auth": "tok\r\nX-Injected: 1"}
    )
    try:
        decode_tenant_headers(bad, cfg)
        raised = False
    except TenantError:
        raised = True
    assert raised, "CRLF in credential header must be rejected (header injection)"


def test_missing_or_oversized_headers_rejected():
    cfg = make_config()
    # Missing tenant.
    try:
        decode_tenant_headers(CaseInsensitiveHeaders({"X-Test-Auth": "x"}), cfg)
        m = False
    except TenantError:
        m = True
    assert m
    # Oversized auth.
    big = "A" * (MAX_AUTH_HEADER_BYTES + 1)
    try:
        decode_tenant_headers(
            CaseInsensitiveHeaders({"X-Test-Tenant": "i", "X-Test-Auth": big}), cfg
        )
        o = False
    except TenantError:
        o = True
    assert o


def test_double_allowlist_strips_never_and_gates_raw():
    never = frozenset({"prepare_login", "get_tool_catalog"})
    raw = frozenset({"send_danmaku"})
    catalog = ["search_video", "prepare_login", "send_danmaku", "get_tool_catalog"]
    # expose_raw False: never gone, raw gated out.
    no_raw = allowed_tool_names(catalog, never=never, raw=raw, expose_raw=False)
    assert no_raw == {"search_video"}
    # expose_raw True: raw allowed, never still gone.
    with_raw = allowed_tool_names(catalog, never=never, raw=raw, expose_raw=True)
    assert with_raw == {"search_video", "send_danmaku"}


def test_header_names_derive_from_prefix_and_explicit_auth():
    cfg = AdapterConfig(header_prefix="notion", header_auth_name="notion-token")
    assert cfg.tenant_header() == "x-notion-tenant"
    assert cfg.expose_raw_header() == "x-notion-expose-raw"
    # Credential header is explicit, NOT prefix-derived.
    assert cfg.header_auth_name == "notion-token"


def test_flag_headers_override_remaps_expose_raw():
    # When a sidecar's seed sends a differently-named expose flag (bilibili's
    # X-Bili-Expose-Write, xhs's X-Xhs-Expose-Write), the adapter remaps the
    # logical "expose_raw" flag onto that header via flag_headers so the seed
    # toggle actually reaches the base gate. A drift (seed renamed, adapter
    # flag_headers not updated) would silently pin the RAW tools off forever.
    cfg = AdapterConfig(
        header_prefix="bili",
        header_auth_name="x-bili-cookie",
        flag_headers={"expose_raw": "x-bili-expose-write"},
    )
    assert cfg.expose_raw_header() == "x-bili-expose-write"
    # The base reads that exact header to derive expose_raw on the request.
    on = CaseInsensitiveHeaders(
        {
            "X-Bili-Tenant": "inst",
            "X-Bili-Cookie": "SESSDATA=a; bili_jct=b",
            "X-Bili-Expose-Write": "true",
        }
    )
    cfg = AdapterConfig(
        header_prefix="bili",
        header_auth_name="x-bili-cookie",
        cred_kind="raw_string",
        cred_required_keys=("SESSDATA", "bili_jct"),
        flag_headers={"expose_raw": "x-bili-expose-write"},
    )
    assert decode_tenant_headers(on, cfg).expose_raw is True
    off = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": "SESSDATA=a; bili_jct=b"}
    )
    assert decode_tenant_headers(off, cfg).expose_raw is False


def test_bilibili_seed_header_matches_adapter_expose_gate():
    """End-to-end: the bilibili adapter's effective expose_raw header equals the
    seed's X-Bili-Expose-Write, and toggling it gates the RAW write tools
    (send_danmaku/send_dynamic) on the double allowlist. Regression guard for the
    seed↔adapter header-name drift."""
    sidecars_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(sidecars_root / "bilibili-mcp"))
    try:
        from adapter.bilibili_adapter import BilibiliAdapter
    except Exception:  # pragma: no cover - sidecar not on path in some envs
        return  # skip rather than fail if the sidecar package is unavailable

    adapter = BilibiliAdapter()
    cfg = adapter.config
    # The seed (builtin-plugins/bilibili/index.ts) sends X-Bili-Expose-Write.
    assert cfg.expose_raw_header() == "x-bili-expose-write"

    catalog = ["search_video", "send_comment", "send_danmaku", "send_dynamic"]
    # Flag ON -> RAW writes appear.
    on = CaseInsensitiveHeaders(
        {
            "X-Bili-Tenant": "inst",
            "X-Bili-Cookie": "SESSDATA=a; bili_jct=b",
            "X-Bili-Expose-Write": "true",
        }
    )
    decoded_on = decode_tenant_headers(on, cfg)
    allowed_on = allowed_tool_names(
        catalog,
        never=cfg.never_tools,
        raw=cfg.raw_tools,
        expose_raw=decoded_on.expose_raw,
    )
    assert {"send_danmaku", "send_dynamic"} <= allowed_on
    # Flag OFF (header absent) -> RAW writes hidden.
    off = CaseInsensitiveHeaders(
        {"X-Bili-Tenant": "inst", "X-Bili-Cookie": "SESSDATA=a; bili_jct=b"}
    )
    decoded_off = decode_tenant_headers(off, cfg)
    allowed_off = allowed_tool_names(
        catalog,
        never=cfg.never_tools,
        raw=cfg.raw_tools,
        expose_raw=decoded_off.expose_raw,
    )
    assert "send_danmaku" not in allowed_off
    assert "send_dynamic" not in allowed_off


def _run():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok - {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                import traceback

                print(f"FAIL - {name}: {exc}")
                traceback.print_exc()
    return failures


if __name__ == "__main__":
    sys.exit(1 if _run() else 0)
