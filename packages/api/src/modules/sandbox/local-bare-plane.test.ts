// Mode-B (local:bare) acceptance — the confined data plane + CORE + F-C, driven
// THROUGH the adapter (coreInvokeBarePlane), with NO DB. Covers the
// security-critical gates: empty-scope hard-deny (F-C), cross-prefix symlink
// escape, reserved-namespace denial, WHOLE_SCOPE root-jail, per-op caps, and
// bwrap-absent exec fail-closed.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, symlink, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WHOLE_SCOPE, bwrapAvailable } from "@synapse/device-runtime"
import {
  createLocalBareDataPlane,
  coreInvokeBarePlane,
  deriveConfinementScope,
  EmptyScopeDeniedError,
  type ConfinementCtx,
  type SandboxDataPlane,
} from "./data-plane.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"
import type { SandboxCapabilityDescriptor } from "./model.js"

async function makeSandbox(
  descriptor?: SandboxCapabilityDescriptor
): Promise<{ root: string; base: string; plane: SandboxDataPlane }> {
  const base = await mkdtemp(join(tmpdir(), "synapse-bare-"))
  const root = join(base, "sandbox")
  for (const sub of ["conversation", "actor", "actor-conversation"]) {
    await mkdir(join(root, sub), { recursive: true })
  }
  const plane = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: descriptor ?? buildLocalBareDescriptor({ isolation: "bwrap" }),
  })
  return { root, base, plane }
}

const READ: ConfinementCtx["access"] = "read"
const WRITE: ConfinementCtx["access"] = "write"

// A minimal grant record — deriveConfinementScope only reads capability +
// filesystem/commandline; the rest is irrelevant to the derivation.
function fsGrant(prefixes: string[], access: "read" | "write" = "write") {
  return {
    capability: "filesystem",
    filesystem: { access, pathPrefixes: prefixes },
  } as unknown as RuntimeAuthorizationGrantRecord
}
function cmdGrant() {
  return {
    capability: "commandline",
    commandline: { executor: "sandbox" },
  } as unknown as RuntimeAuthorizationGrantRecord
}

test("F-C: an empty/underiveable filesystem grant is a HARD DENY (never widens to WHOLE_SCOPE/[])", () => {
  assert.throws(
    () => deriveConfinementScope(fsGrant([])),
    EmptyScopeDeniedError,
    "empty prefix set must throw, not fall through"
  )
  // A grant whose only prefixes are unparseable also derives ∅ ⇒ deny.
  assert.throws(
    () => deriveConfinementScope(fsGrant(["not\\posix"])),
    EmptyScopeDeniedError
  )
})

test("deriveConfinementScope: a filesystem grant → its prefixes; a commandline grant → WHOLE_SCOPE", () => {
  const fs = deriveConfinementScope(fsGrant(["/conversation"]))
  assert.deepEqual(fs, ["/conversation"])
  const cmd = deriveConfinementScope(cmdGrant())
  assert.equal(cmd, WHOLE_SCOPE, "commandline grant root-jails to WHOLE_SCOPE")
})

test("B4: a cross-prefix symlink is DENIED through the CORE (grant realpath recheck)", async () => {
  const { root, plane } = await makeSandbox()
  // A real file under /actor, and a symlink under /conversation pointing at it.
  await writeFile(join(root, "actor", "secret.txt"), "SECRET")
  await symlink(
    join(root, "actor", "secret.txt"),
    join(root, "conversation", "link.txt")
  )
  // Grant covers ONLY /conversation. The symlink realpaths to /actor/secret →
  // outside the granted prefix → GrantPrefixDeniedError → permission_denied.
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/conversation/link.txt" },
    ctx: { scope: ["/conversation"], access: READ },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "permission_denied")
})

test("B4: the reserved /.synapse-internal namespace is denied through the CORE", async () => {
  const { plane } = await makeSandbox()
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/.synapse-internal/tmp/x" },
    ctx: { scope: WHOLE_SCOPE, access: READ },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "invalid_request")
})

