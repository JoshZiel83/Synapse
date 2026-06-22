"""``Dispatcher._borrow`` offloads the SYNCHRONOUS registry borrow (build +
teardown) onto a worker thread so a slow/blocking backend cold-spawn for one
tenant never stalls the single front-end event loop or the other tenants'
in-flight requests.

Dependency-light: constructs the ``Dispatcher`` via ``__new__`` (bypassing the
mcp-importing ``__init__``) and drives ``_borrow`` with a fake registry whose
``borrow.__enter__`` blocks. No mcp/uvicorn runtime needed.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from _mcp_base.dispatch import Dispatcher  # noqa: E402


class _Decoded:
    tenant = "t"
    cred = "c"
    auth_hash = "h"


def _dispatcher(reg) -> Dispatcher:
    d = Dispatcher.__new__(Dispatcher)  # bypass __init__ (it imports mcp)
    d._registry = reg
    return d


def test_borrow_build_runs_off_event_loop_and_keeps_loop_live():
    class _SlowReg:
        @contextlib.contextmanager
        def borrow(self, tenant, cred, h):
            time.sleep(0.2)  # blocking build (Popen + readiness poll analogue)
            yield ("handle", threading.current_thread().name)

    d = _dispatcher(_SlowReg())

    async def main():
        ticks = [0]

        async def ticker():
            for _ in range(20):
                await asyncio.sleep(0.01)
                ticks[0] += 1

        t = asyncio.create_task(ticker())
        async with d._borrow(_Decoded()) as handle:
            _val, thread_name = handle
        await t
        # Build ran on a worker thread, NOT the event-loop thread.
        assert thread_name != threading.main_thread().name
        # The loop kept making progress during the 0.2s blocking build.
        assert ticks[0] > 5, f"event loop stalled during build (ticks={ticks[0]})"

    asyncio.run(main())


def test_borrow_releases_on_exception_and_propagates():
    released = []

    class _Reg:
        @contextlib.contextmanager
        def borrow(self, tenant, cred, h):
            try:
                yield "handle"
            finally:
                released.append(threading.current_thread().name)

    d = _dispatcher(_Reg())

    async def main():
        raised = False
        try:
            async with d._borrow(_Decoded()):
                raise RuntimeError("boom")
        except RuntimeError:
            raised = True
        assert raised, "exceptions inside the borrow must propagate"
        assert released, "the borrow must be released even on exception"
        # Teardown also ran off the event-loop thread.
        assert released[0] != threading.main_thread().name

    asyncio.run(main())


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
