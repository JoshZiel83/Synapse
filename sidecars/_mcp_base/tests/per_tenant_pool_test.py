"""Per_tenant proxy pool: two (tenant,cookie) => two ports + two 0700 dirs;
max_backends gate; port reclaimed only after confirmed exit.

Uses the REAL GenericProxyAdapter + _AdapterRegistry wiring, but stubs the
upstream MCP session (no live backend) and the readiness probe so no mcp/uvicorn
runtime is required. The child process is a real `sleep` so the port/lifecycle
behavior is exercised end-to-end.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _mcp_base import proxy as proxy_mod  # noqa: E402
from _mcp_base.adapter import AdapterConfig, IgnoreCred, ProxyBackend  # noqa: E402
from _mcp_base.process import BackendPoolExhausted  # noqa: E402
from _mcp_base.proxy import GenericProxyAdapter  # noqa: E402
from _mcp_base.registry import _AdapterRegistry  # noqa: E402


class _StubSession:
    instances = []

    def __init__(self, url, headers):
        self.url = url
        self.closed = False
        _StubSession.instances.append(self)

    def close(self):
        self.closed = True


def _free_range(n):
    import socket

    socks = [socket.socket(socket.AF_INET, socket.SOCK_STREAM) for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        ports = sorted(s.getsockname()[1] for s in socks)
    finally:
        for s in socks:
            s.close()
    return (ports[0], ports[0] + n - 1)


def _make(tmp_root: Path, max_backends, port_range):
    backend = ProxyBackend(
        kind="http",
        lifecycle="per_tenant",
        spawn_cmd=lambda port, workdir: [
            sys.executable,
            "-c",
            "import time; time.sleep(30)",
        ],
        backend_env=lambda workdir: {
            "COOKIES_PATH": str(workdir / "cookies.json"),
            "TMPDIR": str(workdir / "tmp"),
        },
        backend_url=lambda port: f"http://127.0.0.1:{port}/mcp/",
        backend_ready_probe=lambda port: f"http://127.0.0.1:{port}/health",
        inject_cred=IgnoreCred(),
        port_range=port_range,
        max_backends=max_backends,
    )
    config = AdapterConfig(
        service_name="xhs-mcp",
        header_prefix="xhs",
        header_auth_name="x-xhs-cookie",
        cred_kind="raw_string",
        backend=backend,
    )
    adapter = GenericProxyAdapter(config)
    registry = _AdapterRegistry(
        tmp_root,
        adapter,
        idle_ttl=-1,
        max_backends=max_backends,
        port_range=port_range,
        aclose_handle=adapter.aclose_sync,
    )
    adapter.bind_registry(registry)
    return adapter, registry


def _patch_ready(monkey_ready=True):
    # Make the readiness probe pass immediately and the session a stub, so no
    # real backend or mcp runtime is needed.
    proxy_mod.ReadinessProbe.wait = lambda self, url, is_alive=None: monkey_ready
    proxy_mod._UpstreamSession = _StubSession  # used by _build_per_tenant


def test_two_tenants_two_ports_two_dirs():
    import tempfile

    _patch_ready(True)
    _StubSession.instances = []
    root = Path(tempfile.mkdtemp(prefix="xhs-pool-"))
    pr = _free_range(3)
    adapter, reg = _make(root, max_backends=3, port_range=pr)
    try:
        with reg.borrow("tenantA", "cookieA", "ha") as ha:
            with reg.borrow("tenantB", "cookieB", "hb") as hb:
                assert ha.port != hb.port, "two tenants must get distinct ports"
                assert ha.workdir != hb.workdir, "two tenants must get distinct dirs"
                # Distinct 0700 dirs, each with a 0600 cookie file.
                for h in (ha, hb):
                    assert oct(h.workdir.stat().st_mode & 0o777) == "0o700"
                    cookie = h.workdir / "cookies.json"
                    assert cookie.exists()
                    assert oct(cookie.stat().st_mode & 0o777) == "0o600"
                ports_in_use = reg.ports.in_use()
                assert ha.port in ports_in_use and hb.port in ports_in_use
    finally:
        reg.shutdown()


def test_max_backends_gate_in_pool():
    import tempfile

    _patch_ready(True)
    root = Path(tempfile.mkdtemp(prefix="xhs-max-"))
    pr = _free_range(2)
    adapter, reg = _make(root, max_backends=1, port_range=pr)
    try:
        with reg.borrow("a", "ca", "ha"):
            try:
                with reg.borrow("b", "cb", "hb"):
                    pass
                raised = False
            except BackendPoolExhausted:
                raised = True
        assert raised, "second in-flight backend over cap must raise"
    finally:
        reg.shutdown()


def test_port_released_after_idle_eviction_confirmed_exit():
    import tempfile

    _patch_ready(True)
    root = Path(tempfile.mkdtemp(prefix="xhs-reclaim-"))
    pr = _free_range(1)  # single port: reuse proves reclaim-after-exit
    adapter, reg = _make(root, max_backends=1, port_range=pr)
    try:
        with reg.borrow("a", "ca", "ha") as ha:
            first_port = ha.port
        # Entry now idle; a second tenant must evict it, terminate the child,
        # confirm exit, release the port, and reuse it.
        with reg.borrow("b", "cb", "hb") as hb:
            assert hb.port == first_port, "port must be reused after confirmed exit"
    finally:
        reg.shutdown()


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
