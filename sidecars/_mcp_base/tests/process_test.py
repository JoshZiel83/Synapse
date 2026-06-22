"""Per_tenant base primitives: PortAllocator + ChildProcessSupervisor.

TEST not grep-ratchet (§2.11 7b): exercises the real exhaustion + port-reclaim-
only-after-confirmed-exit behavior with a short-lived child process. No mcp/
uvicorn runtime needed.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _mcp_base.process import (  # noqa: E402
    BackendPoolExhausted,
    ChildProcessSupervisor,
    PortAllocator,
    is_process_alive,
)


def _free_range(n=2):
    """Find a small range of currently-free loopback ports for the test."""
    import socket

    socks = [socket.socket(socket.AF_INET, socket.SOCK_STREAM) for _ in range(n)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        ports = sorted(s.getsockname()[1] for s in socks)
    finally:
        for s in socks:
            s.close()
    # Use a contiguous span starting at the lowest found port.
    return (ports[0], ports[0] + n - 1)


def test_port_allocator_hands_out_distinct_and_exhausts():
    low, high = _free_range(2)
    alloc = PortAllocator((low, high))
    p1 = alloc.acquire()
    p2 = alloc.acquire()
    assert p1 != p2
    assert low <= p1 <= high and low <= p2 <= high
    try:
        alloc.acquire()
        raised = False
    except BackendPoolExhausted:
        raised = True
    assert raised, "acquiring beyond the range must raise BackendPoolExhausted"
    # Release one and re-acquire.
    alloc.release(p1)
    p3 = alloc.acquire()
    assert p3 == p1


def test_port_reclaimed_only_after_confirmed_exit():
    """The supervisor confirms exit before the caller releases the port — there
    is no exit-before-reuse window."""
    low, high = _free_range(1)
    alloc = PortAllocator((low, high))
    port = alloc.acquire()
    # A child that sleeps; SIGTERM should stop it within grace.
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    assert is_process_alive(proc.pid)
    sup = ChildProcessSupervisor(term_grace=3.0, kill_grace=2.0)
    code = sup.terminate(proc)
    # Process is confirmed exited now.
    assert proc.poll() is not None, "child must be confirmed exited"
    assert not is_process_alive(proc.pid)
    # Only NOW is it safe to release the port.
    alloc.release(port)
    assert alloc.acquire() == port  # reusable after confirmed exit


def test_supervisor_kills_sigterm_resistant_child():
    """A child that ignores SIGTERM is escalated to SIGKILL within bounds."""
    low, high = _free_range(1)
    proc = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
        ]
    )
    sup = ChildProcessSupervisor(term_grace=1.0, kill_grace=3.0)
    sup.terminate(proc)
    assert proc.poll() is not None, "SIGTERM-resistant child must be SIGKILL'd"


def test_supervisor_idempotent_on_dead_child():
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    sup = ChildProcessSupervisor()
    # Must not raise on an already-dead child.
    sup.terminate(proc)


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
