// P7 proof: ConfinementCtx.access is a MANDATORY boundary that is now enforced
// fail-closed at the TOP of every MUTATING plane method (write / mkdir / move /
// remove). A read-only grant (access:'read') can never mutate — the assertion
// catches DIRECT/internal callers, not just the CORE dispatch fork, and maps to
// permission_denied. Read ops (stat/list/read/search) are unaffected.

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WHOLE_SCOPE } from "@synapse/device-runtime"
import {
  createLocalBareDataPlane,
  coreInvokeBarePlane,
  GrantAccessDeniedError,
  type ConfinementCtx,
  type SandboxDataPlane,
} from "./data-plane.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"

async function makePlane(): Promise<{
  plane: SandboxDataPlane
  writeCtx: ConfinementCtx
  readCtx: ConfinementCtx
}> {
  const root = await mkdtemp(join(tmpdir(), "synapse-p7-plane-"))
  const descriptor = buildLocalBareDescriptor({
    isolation: "bwrap",
    search: true,
  })
  const plane = createLocalBareDataPlane({ sandboxRoot: root, descriptor })
  return {
    plane,
    writeCtx: { scope: WHOLE_SCOPE, access: "write" },
    readCtx: { scope: WHOLE_SCOPE, access: "read" },
  }
}

const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"))

test("P7: mutating plane methods THROW GrantAccessDeniedError under access:'read'", async () => {
  const { plane, writeCtx, readCtx } = await makePlane()
  try {
    // Seed a file + dir under a WRITE ctx so move/remove have real targets — the
    // access assertion must fire BEFORE any target existence check regardless.
    await plane.write("/seed.txt", bytes("v1"), {}, writeCtx)
    await plane.mkdir("/d", {}, writeCtx)

    await assert.rejects(
      () => plane.write("/seed.txt", bytes("v2"), {}, readCtx),
      GrantAccessDeniedError,
      "write under read grant"
    )
    await assert.rejects(
      () => plane.mkdir("/d2", {}, readCtx),
      GrantAccessDeniedError,
      "mkdir under read grant"
    )
    await assert.rejects(
      () => plane.move("/seed.txt", "/seed2.txt", {}, readCtx),
      GrantAccessDeniedError,
      "move under read grant"
    )
    await assert.rejects(
      () => plane.remove("/seed.txt", {}, readCtx),
      GrantAccessDeniedError,
      "remove under read grant"
    )
  } finally {
    await plane.dispose()
  }
})

test("P7: mutating plane methods SUCCEED under access:'write'", async () => {
  const { plane, writeCtx } = await makePlane()
  try {
    const w = await plane.write("/f.txt", bytes("hello"), {}, writeCtx)
    assert.equal(w.bytesWritten, 5)
    // recursive:true so the vfs kernel reports created:true (Node's non-recursive
    // fsp.mkdir returns undefined on success → created:false even when it made it).
    const m = await plane.mkdir("/dir", { recursive: true }, writeCtx)
    assert.equal(m.created, true)
    assert.equal((await plane.stat("/dir", writeCtx)).kind, "directory")
    const mv = await plane.move("/f.txt", "/g.txt", {}, writeCtx)
    assert.equal(typeof mv.mtimeMs, "number")
    const rm = await plane.remove("/g.txt", {}, writeCtx)
    assert.equal(rm.removed, true)
    assert.equal((await plane.stat("/g.txt", writeCtx)).exists, false)
  } finally {
    await plane.dispose()
  }
})

test("P7: read ops (stat/list/read) are unaffected under access:'read'", async () => {
  const { plane, writeCtx, readCtx } = await makePlane()
  try {
    await plane.write("/r.txt", bytes("data"), {}, writeCtx)
    const st = await plane.stat("/r.txt", readCtx)
    assert.equal(st.exists, true)
    const entries = await plane.list("/", readCtx)
    assert.ok(entries.some((e) => e.name === "r.txt"))
    const rd = await plane.read("/r.txt", {}, readCtx)
    assert.equal(Buffer.from(rd.bytes).toString("utf8"), "data")
  } finally {
    await plane.dispose()
  }
})

test("P7: a read-ctx fs_write maps to permission_denied through the CORE fork", async () => {
  const { plane, readCtx } = await makePlane()
  try {
    const r = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: { path: "/x.txt", content: "hi", encoding: "utf-8" },
      ctx: readCtx,
    })
    assert.equal(r.ok, false)
    assert.equal(r.error?.code, "permission_denied")
  } finally {
    await plane.dispose()
  }
})
