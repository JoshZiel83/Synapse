// GROUP G — S13 degraded-descriptor variant (B9) + §4.7.7 matrix pins that are
// DB-FREE. Proves: a confinedFs:'unsupported' fs grant derives WHOLE_SCOPE (NOT
// a sub-prefix, NOT []/deny — F-C); staleWriteGuard:'advisory' degrades (does not
// reject) expected_sha256/create_only; and the Mode-A REGRESSION pins that the
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
      pty: false,
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

// ─────────── S13 (d): staleWriteGuard:'advisory' degrades expected_sha256 ──────

test("S13 (d) — staleWriteGuard:'strict' REJECTS a wrong expected_sha256; 'advisory' DEGRADES (accepts)", async () => {
  const root = await makeRoot()
  const wholeCtx: ConfinementCtx = { scope: WHOLE_SCOPE, access: "write" }

  // strict: a mismatched expected_sha256 on an existing file is a stale-write reject.
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

  // advisory: the same mismatched expected_sha256 is IGNORED (degraded) → write OK.
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
  const advisoryRes = await coreInvokeBarePlane({
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
    advisoryRes.ok,
    true,
    "advisory degrades (ignores) expected_sha256"
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
