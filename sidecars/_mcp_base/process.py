"""Net-new base primitives consumed only by the ``per_tenant`` proxy lifecycle.

These are NOT "things the registry already had" (the registry only does session
aclose + rmtree). They are enumerated explicitly here so the per-tenant process
pool cannot grow an unreviewed parallel implementation:

  * ``PortAllocator``        — allocates loopback ports from a configured range
    and reclaims a port ONLY after the child is confirmed exited (a port must
    never be re-allocatable before its previous owner has exited, or a
    concurrent spawn could briefly route to a dying backend — a cross-tenant
    window, since xpzouying has no gateway token).
  * ``ReadinessProbe``       — polls a readiness URL after spawn until ready or
    a deadline.
  * ``ChildProcessSupervisor`` — SIGTERM -> bounded SIGKILL + waitpid to confirm
    exit.

``BackendPoolExhausted`` (a typed, fail-closed, retriable error) lives here too;
it is raised when no loopback port / backend slot is available.
"""

from __future__ import annotations

import errno
import os
import signal
import threading
import time
import urllib.error
import urllib.request


class BackendPoolExhausted(Exception):
    """No loopback port / backend slot available. Fail-closed, retriable."""


class PortAllocator:
    """Allocates loopback ports from ``[low, high]`` (inclusive).

    Thread-safe. A port handed out by ``acquire`` is marked in-use until
    ``release`` is called, and ``release`` MUST only be invoked after the child
    that owned the port is confirmed exited (the caller's responsibility — see
    ``ChildProcessSupervisor.terminate``). There is no exit-before-reuse race
    because the port stays in ``_in_use`` across the whole teardown.
    """

    def __init__(self, port_range: tuple[int, int]):
        low, high = port_range
        if low <= 0 or high < low:
            raise ValueError(f"invalid port_range: {port_range!r}")
        self._low = low
        self._high = high
        self._in_use: set[int] = set()
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._high - self._low + 1

    def acquire(self) -> int:
        """Return a free loopback port, or raise ``BackendPoolExhausted``."""
        with self._lock:
            for port in range(self._low, self._high + 1):
                if port in self._in_use:
                    continue
                if self._is_free(port):
                    self._in_use.add(port)
                    return port
            raise BackendPoolExhausted(
                f"no free port in range [{self._low}, {self._high}]"
            )

    def release(self, port: int) -> None:
        """Return a port to the pool. Call ONLY after the owner has exited."""
        with self._lock:
            self._in_use.discard(port)

    def in_use(self) -> frozenset[int]:
        with self._lock:
            return frozenset(self._in_use)

    @staticmethod
    def _is_free(port: int) -> bool:
        """Best-effort check that 127.0.0.1:port is bindable right now."""
        import socket

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False
        finally:
            sock.close()


class ReadinessProbe:
    """Polls a readiness URL until it responds or the deadline passes."""

    def __init__(self, timeout: float = 30.0, interval: float = 0.25):
        self._timeout = timeout
        self._interval = interval

    def wait(self, url: str, *, is_alive=None) -> bool:
        """Poll ``url`` until a 2xx/3xx/4xx HTTP response arrives (any HTTP
        response means the server is up) or the deadline passes. Returns True on
        ready. If ``is_alive`` is given and returns False, fail fast (the child
        died during startup)."""
        deadline = time.monotonic() + self._timeout
        while time.monotonic() < deadline:
            if is_alive is not None and not is_alive():
                return False
            if self._probe_once(url):
                return True
            time.sleep(self._interval)
        return False

    @staticmethod
    def _probe_once(url: str) -> bool:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:  # noqa: S310 - loopback only
                return 200 <= resp.status < 500
        except urllib.error.HTTPError:
            # An HTTP error status still means the server is listening.
            return True
        except (urllib.error.URLError, OSError, ValueError):
            return False


class ChildProcessSupervisor:
    """Terminates a child process: SIGTERM -> bounded wait -> SIGKILL -> waitpid.

    Works with anything exposing ``.poll()``, ``.send_signal()``, ``.kill()`` and
    ``.wait()`` (a ``subprocess.Popen``). After ``terminate`` returns, the child
    is confirmed exited (so the caller may now release its port).
    """

    def __init__(self, term_grace: float = 5.0, kill_grace: float = 5.0):
        self._term_grace = term_grace
        self._kill_grace = kill_grace

    def terminate(self, proc) -> int:
        """Stop ``proc`` and return its exit code. Idempotent for an already-dead
        child."""
        if proc is None:
            return 0
        if proc.poll() is not None:
            return self._reap(proc)

        self._signal(proc, signal.SIGTERM)
        code = self._wait_for_exit(proc, self._term_grace)
        if code is not None:
            return code

        # Still alive: hard kill, bounded.
        self._signal(proc, signal.SIGKILL)
        code = self._wait_for_exit(proc, self._kill_grace)
        if code is not None:
            return code
        # As a last resort, block on waitpid so we never leak a zombie / never
        # release the port while the child still holds it.
        return self._reap(proc)

    @staticmethod
    def _signal(proc, sig) -> None:
        try:
            proc.send_signal(sig)
        except (ProcessLookupError, OSError) as exc:
            if getattr(exc, "errno", None) not in (None, errno.ESRCH):
                raise

    @staticmethod
    def _wait_for_exit(proc, grace: float):
        try:
            return proc.wait(timeout=grace)
        except Exception:  # subprocess.TimeoutExpired (and any wait error)
            return None

    @staticmethod
    def _reap(proc) -> int:
        try:
            return proc.wait(timeout=None)
        except Exception:  # pragma: no cover - defensive
            return -1


def is_process_alive(pid: int) -> bool:
    """True if ``pid`` exists (sends signal 0). Defensive helper for probes."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
