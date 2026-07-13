// Mode-B (local:bare) acceptance — the confined data plane + CORE + F-C, driven
// THROUGH the adapter (coreInvokeBarePlane), with NO DB. Covers the
// security-critical gates: empty-scope hard-deny (F-C), cross-prefix symlink
// escape, reserved-namespace denial, WHOLE_SCOPE root-jail, per-op caps, and
// bwrap-absent exec fail-closed.

import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  stat,
} from "node:fs/promises"
import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WHOLE_SCOPE, bwrapAvailable } from "@synapse/device-runtime"
import {
  createLocalBareDataPlane,
  coreInvokeBarePlane,
  deriveConfinementScope,
  deriveConfinementAccess,
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

function bodyOf(res: { result?: unknown }): Record<string, unknown> {
  return JSON.parse(
    (res.result as { content: { text: string }[] }).content[0]!.text
  ) as Record<string, unknown>
}

test("P5b: list_dir({}) defaults the omitted path to /conversation (granted cwd), not '/'", async () => {
  const { root, plane } = await makeSandbox()
  await writeFile(join(root, "conversation", "hello.txt"), "x")
  // Grant covers ONLY /conversation (a mount) — NOT '/'. Under the old '/'
  // default an omitted-path list_dir resolved '/', which no mount grant covers,
  // and HARD-DENIED at the vfs (GrantPrefixDenied) even though it passed the
  // matcher. The /conversation default makes auth and execution agree.
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "list_dir",
    args: {},
    ctx: { scope: ["/conversation"], access: READ },
  })
  assert.equal(res.ok, true, "omitted-path list_dir must list /conversation")
  const body = bodyOf(res)
  assert.equal(body["path"], "/conversation")
  assert.ok(
    (body["entries"] as { name: string }[]).some((e) => e.name === "hello.txt")
  )
})

test("P5b sanity: an EXPLICIT '/' under the same /conversation-only scope IS denied", async () => {
  // Proves the pass above is due to the /conversation default, not a lax scope:
  // the old '/' default would have hit exactly this deny.
  const { plane } = await makeSandbox()
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "list_dir",
    args: { path: "/" },
    ctx: { scope: ["/conversation"], access: READ },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "permission_denied")
})

test("P6: fs_write with a stale FRACTIONAL expected_mtime_ms is REJECTED (guard honored, not dropped by asInt)", async () => {
  const { root, plane } = await makeSandbox()
  const ctx: ConfinementCtx = { scope: ["/conversation"], access: WRITE }
  const abs = join(root, "conversation", "note.txt")
  await writeFile(abs, "hello")

  const statRes = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_stat",
    args: { path: "/conversation/note.txt" },
    ctx,
  })
  assert.equal(statRes.ok, true)
  const mCur = bodyOf(statRes)["mtimeMs"] as number
  assert.equal(typeof mCur, "number")

  // A deliberately FRACTIONAL, stale mtime. Under the old asInt parse this
  // becomes undefined → null → the mtime guard is SKIPPED and the write would
  // SUCCEED. With the asNumber parse it is honored and the mismatch REJECTS.
  const staleFractional = 1_699_999_999_123.456
  assert.notEqual(staleFractional, mCur)
  const stale = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/note.txt",
      content: "world",
      expected_mtime_ms: staleFractional,
    },
    ctx,
  })
  assert.equal(stale.ok, false, "stale fractional mtime must REJECT")
  assert.equal(stale.error?.code, "runtime_constraint")
  assert.equal(
    (stale.error?.details as Record<string, unknown>)?.["stale_write"],
    true
  )
  assert.equal(
    await readFile(abs, "utf-8"),
    "hello",
    "rejected write is a no-op"
  )

  // A MATCHING (fractional) current mtime is ACCEPTED — asNumber round-trips the
  // exact value fs_stat returned.
  const ok = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/note.txt",
      content: "world",
      expected_mtime_ms: mCur,
    },
    ctx,
  })
  assert.equal(ok.ok, true, "matching current mtime must be accepted")
  assert.equal(await readFile(abs, "utf-8"), "world")
})

