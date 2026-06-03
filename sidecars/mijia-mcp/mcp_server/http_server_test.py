"""Tests for the multi-tenant HTTP front end's secret-hygiene invariants.

Run as a module so the `mcp_server` package (and its `.core` imports) resolve:
    PYTHONPATH=<mcp-sdk-path>:. python -m mcp_server.http_server_test
"""

import os
import sys
import tempfile
from pathlib import Path


def test_startup_purges_stale_tenant_root():
    """A fresh registry must wipe any tenant dir left by a prior crash/restart.

    The container's writable layer survives crash/kill/restart, so a stale
    auth_data.json could otherwise linger at MIJIA_TENANT_ROOT. A new process
    owns no in-memory entries, so anything on disk is orphaned and must go.
    """
    from mcp_server import http_server as h

    root = Path(tempfile.mkdtemp(prefix="mijia-stale-test-"))
    stale_dir = root / "deadbeef-cafef00d"
    stale_dir.mkdir(parents=True)
    stale_file = stale_dir / "auth_data.json"
    stale_file.write_text('{"serviceToken":"STALE_LEFTOVER"}', encoding="utf-8")
    assert stale_file.exists()

    # Instantiating the registry against the same root must purge it.
    h._AdapterRegistry(root)

    assert not stale_file.exists(), "stale credential file survived startup"
    assert root.is_dir(), "root should be recreated"
    assert list(root.iterdir()) == [], "root should be empty after purge"


def test_per_install_isolation_and_perms():
    """Same creds + different installs => different dirs; auth file is 0600."""
    from mcp_server import http_server as h

    root = Path(tempfile.mkdtemp(prefix="mijia-iso-test-"))
    reg = h._AdapterRegistry(root)
    auth = {
        "ua": "U",
        "userId": "1",
        "cUserId": "c",
        "serviceToken": "t",
        "ssecurity": "s",
    }
    with reg.borrow("instA", auth) as a:
        dir_a = a._auth_manager.get_file_path()
    with reg.borrow("instB", auth) as b:
        dir_b = b._auth_manager.get_file_path()
    assert str(dir_a) != str(dir_b), "different installs must get different dirs"
    mode = oct(os.stat(dir_a).st_mode & 0o777)
    assert mode == "0o600", f"auth file should be 0600, got {mode}"
    reg.shutdown()


if __name__ == "__main__":
    # Lightweight runner so this works without pytest installed.
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok - {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL - {name}: {exc}")
    sys.exit(1 if failures else 0)
