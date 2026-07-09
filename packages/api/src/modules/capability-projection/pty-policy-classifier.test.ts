// P4a S8 — pty policy family + buildRequestedAction classifier registry.
// DB-FREE unit gates (B10 + the Mode-A classifier regression pin). Proves the
// fail-OPEN class this closes: pty is a DISTINCT capability whose bytes never
// route through a command-text matcher, and a commandline/sandbox grant can
// NEVER cover pty.open. NULL builtin_kind (device-proxied non-builtin exposure)
// preserves its historical cua-shaped behavior (null-reachability analysis);
// only a genuinely-unknown NON-NULL kind fail-closes.

import test from "node:test"
import assert from "node:assert/strict"
import { ptyPolicyAllows } from "@synapse/shared"
import { buildRequestedAction } from "./service.js"
import { runtimeAuthorizationGrantMatches } from "../runtime-authorizations/service.js"
import { buildBareCoreCatalog } from "../sandbox/core-catalog.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"
import type { RuntimeAuthorizationRequestedAction } from "@synapse/shared/types"
import type { SandboxCapabilityDescriptor } from "../sandbox/model.js"

function grant(
  spec: Partial<RuntimeAuthorizationGrantRecord>
): RuntimeAuthorizationGrantRecord {
  return spec as unknown as RuntimeAuthorizationGrantRecord
}

// ─────────────────────────── classifier: pty projector ───────────────────────

test("classifier — pty builtin_kind projects capability='pty' (NOT commandline), cwd default /conversation", () => {
  const action = buildRequestedAction({
    capability: "pty",
    toolName: "pty_open",
    visibleToolName: "pty_open",
    args: {},
  })
  assert.equal(action.capability, "pty")
  assert.ok(action.pty, "carries a pty block")
  assert.equal(action.pty?.workingDirectory, "/conversation")
  // FAIL-OPEN TRIPWIRE: pty bytes/command must NEVER be placed in a command-text
  // matcher. A pty action carries NO commandline block / commandText.
  assert.equal(
    action.commandline,
    undefined,
    "pty action must never carry a commandline block (mis-registration = fail-open)"
  )
})

test("classifier — pty honors an explicit working_directory arg", () => {
  const action = buildRequestedAction({
    capability: "pty",
    toolName: "pty_open",
    visibleToolName: "pty_open",
    args: { working_directory: "/actor/work" },
  })
  assert.equal(action.capability, "pty")
  assert.equal(action.pty?.workingDirectory, "/actor/work")
})

// ─────────────── classifier: Mode-A regression — 4 builtins unchanged ─────────

test("classifier Mode-A regression — filesystem/commandline/browser/cua project unchanged", () => {
  const fs = buildRequestedAction({
    capability: "filesystem",
    toolName: "fs_write",
    visibleToolName: "fs_write",
    args: { path: "/conversation/a.txt", content: "x" },
  })
  assert.equal(fs.capability, "filesystem")
  assert.equal(fs.filesystem?.access, "write")

  const cmd = buildRequestedAction({
    capability: "commandline",
    toolName: "bash",
    visibleToolName: "bash",
    args: { command: "ls", working_directory: "/conversation" },
  })
  assert.equal(cmd.capability, "commandline")
  assert.equal(cmd.commandline?.executor, "bash")

  const cua = buildRequestedAction({
    capability: "cua",
    toolName: "cua_click",
    visibleToolName: "cua_click",
    args: {},
  })
  assert.equal(cua.capability, "cua")
  assert.equal(cua.cua?.access, "write")

  const cuaRead = buildRequestedAction({
    capability: "cua",
    toolName: "cua_list_displays",
    visibleToolName: "cua_list_displays",
    args: {},
  })
  assert.equal(cuaRead.cua?.access, "read")
})

// ─────────────── classifier: NULL builtin_kind (non-builtin exposure) ─────────

test("classifier — NULL builtin_kind (device-proxied non-builtin exposure) preserves cua-shaped behavior (null-reachability analysis)", () => {
  // A stdio/http/sse/custom exposure projects builtin_kind=NULL and is
  // dispatchable with no transport restriction. Pre-P4a it fell through the
  // `case "cua": default:` collapse to a cua action. PRESERVED — a `case null`
  // projector produces the identical cua-shaped action (no Mode-A regression).
  const action = buildRequestedAction({
    capability: null,
    toolName: "acme_proxy_tool",
    visibleToolName: "acme_proxy_tool",
    args: {},
  })
  assert.equal(action.capability, "cua")
  assert.equal(action.cua?.access, "read")
  assert.equal(action.pty, undefined)
})

test("classifier — genuinely-unknown NON-NULL builtin_kind fail-closes (UnregisteredBuiltinKindError → permission_denied)", () => {
  // Simulates DB enum drift: a runtime_exposures_builtin_kind value not yet
  // taught to the classifier. Reachable ONLY via an out-of-union runtime value
  // (the TS union is closed) — a deliberate downcast exercises the runtime
  // backstop. It must NOT silently route to a wrong capability's grant matcher.
  assert.throws(
    () =>
      buildRequestedAction({
        toolName: "future_tool",
        visibleToolName: "future_tool",
        args: {},
        // out-of-union kind (enum-drift backstop)
        capability: "telepathy",
      } as unknown as Parameters<typeof buildRequestedAction>[0]),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as Error).name, "UnregisteredBuiltinKindError")
      assert.equal(
        (err as { synapseCode?: string }).synapseCode,
        "permission_denied"
      )
      return true
    }
  )
})