test("P6: a present-but-unparseable expected_mtime_ms fails CLOSED (invalid_request)", async () => {
  const { root, plane } = await makeSandbox()
  const ctx: ConfinementCtx = { scope: ["/conversation"], access: WRITE }
  await writeFile(join(root, "conversation", "n.txt"), "hi")
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/n.txt",
      content: "x",
      expected_mtime_ms: "not-a-number",
    },
    ctx,
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, "invalid_request")
})

test("P6-schema: bare fs_edit with a stale expected_sha256 is REJECTED (precondition honored)", async () => {
  const { root, plane } = await makeSandbox()
  const ctx: ConfinementCtx = { scope: ["/conversation"], access: WRITE }
  const abs = join(root, "conversation", "doc.txt")
  await writeFile(abs, "alpha")

  // A stale sha (of some OTHER content): the file already differs from what the
  // caller expected → stale_write, rejected BEFORE any mutation. (Before the fix
  // coreEdit never read expected_sha256, so this edit applied silently.)
  const staleSha = createHash("sha256").update("DIFFERENT").digest("hex")
  const stale = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_edit",
    args: {
      path: "/conversation/doc.txt",
      edits: [{ old_string: "alpha", new_string: "beta" }],
      expected_sha256: staleSha,
    },
    ctx,
  })
  assert.equal(stale.ok, false, "stale expected_sha256 must REJECT")
  assert.equal(stale.error?.code, "runtime_constraint")
  assert.equal(
    (stale.error?.details as Record<string, unknown>)?.["stale_write"],
    true
  )
  assert.equal(
    await readFile(abs, "utf-8"),
    "alpha",
    "rejected edit is a no-op"
  )

  // The CORRECT current sha is honored → the edit applies.
  const curSha = createHash("sha256").update("alpha").digest("hex")
  const ok = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_edit",
    args: {
      path: "/conversation/doc.txt",
      edits: [{ old_string: "alpha", new_string: "beta" }],
      expected_sha256: curSha,
    },
    ctx,
  })
  assert.equal(ok.ok, true, "matching expected_sha256 must be accepted")
  assert.equal(await readFile(abs, "utf-8"), "beta")
})

test("P6-schema: bare fs_edit with a stale FRACTIONAL expected_mtime_ms is REJECTED", async () => {
  const { root, plane } = await makeSandbox()
  const ctx: ConfinementCtx = { scope: ["/conversation"], access: WRITE }
  const abs = join(root, "conversation", "m.txt")
  await writeFile(abs, "alpha")
  const stale = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_edit",
    args: {
      path: "/conversation/m.txt",
      edits: [{ old_string: "alpha", new_string: "beta" }],
      expected_mtime_ms: 1_699_999_999_123.456,
    },
    ctx,
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.error?.code, "runtime_constraint")
  assert.equal(
    (stale.error?.details as Record<string, unknown>)?.["stale_write"],
    true
  )
  assert.equal(await readFile(abs, "utf-8"), "alpha")
})

