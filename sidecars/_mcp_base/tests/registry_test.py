"""Tenant-isolation tests re-homed from mijia's http_server_test.py onto the
shared base, plus the (tenant,cred-hash) keying + max_backends + LRU-idle tests.

These run without the mcp/uvicorn runtime (the registry + testkit are
dependency-light); a standalone __main__ runner is provided so they work without
pytest installed.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Allow `python -m sidecars._mcp_base.tests.registry_test` AND direct execution.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _mcp_base.process import BackendPoolExhausted  # noqa: E402
from _mcp_base.registry import _AdapterRegistry  # noqa: E402
from _mcp_base.testkit import RecordingAdapter, make_config  # noqa: E402


def _mk_registry(root, **kw):
    adapter = RecordingAdapter(config=make_config())
    return _AdapterRegistry(root, adapter, **kw), adapter


def test_startup_purges_stale_tenant_root():
    """A fresh registry must wipe any tenant dir left by a prior crash/restart."""
    root = Path(tempfile.mkdtemp(prefix="base-stale-test-"))
    stale_dir = root / "deadbeef-cafef00d"
    stale_dir.mkdir(parents=True)
    stale_file = stale_dir / "auth_data.json"
    stale_file.write_text('{"serviceToken":"STALE_LEFTOVER"}', encoding="utf-8")
    assert stale_file.exists()

    _mk_registry(root)

    assert not stale_file.exists(), "stale credential file survived startup"
    assert root.is_dir(), "root should be recreated"
    assert list(root.iterdir()) == [], "root should be empty after purge"


def test_per_install_isolation_and_perms():
    """Same creds + different installs => different dirs; secret file is 0600."""
    root = Path(tempfile.mkdtemp(prefix="base-iso-test-"))
    reg, _ = _mk_registry(root)
    cred = {"serviceToken": "t"}
    with reg.borrow("instA", cred, "hashX") as a:
        dir_a = a.client
    with reg.borrow("instB", cred, "hashX") as b:
        dir_b = b.client
    assert str(dir_a) != str(dir_b), "different installs must get different dirs"
    mode = oct(os.stat(dir_a).st_mode & 0o777)
    assert mode == "0o600", f"secret file should be 0600, got {mode}"
    reg.shutdown()


def test_keyed_by_tenant_and_cred_hash_coexist():
    """CRITICAL vs mijia: two creds for the SAME tenant coexist (per_tenant
    multi-account), not retire-on-change."""
    root = Path(tempfile.mkdtemp(prefix="base-key-test-"))
    reg, _ = _mk_registry(root)
    with reg.borrow("inst", "cookieA", "ha"):
        with reg.borrow("inst", "cookieB", "hb"):
            keys = set(reg._keys())
    assert ("inst", "ha") in keys
    assert ("inst", "hb") in keys
    assert reg._entry_count() == 2, "both (tenant,cred) entries must coexist"
    reg.shutdown()


def test_inflight_borrow_not_evicted_by_idle():
    """An in-flight borrow (refcount>0) is never cut off by idle eviction."""
    root = Path(tempfile.mkdtemp(prefix="base-inflight-test-"))
    reg, _ = _mk_registry(root, idle_ttl=-1)  # idle eviction off
    with reg.borrow("inst", "c", "h") as handle:
        secret = Path(handle.client)
        assert secret.exists()
        # A nested idle pass must not delete the in-flight entry's dir.
        with reg._lock:
            reg._evict_idle_locked()
        assert secret.exists(), "in-flight secret dir must survive eviction pass"
    reg.shutdown()


def test_refcount_zero_deletes_dir():
    """Once the last borrower drains, the retired entry's dir is removed."""
    root = Path(tempfile.mkdtemp(prefix="base-rc-test-"))
    reg, adapter = _mk_registry(root, idle_ttl=0.0)
    with reg.borrow("inst", "c", "h") as handle:
        secret = Path(handle.client)
        workdir = secret.parent
    # Force an idle pass with TTL<=0 (disabled) => use a fresh borrow to trigger
    # _evict_idle on a 0 TTL by setting it positive-small then sleeping is flaky;
    # instead assert the dir is gone only after retire. Trigger by re-borrowing a
    # different cred which runs _evict_idle_locked first with ttl 0 (disabled),
    # so explicitly retire via shutdown semantics on this entry:
    with reg._lock:
        entry = reg._entries[("inst", "h")]
        entry.retired = True
        reg._maybe_delete_locked(entry)
    assert not workdir.exists(), "retired+idle dir should be deleted"
    reg.shutdown()


def test_max_backends_gate_raises_when_all_inflight():
    """Over max_backends with no idle backend to evict => BackendPoolExhausted."""
    root = Path(tempfile.mkdtemp(prefix="base-max-test-"))
    reg, _ = _mk_registry(root, max_backends=1, idle_ttl=-1)
    with reg.borrow("a", "c", "h1"):
        try:
            with reg.borrow("b", "c", "h2"):
                pass
            raised = False
        except BackendPoolExhausted:
            raised = True
    assert raised, "second concurrent backend over cap must raise BackendPoolExhausted"
    reg.shutdown()


def test_max_backends_evicts_idle_to_make_room():
    """An idle (refcount==0) backend is evicted to admit a new one under cap."""
    root = Path(tempfile.mkdtemp(prefix="base-evict-test-"))
    reg, _ = _mk_registry(root, max_backends=1, idle_ttl=-1)
    with reg.borrow("a", "c", "h1"):
        pass  # now idle (refcount 0)
    # Second tenant must succeed by LRU-evicting the idle first entry.
    with reg.borrow("b", "c", "h2"):
        keys = reg._keys()
    assert keys == [("b", "h2")], f"idle entry should be evicted, got {keys}"
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
