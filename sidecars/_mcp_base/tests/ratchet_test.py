"""CI ratchets (§2.11): machine-prove "exactly one front end / one registry /
one proxy" via grep-count over sidecars/**/*.py, EXCLUDING vendored dirs
(sidecars/*/vendor/) so a vendored Node/Go upstream containing a similar string
cannot false-positive the count, AND excluding the test tree (assertion strings
in tests/ would otherwise self-match).

Pure stdlib (rglob + read); no mcp/uvicorn runtime needed.

mijia has been MIGRATED onto the base (E2): its bespoke
`mcp_server/http_server.py` (and its tracing.py copy) are deleted, so these
ratchets are STRICT — the front end / registry / dispatcher / header-decode
primitives each appear in exactly one _mcp_base file and nowhere else (vendored
upstreams and the test tree excluded).
"""

from __future__ import annotations

import sys
from pathlib import Path

# parents[0]=tests  [1]=_mcp_base  [2]=sidecars
SIDECARS = Path(__file__).resolve().parents[2]
BASE = SIDECARS / "_mcp_base"
sys.path.insert(0, str(SIDECARS))


def _py_files(exclude_vendor=True, exclude_tests=True):
    out = []
    for path in SIDECARS.rglob("*.py"):
        parts = path.relative_to(SIDECARS).parts
        if exclude_vendor and "vendor" in parts:
            continue
        if exclude_tests and "tests" in parts:
            continue
        out.append(path)
    return out


def _files_containing(needle: str, **kw) -> list[Path]:
    hits = []
    for path in _py_files(**kw):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if needle in text:
            hits.append(path)
    return sorted(hits)


def _base_only(hits: list[Path]) -> list[Path]:
    return sorted(h for h in hits if "_mcp_base" in h.parts)


def test_single_frontend_streamable_http_session_manager():
    """`StreamableHTTPSessionManager(` constructed only in _mcp_base/app.py.

    mijia is migrated (http_server.py deleted), so this is strict: app.py is the
    sole front end."""
    hits = _files_containing("StreamableHTTPSessionManager(")
    allowed = {BASE / "app.py"}
    extra = set(hits) - allowed
    assert not extra, f"unexpected StreamableHTTPSessionManager site(s): {sorted(extra)}"
    assert (BASE / "app.py") in hits, "base app.py must construct the front end"


def test_no_second_frontend_in_base():
    """`StreamableHTTPSessionManager(` appears in exactly one _mcp_base file."""
    base_hits = _base_only(_files_containing("StreamableHTTPSessionManager("))
    assert base_hits == [BASE / "app.py"], f"got {base_hits}"


def test_no_residual_http_server_in_base():
    """`_mcp_base` must contain no `http_server.py` (its logic lives in app.py)."""
    base_residue = [p for p in _py_files() if p.name == "http_server.py" and "_mcp_base" in p.parts]
    assert base_residue == [], f"_mcp_base must contain no http_server.py: {base_residue}"


def test_single_registry_definition():
    base_hits = _base_only(_files_containing("class _AdapterRegistry"))
    assert base_hits == [BASE / "registry.py"], f"got {base_hits}"


def test_single_decode_tenant_headers_definition():
    base_hits = _base_only(_files_containing("def decode_tenant_headers"))
    assert base_hits == [BASE / "headers.py"], f"got {base_hits}"


def test_single_tracing_definition():
    """The tracing primitives live in exactly ONE file — `_shared/tracing.py`,
    the single implementation shared by ALL Python sidecars (FastAPI plain
    sidecars AND the Starlette MCP base; trace-correctness §4.E) — and NOWHERE
    else. `_mcp_base/tracing.py` is deleted (clean break), and a sidecar must
    not ship a duplicate tracing module.

    This guards the regression where mijia's bespoke `mcp_server/tracing.py`
    (orphaned after the http_server.py migration) survived as a dead duplicate
    of the base's tracing.py; the migration now deletes it."""
    for needle in ("def setup_tracing", "def instrument_app", "def client_span"):
        hits = _files_containing(needle)
        assert hits == [SIDECARS / "_shared" / "tracing.py"], f"{needle}: got {hits}"
    assert not (BASE / "tracing.py").exists(), (
        "_mcp_base/tracing.py was deleted in the §4.E clean break; "
        "the single implementation lives in _shared/tracing.py"
    )


def test_single_dispatch_handlers():
    """The @list_tools()/@call_tool() Server decorators live only in dispatch.py.

    (proxy.py mentions `.list_tools(`/`.call_tool(` as upstream CLIENT calls, not
    as Server handler decorators — so match the decorator form precisely.)"""
    for needle in ("@self._server.list_tools()", "@self._server.call_tool()"):
        base_hits = _base_only(_files_containing(needle))
        assert base_hits == [BASE / "dispatch.py"], f"{needle}: got {base_hits}"


def test_no_second_pool_definition():
    """No second borrow-ctxmgr / refcount / _maybe_delete machinery in the base
    outside registry.py (per_tenant bookkeeping reuses the one registry)."""
    for needle in ("def borrow", "_maybe_delete_locked", "self.refcount"):
        base_hits = _base_only(_files_containing(needle))
        assert base_hits == [BASE / "registry.py"], f"{needle}: got {base_hits}"


def _code_lines(text: str) -> list[str]:
    """Return executable code lines: drop the module docstring and `#` comments.

    The ratchet targets per-backend name *branches* (code), not explanatory
    prose; the proxy docstring legitimately names Notion/xhs as the two example
    backends. We tokenize to drop string/docstring/comment content precisely.
    """
    import io
    import tokenize

    out: list[str] = []
    reader = io.StringIO(text).readline
    for tok in tokenize.generate_tokens(reader):
        if tok.type in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE):
            continue
        if tok.type == tokenize.NAME or tok.type == tokenize.OP:
            out.append(tok.string)
    return out


def test_proxy_has_no_per_backend_string_branches():
    """`_mcp_base/proxy.py` contains ZERO per-backend name conditions in CODE —
    behavior is data-driven by ProxyBackend.lifecycle (E3). Backend names may
    appear only in docstrings/comments (the two example backends)."""
    text = (BASE / "proxy.py").read_text(encoding="utf-8")
    code_tokens = {t.lower() for t in _code_lines(text)}
    for name in ("notion", "xhs", "bilibili", "mijia", "xiaohongshu"):
        assert name not in code_tokens, (
            f"proxy.py code must not reference backend {name!r} "
            "(per-backend branches are forbidden; lifecycle is a data field)"
        )
    # The lifecycle dispatch is the single Literal switch.
    assert 'lifecycle == "shared"' in text
    assert 'lifecycle == "per_tenant"' in text


def test_proxy_uses_named_ignorecred_sentinel():
    text = (BASE / "proxy.py").read_text(encoding="utf-8")
    assert "isinstance(inject, IgnoreCred)" in text


def test_access_log_false_single_point():
    base_hits = _base_only(_files_containing("access_log=False"))
    assert base_hits == [BASE / "app.py"], f"got {base_hits}"


def test_low_level_server_name_parameterized():
    text = (BASE / "dispatch.py").read_text(encoding="utf-8")
    assert "Server(config.service_name)" in text
    assert "Server('mijia-mcp')" not in text
    assert 'Server("mijia-mcp")' not in text


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