test("advisory posture: a caller's EXPLICIT stale expected_sha256 / expected_mtime_ms is STILL rejected (posture relaxes only the forced self-CAS)", async () => {
  // No advisory adapter ships today (every descriptor is 'strict'), so this is
  // structural: an 'advisory' descriptor must still honor a caller-supplied
  // optimistic-concurrency precondition — advisory only drops the no-caller
  // forced self-CAS, never a caller's explicit expected_sha256 / expected_mtime_ms.
  const desc = buildLocalBareDescriptor({ isolation: "bwrap" })
  desc.core.staleWriteGuard = "advisory"
  const { root, plane } = await makeSandbox(desc)
  const ctx: ConfinementCtx = { scope: ["/conversation"], access: WRITE }
  const abs = join(root, "conversation", "adv.txt")
  await writeFile(abs, "alpha")

  // Stale caller expected_sha256 (of DIFFERENT content) → REJECTED under advisory.
  const staleSha = createHash("sha256").update("DIFFERENT").digest("hex")
  const rejSha = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/adv.txt",
      content: "beta",
      expected_sha256: staleSha,
    },
    ctx,
  })
  assert.equal(
    rejSha.ok,
    false,
    "stale caller expected_sha256 must REJECT under advisory"
  )
  assert.equal(rejSha.error?.code, "runtime_constraint")
  assert.equal(
    (rejSha.error?.details as Record<string, unknown>)?.["stale_write"],
    true
  )
  assert.equal(
    await readFile(abs, "utf-8"),
    "alpha",
    "rejected write is a no-op"
  )

  // Stale caller expected_mtime_ms → REJECTED under advisory too.
  const rejMtime = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/adv.txt",
      content: "beta",
      expected_mtime_ms: 1_699_999_999_123.456,
    },
    ctx,
  })
  assert.equal(
    rejMtime.ok,
    false,
    "stale caller expected_mtime_ms must REJECT under advisory"
  )
  assert.equal(rejMtime.error?.code, "runtime_constraint")
  assert.equal(
    (rejMtime.error?.details as Record<string, unknown>)?.["stale_write"],
    true
  )
  assert.equal(await readFile(abs, "utf-8"), "alpha")

  // Control: under advisory a write with NO caller precondition succeeds — the
  // forced self-CAS is the ONLY thing advisory relaxes.
  const ok = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/conversation/adv.txt", content: "gamma" },
    ctx,
  })
  assert.equal(
    ok.ok,
    true,
    "advisory write with no caller precondition succeeds"
  )
  assert.equal(await readFile(abs, "utf-8"), "gamma")

  // A MATCHING caller expected_sha256 is honored → the write applies (the
  // precondition is enforced both ways under advisory).
  const curSha = createHash("sha256").update("gamma").digest("hex")
  const okSha = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/adv.txt",
      content: "delta",
      expected_sha256: curSha,
    },
    ctx,
  })
  assert.equal(
    okSha.ok,
    true,
    "matching caller expected_sha256 is accepted under advisory"
  )
  assert.equal(await readFile(abs, "utf-8"), "delta")
})

test("P7: deriveConfinementAccess is FAIL-CLOSED (read/unknown tool → read; write tool needs a write grant)", () => {
  // A read tool always yields 'read', regardless of the grant's access.
  assert.equal(
    deriveConfinementAccess(fsGrant(["/conversation"], "write"), "fs_read"),
    "read"
  )
  assert.equal(
    deriveConfinementAccess(fsGrant(["/conversation"], "write"), "list_dir"),
    "read"
  )
  assert.equal(
    deriveConfinementAccess(fsGrant(["/conversation"], "read"), "fs_stat"),
    "read"
  )
  // A write tool under a WRITE grant → 'write'.
  assert.equal(
    deriveConfinementAccess(fsGrant(["/conversation"], "write"), "fs_write"),
    "write"
  )
  assert.equal(
    deriveConfinementAccess(fsGrant(["/conversation"], "write"), "fs_edit"),
    "write"
  )
  // A write tool under a READ grant → 'read' (assertWriteAccess then rejects it).
  assert.equal(
    deriveConfinementAccess(fsGrant(["/conversation"], "read"), "fs_write"),
    "read"
  )
  // An unclassified/unknown tool never silently gets 'write'.
  assert.equal(
    deriveConfinementAccess(
      fsGrant(["/conversation"], "write"),
      "fs_totally_unknown"
    ),
    "read"
  )
  // A commandline grant confers no fs-plane write.
  assert.equal(deriveConfinementAccess(cmdGrant(), "fs_write"), "read")
})