// ─────────────────────────── ptyPolicyAllows (shared) ────────────────────────

test("ptyPolicyAllows — allows cwd within a mount, denies outside/missing/win32", () => {
  assert.equal(ptyPolicyAllows({}, { cwd: "/conversation" }), true)
  assert.equal(ptyPolicyAllows({}, { cwd: "/actor/sub" }), true)
  // cwd outside every mount point → deny.
  assert.equal(ptyPolicyAllows({}, { cwd: "/etc" }), false)
  // missing cwd → deny (cannot prove the pty runs inside the jail).
  assert.equal(ptyPolicyAllows({}, {}), false)
  // win32 → deny (bwrap/container jail is Linux-only).
  assert.equal(
    ptyPolicyAllows({}, { cwd: "/conversation", platform: "win32" }),
    false
  )
})

test("ptyPolicyAllows — honors the grant's narrower workingDirectory cap", () => {
  // cap = /conversation/allowed; a cwd outside that sub-mount is denied even
  // though it is within a top-level mount.
  assert.equal(
    ptyPolicyAllows(
      { workingDirectory: "/conversation/allowed" },
      { cwd: "/conversation/allowed/x" }
    ),
    true
  )
  assert.equal(
    ptyPolicyAllows(
      { workingDirectory: "/conversation/allowed" },
      { cwd: "/conversation/other" }
    ),
    false
  )
  // path traversal collapses before the check: /conversation/allowed/../secret
  // → /conversation/secret, outside the cap.
  assert.equal(
    ptyPolicyAllows(
      { workingDirectory: "/conversation/allowed" },
      { cwd: "/conversation/allowed/../secret" }
    ),
    false
  )
})

// ────────────── grant coverage: capability-equality is the wall ──────────────

test("grant coverage — a pty grant covers pty.open on cwd/isolation ONLY", () => {
  const action = buildRequestedAction({
    capability: "pty",
    toolName: "pty_open",
    args: { working_directory: "/conversation" },
  })
  // pty grant with no narrower cap → covers a within-mount cwd.
  assert.equal(
    runtimeAuthorizationGrantMatches(
      grant({ capability: "pty", pty: {} }),
      action
    ),
    true
  )
  // pty grant does NOT cover a pty.open whose cwd is outside the mounts.
  const outside = buildRequestedAction({
    capability: "pty",
    toolName: "pty_open",
    args: { working_directory: "/etc" },
  })
  assert.equal(
    runtimeAuthorizationGrantMatches(
      grant({ capability: "pty", pty: {} }),
      outside
    ),
    false
  )
})

test("grant coverage — a commandline/sandbox grant can NEVER cover pty.open (capability-equality wall; the fail-open this closes)", () => {
  const ptyAction = buildRequestedAction({
    capability: "pty",
    toolName: "pty_open",
    args: { working_directory: "/conversation" },
  })
  // A broad sandbox commandline grant (would authorize any command in the jail)
  // does NOT cover pty.open — otherwise pty.write could pipe arbitrary bytes
  // into an interactive shell under a mere command grant.
  const sandboxGrant = grant({
    capability: "commandline",
    commandline: { executor: "sandbox" } as never,
  })
  assert.equal(runtimeAuthorizationGrantMatches(sandboxGrant, ptyAction), false)

  // And symmetrically: a pty grant does NOT cover a commandline action.
  const bashAction = buildRequestedAction({
    capability: "commandline",
    toolName: "bash",
    args: { command: "ls", working_directory: "/conversation" },
  })
  assert.equal(
    runtimeAuthorizationGrantMatches(
      grant({ capability: "pty", pty: {} }),
      bashAction as RuntimeAuthorizationRequestedAction
    ),
    false
  )
})

// ─────────────── F-D: pty is NEVER in the production catalog ──────────────────

test("F-D — buildBareCoreCatalog NEVER emits a pty exposure, even with core.pty=true", () => {
  const descriptor: SandboxCapabilityDescriptor = {
    mode: "bare",
    transportDefault: "direct",
    confinedFs: "native",
    core: {
      atomicWrite: true,
      staleWriteGuard: "strict",
      rangeRead: true,
      search: true,
      mkdir: true,
      move: true,
      remove: true,
      // Even if a descriptor claims pty, the production catalog must NOT expose
      // it (no device-runtime pty builtin exists — it would be a dead tool).
      pty: true,
      maxReadBytes: 1024,
      maxWriteBytes: 1024,
      maxConcurrentExec: 1,
    },
    advancedTools: [],
    isolation: "bwrap",
    reconnectable: true,
  }
  const exposures = buildBareCoreCatalog(descriptor)
  const kinds = exposures.map((e) => e.builtin_kind)
  assert.ok(
    !kinds.includes("pty"),
    "pty is never in the production catalog (F-D)"
  )
  assert.deepEqual(kinds.sort(), ["commandline", "filesystem"])
})
