// GROUP G — S13 degraded-descriptor variant (B9) + §4.7.7 matrix pins that are
// DB-FREE. Proves: a confinedFs:'unsupported' fs grant derives WHOLE_SCOPE (NOT
// a sub-prefix, NOT []/deny — F-C); staleWriteGuard:'advisory' relaxes ONLY the
// no-caller forced self-CAS (a caller's EXPLICIT expected_sha256 is still honored
// under advisory — it is never dropped); and the Mode-A REGRESSION pins that the
// WHOLE_SCOPE-mapping + classifier changes do NOT alter native sub-prefix
// confinement. The DB-backed grant MINT branch (createSandboxGrants confinedFs)
// is covered in the DB tier; here we pin the ConfinementCtx derivation + plane
// behavior that is its observable consequence.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WHOLE_SCOPE } from "@synapse/device-runtime"
import {
  createLocalBareDataPlane,
  coreInvokeBarePlane,
  deriveConfinementScope,
  type ConfinementCtx,
} from "./data-plane.js"
import type { SandboxCapabilityDescriptor } from "./model.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"

function grant(
  spec: Partial<RuntimeAuthorizationGrantRecord>
): RuntimeAuthorizationGrantRecord {
  return spec as unknown as RuntimeAuthorizationGrantRecord
}

function descriptor(
  over: Partial<SandboxCapabilityDescriptor["core"]> = {},
  top: Partial<SandboxCapabilityDescriptor> = {}
): SandboxCapabilityDescriptor {
  return {
    mode: "bare",
    transportDefault: "direct",
    confinedFs: "native",
    core: {
      atomicWrite: true,
      staleWriteGuard: "strict",
      rangeRead: true,
      search: false,
      mkdir: true,
      move: true,
      remove: true,
      maxReadBytes: 1024 * 1024,
      maxWriteBytes: 1024 * 1024,
      maxConcurrentExec: 2,
      ...over,
    },
    advancedTools: [],
    isolation: "bwrap",
    reconnectable: true,
    ...top,
  }
}

async function makeRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "synapse-degraded-"))
  const root = join(base, "sandbox")
  for (const sub of ["conversation", "actor", "actor-conversation"]) {
    await mkdir(join(root, sub), { recursive: true })
  }
  return root
}

// ─────────── S13 (a)/(b)/(c): degraded fs grant derives WHOLE_SCOPE ────────────

test("S13 (b)(c) — a whole-sandbox-scope fs grant (pathPrefixes:['/']) derives WHOLE_SCOPE (root-jail, NOT a '/' prefix, NOT deny)", () => {
  const scope = deriveConfinementScope(
    grant({
      capability: "filesystem",
      filesystem: { access: "write", pathPrefixes: ["/"] },
    })
  )
  assert.equal(scope, WHOLE_SCOPE, "degraded whole-scope grant → WHOLE_SCOPE")
})

test("S13 (a) Mode-A REGRESSION — a NATIVE sub-prefix fs grant is UNCHANGED (a prefix array, never WHOLE_SCOPE)", () => {
  const scope = deriveConfinementScope(
    grant({
      capability: "filesystem",
      filesystem: {
        access: "write",
        pathPrefixes: ["/conversation", "/actor", "/actor-conversation"],
      },
    })
  )
  assert.notEqual(scope, WHOLE_SCOPE)
  assert.deepEqual(
    [...(scope as readonly string[])].sort(),
    ["/actor", "/actor-conversation", "/conversation"],
    "sub-prefix confinement is byte-identical after the S13 WHOLE_SCOPE mapping"
  )
})

test("S13 F-C — a scoped fs grant deriving ∅ still HARD-DENIES (does not fall through to WHOLE_SCOPE)", () => {
  assert.throws(
    () =>
      deriveConfinementScope(
        grant({
          capability: "filesystem",
          filesystem: { access: "write", pathPrefixes: [] },
        })
      ),
    /empty prefix set/
  )
})

// ─────────── S13 (d): a caller's explicit expected_sha256 is honored in BOTH
// postures; 'advisory' relaxes ONLY the no-caller forced self-CAS ──────────────

