"""SSRF egress guard tests (dependency-light: no network, injectable resolver)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _mcp_base.ssrf import (  # noqa: E402
    DenyPrivateNetworks,
    EgressError,
    ExactHostAllowlist,
    NoEgress,
)


def _raises(fn) -> bool:
    try:
        fn()
        return False
    except EgressError:
        return True


def test_noegress_always_fails_closed():
    assert _raises(lambda: NoEgress().assert_allowed("https://example.com/x"))


def test_exact_host_allowlist_allows_only_listed():
    pol = ExactHostAllowlist(["storage.synapse.internal", "cdn.example.com"])
    pol.assert_allowed("https://storage.synapse.internal/blob/abc")  # ok
    pol.assert_allowed("https://CDN.example.com./x")  # case + trailing dot ok
    assert _raises(lambda: pol.assert_allowed("https://evil.example.org/x"))
    assert _raises(lambda: pol.assert_allowed("http://169.254.169.254/latest"))


def test_exact_host_allowlist_rejects_non_http_scheme():
    pol = ExactHostAllowlist(["storage.synapse.internal"])
    assert _raises(lambda: pol.assert_allowed("file:///etc/passwd"))
    assert _raises(lambda: pol.assert_allowed("gopher://storage.synapse.internal/"))


def test_empty_allowlist_forbids_everything():
    pol = ExactHostAllowlist([])
    assert _raises(lambda: pol.assert_allowed("https://anything.example.com/"))


def test_deny_private_networks_blocks_rfc1918_and_imds():
    pol = DenyPrivateNetworks(resolver=lambda host: {"public.example.com": ["93.184.216.34"]}.get(host, []))
    pol.assert_allowed("https://public.example.com/x")  # public ok

    # IP literals are checked directly.
    assert _raises(lambda: pol.assert_allowed("http://127.0.0.1/x"))
    assert _raises(lambda: pol.assert_allowed("http://10.0.0.5/x"))
    assert _raises(lambda: pol.assert_allowed("http://169.254.169.254/latest"))
    assert _raises(lambda: pol.assert_allowed("http://[::1]/x"))


def test_deny_private_networks_blocks_rebinding_to_private():
    # Host resolves to a private IP -> blocked (the rebinding case a deny-list
    # catches at resolve time; ExactHostAllowlist is preferred precisely because
    # it doesn't depend on this resolve-time check).
    pol = DenyPrivateNetworks(resolver=lambda host: ["192.168.1.10"])
    assert _raises(lambda: pol.assert_allowed("https://sneaky.example.com/x"))


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