test("B4: WHOLE_SCOPE root-jails within-root but a scoped grant confines to its prefix", async () => {
  const { root, plane } = await makeSandbox()
  await writeFile(join(root, "conversation", "a.txt"), "hello")
  await writeFile(join(root, "actor", "b.txt"), "world")
  // WHOLE_SCOPE can read both mount points (within root).
  const wholeA = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/actor/b.txt" },
    ctx: { scope: WHOLE_SCOPE, access: READ },
  })
  assert.equal(wholeA.ok, true)
  // A grant scoped to /conversation CANNOT read /actor.
  const scopedDeny = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/actor/b.txt" },
    ctx: { scope: ["/conversation"], access: READ },
  })
  assert.equal(scopedDeny.ok, false)
  assert.equal(scopedDeny.error?.code, "permission_denied")
})

test("B5: oversized write is rejected BEFORE hashing (reject-before-hash) and no file lands", async () => {
  const desc = buildLocalBareDescriptor({ isolation: "bwrap" })
  desc.core.maxWriteBytes = 8
  const { root, plane } = await makeSandbox(desc)
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/conversation/big.txt", content: "way too many bytes" },
    ctx: { scope: ["/conversation"], access: WRITE },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "invalid_request")
  await assert.rejects(
    stat(join(root, "conversation", "big.txt")),
    "oversized write must not create the file"
  )
})

test("B5: whole-file read is bounded by maxReadBytes (truncated)", async () => {
  const desc = buildLocalBareDescriptor({ isolation: "bwrap" })
  desc.core.maxReadBytes = 4
  const { root, plane } = await makeSandbox(desc)
  await writeFile(join(root, "conversation", "big.txt"), "0123456789")
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/conversation/big.txt" },
    ctx: { scope: ["/conversation"], access: READ },
  })
  assert.equal(res.ok, true)
  const body = JSON.parse(
    (res.result as { content: { text: string }[] }).content[0]!.text
  )
  assert.equal(body.truncated, true)
  assert.equal(body.content.length, 4)
})

test("bwrap-absent (isolation:null) → exec is a structural fail-closed (never runs unconfined)", async () => {
  const desc = buildLocalBareDescriptor({ isolation: null })
  const { plane } = await makeSandbox(desc)
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "echo hi" },
    ctx: { scope: WHOLE_SCOPE, access: WRITE },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "runtime_constraint")
  assert.match(res.error?.message ?? "", /bwrap/i)
})

test("layer-2 tools (fs_mkdir/fs_move/fs_remove) run confined through the CORE", async () => {
  const { root, plane } = await makeSandbox()
  const ctx: ConfinementCtx = { scope: ["/conversation"], access: WRITE }
  const mk = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_mkdir",
    args: { path: "/conversation/d", recursive: true },
    ctx,
  })
  assert.equal(mk.ok, true)
  await writeFile(join(root, "conversation", "d", "f.txt"), "x")
  const mv = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_move",
    args: {
      source: "/conversation/d/f.txt",
      destination: "/conversation/g.txt",
    },
    ctx,
  })
  assert.equal(mv.ok, true)
  await assert.doesNotReject(stat(join(root, "conversation", "g.txt")))
  const rm = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_remove",
    args: { path: "/conversation/d", recursive: true },
    ctx,
  })
  assert.equal(rm.ok, true)
})

test("B4: fs_move dest under a src-only scope is denied (both endpoints in one grant frame)", async () => {
  const { root, plane } = await makeSandbox()
  await writeFile(join(root, "conversation", "f.txt"), "x")
  // Scope covers /conversation only; a move to /actor must be denied by the
  // realpath recheck on the dest endpoint (same grant frame, F-C).
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_move",
    args: { source: "/conversation/f.txt", destination: "/actor/f.txt" },
    ctx: { scope: ["/conversation"], access: WRITE },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "permission_denied")
})

test("B5: exec concurrency cap rejects an over-cap concurrent invocation", async (t) => {
  if (!bwrapAvailable()) {
    t.skip("bwrap unavailable on this host")
    return
  }
  const desc = buildLocalBareDescriptor({ isolation: "bwrap" })
  desc.core.maxConcurrentExec = 1
  const { plane } = await makeSandbox(desc)
  const ctx: ConfinementCtx = { scope: WHOLE_SCOPE, access: WRITE }
  const slow = coreInvokeBarePlane({
    plane,
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "sleep 1" },
    ctx,
  })
  // Give the first exec a beat to occupy the single slot.
  await new Promise((r) => setTimeout(r, 100))
  const second = await coreInvokeBarePlane({
    plane,
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "echo hi" },
    ctx,
  })
  assert.equal(second.ok, false)
  assert.match(second.error?.message ?? "", /concurrency/i)
  await slow
})