function metaOf(res: { result?: unknown }): Record<string, unknown> {
  return ((res.result as { _meta?: Record<string, unknown> })._meta ??
    {}) as Record<string, unknown>
}

test("Part A#1: a binary fs_read (default utf-8) falls back to base64 on the body AND _meta (no U+FFFD corruption)", async () => {
  const { root, plane } = await makeSandbox()
  // Bytes that do NOT round-trip through utf-8 (0xff/0xfe/0x80/0xfd are invalid
  // UTF-8 lead/continuation bytes). Before the fix these force-decoded to U+FFFD.
  const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xfd])
  await writeFile(join(root, "conversation", "blob.bin"), binary)
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    // NO encoding requested → utf-8 default → must auto-fall-back to base64.
    args: { path: "/conversation/blob.bin" },
    ctx: { scope: WHOLE_SCOPE, access: READ },
  })
  assert.equal(res.ok, true)
  const body = bodyOf(res)
  assert.equal(body["encoding"], "base64", "body.encoding reflects the fallback")
  const meta = metaOf(res)
  assert.equal(meta["encoding"], "base64", "_meta.encoding reflects the fallback")
  assert.equal(meta["encoding_fallback"], true)
  // The returned base64 decodes back to the EXACT original bytes (no corruption).
  assert.ok(
    Buffer.from(body["content"] as string, "base64").equals(binary),
    "base64 content round-trips to the original bytes"
  )
})

test("Part A#1: a UTF-8 fs_read still returns utf8 (no spurious base64 fallback)", async () => {
  const { root, plane } = await makeSandbox()
  await writeFile(join(root, "conversation", "note.txt"), "hello world")
  const res = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/conversation/note.txt" },
    ctx: { scope: WHOLE_SCOPE, access: READ },
  })
  assert.equal(res.ok, true)
  const body = bodyOf(res)
  assert.equal(body["encoding"], "utf-8")
  assert.equal(body["content"], "hello world")
  const meta = metaOf(res)
  assert.equal(meta["encoding"], "utf-8")
  assert.ok(
    !("encoding_fallback" in meta),
    "no encoding_fallback flag for clean utf-8"
  )
})

// A minimal fake plane that returns a controlled exec result — lets us assert the
// CORE's isError wiring deterministically WITHOUT depending on bwrap being present.
function fakeExecPlane(result: {
  exitCode: number | null
  killed?: boolean
}): SandboxDataPlane {
  return {
    async exec() {
      return {
        exitCode: result.exitCode,
        stdout: "out",
        stderr: "",
        truncated: false,
        killed: result.killed ?? false,
      }
    },
  } as unknown as SandboxDataPlane
}

test("Part A#2: a non-zero-exit / killed command yields result.isError===true; a zero-exit yields falsy", async () => {
  const ctx: ConfinementCtx = { scope: WHOLE_SCOPE, access: WRITE }
  const failed = await coreInvokeBarePlane({
    plane: fakeExecPlane({ exitCode: 3 }),
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "exit 3" },
    ctx,
  })
  assert.equal(failed.ok, true, "a failed command is still a RESULT, not a fork error")
  assert.equal(
    (failed.result as { isError?: boolean }).isError,
    true,
    "non-zero exit ⇒ isError"
  )

  const killed = await coreInvokeBarePlane({
    plane: fakeExecPlane({ exitCode: null, killed: true }),
    builtinKind: "commandline",
    toolName: "bash",
    args: { command: "sleep 999" },
    ctx,
  })
  assert.equal(
    (killed.result as { isError?: boolean }).isError,
    true,
    "killed ⇒ isError"
  )

  const okExec = await coreInvokeBarePlane({
    plane: fakeExecPlane({ exitCode: 0 }),
    builtinKind: "commandline",
    toolName: "exec_file",
    args: { program: "true" },
    ctx,
  })
  assert.ok(
    !(okExec.result as { isError?: boolean }).isError,
    "zero-exit ⇒ isError falsy"
  )
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
