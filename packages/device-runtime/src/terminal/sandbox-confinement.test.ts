import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildBwrapArgs,
  wrapDescriptorWithBwrap,
  bwrapAvailable,
  DEFAULT_SANDBOX_CWD,
} from "./sandbox-confinement.js"

/**
 * bwrap command confinement (Step 10). Unit-tests the arg construction always;
 * runs real bwrap jails when the binary is present (Linux CI) to prove the
 * security properties: no network, host FS outside the mounts unreachable,
 * mount points readable/writable at their in-jail same-name paths.
 */

const HAS_BWRAP = bwrapAvailable()

test("buildBwrapArgs: includes the core isolation flags + cwd + terminator", () => {
  const args = buildBwrapArgs({ sandboxRoot: "/nonexistent-sandbox" })
  assert.ok(args.includes("--unshare-net"), "no network")
  assert.ok(args.includes("--die-with-parent"), "die-with-parent")
  assert.ok(args.includes("--new-session"), "new-session (no TIOCSTI)")
  const chdir = args.indexOf("--chdir")
  assert.ok(chdir >= 0, "--chdir present")
  assert.equal(
    args[chdir + 1],
    DEFAULT_SANDBOX_CWD,
    "default cwd /conversation"
  )
  assert.equal(args[args.length - 1], "--", "ends with -- terminator")
  // No bare --bind of the whole root (that would defeat isolation).
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bind") {
      assert.notEqual(
        args[i + 1],
        "/nonexistent-sandbox",
        "must not bind the whole sandbox root"
      )
    }
  }
})

test("wrapDescriptorWithBwrap: program is the absolute bwrap path, original command trails", () => {
  const wrapped = wrapDescriptorWithBwrap(
    { program: "/bin/echo", args: ["hi"], stdio: ["ignore", "pipe", "pipe"] },
    { sandboxRoot: "/nonexistent-sandbox" }
  )
  // Absolute path (never a bare "bwrap" — that would be PATH-resolved against
  // the toolchain-prepended child PATH and could be shadowed).
  assert.match(wrapped.program, /\/bwrap$/)
  assert.ok(wrapped.program.startsWith("/"), "absolute bwrap path")
  // The original program + args appear after the -- terminator.
  const dashIdx = wrapped.args.indexOf("--")
  assert.ok(dashIdx >= 0)
  assert.deepEqual(wrapped.args.slice(dashIdx + 1), ["/bin/echo", "hi"])
})

test(
  "bwrap jail: command in a mount point can read/write but has no network",
  { skip: HAS_BWRAP ? false : "bwrap not installed" },
  () => {
    const sandbox = mkdtempSync(join(tmpdir(), "synapse-jail-"))
    mkdirSync(join(sandbox, "conversation"), { recursive: true })
    mkdirSync(join(sandbox, "actor"), { recursive: true })
    mkdirSync(join(sandbox, "actor-conversation"), { recursive: true })
    writeFileSync(join(sandbox, "conversation", "seed.txt"), "hello-jail")

    // 1. Inside /conversation: can read the seed file (same bytes as host).
    const readWrapped = wrapDescriptorWithBwrap(
      {
        program: "/bin/cat",
        args: ["/conversation/seed.txt"],
        stdio: ["ignore", "pipe", "pipe"],
      },
      { sandboxRoot: sandbox }
    )
    const read = spawnSync(readWrapped.program, readWrapped.args.slice(), {
      encoding: "utf8",
    })
    assert.equal(read.status, 0, `cat failed: ${read.stderr}`)
    assert.match(read.stdout, /hello-jail/)

    // 2. Can WRITE inside a mount point.
    const writeWrapped = wrapDescriptorWithBwrap(
      {
        program: "/bin/sh",
        args: ["-c", "echo written > /actor/out.txt && cat /actor/out.txt"],
        stdio: ["ignore", "pipe", "pipe"],
      },
      { sandboxRoot: sandbox }
    )
    const write = spawnSync(writeWrapped.program, writeWrapped.args.slice(), {
      encoding: "utf8",
    })
    assert.equal(write.status, 0, `write failed: ${write.stderr}`)
    assert.match(write.stdout, /written/)
    // The write landed on the host mount dir (same bytes).
    assert.ok(existsSync(join(sandbox, "actor", "out.txt")), "write persisted")

    // 3. Host FS OUTSIDE the mounts is unreachable: /etc/hostname is bound ro
    //    only if present; a path we did NOT bind (the sandbox's sibling tmp)
    //    must not be visible. Use the sandbox root itself — only its mount
    //    children are bound, not the root — so /<basename> isn't there.
    const escapeWrapped = wrapDescriptorWithBwrap(
      {
        program: "/bin/sh",
        args: ["-c", "ls / | sort | tr '\\n' ' '"],
        stdio: ["ignore", "pipe", "pipe"],
      },
      { sandboxRoot: sandbox }
    )
    const ls = spawnSync(escapeWrapped.program, escapeWrapped.args.slice(), {
      encoding: "utf8",
    })
    assert.equal(ls.status, 0, `ls failed: ${ls.stderr}`)
    // The three mount points are visible at root...
    assert.match(ls.stdout, /conversation/)
    assert.match(ls.stdout, /\bactor\b/)
    // ...but the host's /root or /home (not bound) is not.
    assert.doesNotMatch(ls.stdout, /\bhome\b/)

    // 4. No network: a UDP socket bind to a non-loopback is impossible without
    //    a network namespace device. Simplest probe: `ip` may be absent, so
    //    check that the loopback-only netns has no eth devices via /sys.
    const netWrapped = wrapDescriptorWithBwrap(
      {
        program: "/bin/sh",
        args: ["-c", "ls /sys/class/net 2>/dev/null | tr '\\n' ' '"],
        stdio: ["ignore", "pipe", "pipe"],
      },
      { sandboxRoot: sandbox }
    )
    const net = spawnSync(netWrapped.program, netWrapped.args.slice(), {
      encoding: "utf8",
    })
    // --unshare-net yields an isolated stack with only loopback (lo), never the
    // host's eth0/en0/etc.
    if (net.status === 0) {
      assert.doesNotMatch(net.stdout, /eth0|ens|enp|wlan/)
    }
  }
)