test("S13 (d) — a caller's explicit expected_sha256 is REJECTED-on-mismatch under BOTH 'strict' and 'advisory' (advisory relaxes only the forced self-CAS)", async () => {
  const root = await makeRoot()
  const wholeCtx: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }

  // strict: a mismatched caller expected_sha256 on an existing file is a
  // stale-write reject.
  const strict = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: descriptor({ staleWriteGuard: "strict" }),
  })
  await coreInvokeBarePlane({
    plane: strict,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/conversation/f.txt", content: "v1" },
    ctx: wholeCtx,
  })
  const strictRes = await coreInvokeBarePlane({
    plane: strict,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/f.txt",
      content: "v2",
      expected_sha256: "0".repeat(64), // deliberately wrong
    },
    ctx: wholeCtx,
  })
  assert.equal(strictRes.ok, false, "strict enforces expected_sha256")
  assert.equal(strictRes.error?.code, "runtime_constraint")

  // advisory: a caller's EXPLICIT (wrong) expected_sha256 is STILL rejected. A
  // caller-supplied optimistic-concurrency precondition is honored regardless of
  // posture — 'advisory' relaxes ONLY the no-caller forced self-CAS, never a
  // caller's own precondition (previously advisory silently dropped it → a stale
  // caller write applied; that fail-open was the bug this pins closed).
  const advisory = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: descriptor({ staleWriteGuard: "advisory" }),
  })
  await coreInvokeBarePlane({
    plane: advisory,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/actor/g.txt", content: "v1" },
    ctx: wholeCtx,
  })
  const advisoryStale = await coreInvokeBarePlane({
    plane: advisory,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/actor/g.txt",
      content: "v2",
      expected_sha256: "0".repeat(64),
    },
    ctx: wholeCtx,
  })
  assert.equal(
    advisoryStale.ok,
    false,
    "advisory still honors a caller's explicit expected_sha256"
  )
  assert.equal(advisoryStale.error?.code, "runtime_constraint")

  // advisory with NO caller precondition succeeds — the forced (no-caller)
  // self-CAS is the ONLY thing advisory relaxes.
  const advisoryNoPre = await coreInvokeBarePlane({
    plane: advisory,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/actor/g.txt", content: "v3" },
    ctx: wholeCtx,
  })
  assert.equal(
    advisoryNoPre.ok,
    true,
    "advisory drops only the no-caller forced self-CAS"
  )
})

// ─────────── §4.7.7(b) B4 — WHOLE_SCOPE root-jails within-root ONLY ────────────

test("B4 — WHOLE_SCOPE root-jails: a within-root path resolves; the empty scope is a hard deny upstream", async () => {
  const root = await makeRoot()
  const wholeCtx: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }
  const plane = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: descriptor(),
  })
  const w = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/conversation/in.txt", content: "ok" },
    ctx: wholeCtx,
  })
  assert.equal(w.ok, true, "WHOLE_SCOPE permits within-root writes")
})

// ─────────── R3.1 — capability_descriptor tool toggles ENFORCED at the plane ────
// A toggled-off op fail-closes at coreInvokeBarePlane with runtime_constraint (a
// MISSING capability, not invalid_request) — mirrors the Layer-1 catalog omission
// in core-catalog.ts so an omitted/stripped tool can never be executed anyway.

test("R3.1 — a toggled-off CORE op (mkdir/move/remove/search) fail-closes at coreInvokeBarePlane with runtime_constraint", async () => {
  const root = await makeRoot()
  const wholeCtx: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }
  const cases: Array<{
    over: Partial<SandboxCapabilityDescriptor["core"]>
    toolName: string
    args: Record<string, unknown>
  }> = [
    {
      over: { mkdir: false },
      toolName: "fs_mkdir",
      args: { path: "/conversation/d" },
    },
    {
      over: { move: false },
      toolName: "fs_move",
      args: {
        source: "/conversation/a.txt",
        destination: "/conversation/b.txt",
      },
    },
    {
      over: { remove: false },
      toolName: "fs_remove",
      args: { path: "/conversation/x.txt" },
    },
    {
      over: { search: false },
      toolName: "fs_search",
      args: { mode: "content", query: "x" },
    },
  ]
  for (const c of cases) {
    const plane = createLocalBareDataPlane({
      sandboxRoot: root,
      descriptor: descriptor(c.over),
    })
    const r = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: c.toolName,
      args: c.args,
      ctx: wholeCtx,
    })
    assert.equal(r.ok, false, `${c.toolName} must fail-close`)
    assert.equal(
      r.error?.code,
      "runtime_constraint",
      `${c.toolName} → runtime_constraint`
    )
    await plane.dispose()
  }
})

test("R3.1 — !rangeRead rejects a supplied byte-window (start_byte/end_byte) but a plain read + max_bytes still works (max_bytes is not a range feature)", async () => {
  const root = await makeRoot()
  const wholeCtx: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }
  const plane = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: descriptor({ rangeRead: false }),
  })
  await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: { path: "/conversation/f.txt", content: "0123456789" },
    ctx: wholeCtx,
  })
  const ranged = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/conversation/f.txt", start_byte: 2, end_byte: 5 },
    ctx: wholeCtx,
  })
  assert.equal(ranged.ok, false, "!rangeRead rejects a supplied byte window")
  assert.equal(ranged.error?.code, "runtime_constraint")

  const plain = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_read",
    args: { path: "/conversation/f.txt", max_bytes: 4 },
    ctx: wholeCtx,
  })
  assert.equal(
    plain.ok,
    true,
    "!rangeRead still permits a plain read with max_bytes"
  )
  await plane.dispose()
})

test("R3.1 — fs_write create_parents:true under !mkdir fail-closes with runtime_constraint", async () => {
  const root = await makeRoot()
  const wholeCtx: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }
  const plane = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: descriptor({ mkdir: false }),
  })
  const r = await coreInvokeBarePlane({
    plane,
    builtinKind: "filesystem",
    toolName: "fs_write",
    args: {
      path: "/conversation/newdir/f.txt",
      content: "hi",
      create_parents: true,
    },
    ctx: wholeCtx,
  })
  assert.equal(r.ok, false, "create_parents:true under !mkdir must fail-close")
  assert.equal(r.error?.code, "runtime_constraint")
  await plane.dispose()
})
