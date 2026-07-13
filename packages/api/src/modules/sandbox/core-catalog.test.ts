// Golden-drift (F-D): the api-authored bare catalog is the descriptor-gated
// subset actually backed by a device builtin — no dead/unbacked tool.
// The filesystem tool DEFS derive from the resident builtin's TOOLS[]
// (filesystemCoreToolDefs), but the BARE catalog is a documented REDUCED-FIDELITY
// surface: params the bare data plane ignores are stripped and fs_search is gated
// on ripgrep. This file asserts BOTH the schema shape (subset-of-device) AND the
// bare handler's actual safety behavior (stale-guard + strict base64).

import test from "node:test"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createFilesystemBuiltin,
  createCommandlineBuiltin,
  WHOLE_SCOPE,
} from "@synapse/device-runtime"
import type { RuntimeCatalogTool } from "@synapse/device-protocol"
import {
  buildBareCoreCatalog,
  BARE_TOOL_DESCRIPTION_OVERRIDES,
} from "./core-catalog.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"
import {
  createLocalBareDataPlane,
  coreInvokeBarePlane,
  type ConfinementCtx,
  type SandboxDataPlane,
} from "./data-plane.js"
import type { SandboxCapabilityDescriptor } from "./model.js"
import type { McpDispatchResult } from "../devices/dispatch.js"

function toolMap(tools: RuntimeCatalogTool[]): Map<string, RuntimeCatalogTool> {
  return new Map(tools.map((t) => [t.name, t]))
}

interface JsonSchema {
  type?: unknown
  required?: unknown
  properties?: Record<string, unknown>
}

function schemaOf(t: RuntimeCatalogTool): JsonSchema {
  return t.input_schema as JsonSchema
}

async function makeBarePlane(overrides?: { search?: boolean }): Promise<{
  plane: SandboxDataPlane
  writeCtx: ConfinementCtx
}> {
  const root = await mkdtemp(join(tmpdir(), "synapse-bare-catalog-"))
  const descriptor = buildLocalBareDescriptor({
    isolation: "bwrap",
    search: overrides?.search ?? true,
  })
  const plane = createLocalBareDataPlane({ sandboxRoot: root, descriptor })
  return { plane, writeCtx: { scope: WHOLE_SCOPE, access: "write" } }
}

function parseOkBody(r: McpDispatchResult): Record<string, unknown> {
  assert.equal(r.ok, true, `expected ok result, got ${JSON.stringify(r.error)}`)
  const result = r.result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

/** A local:bare descriptor with CORE capability overrides (buildLocalBareDescriptor
 *  only exposes isolation/search, so R3.1's mkdir/move/remove/rangeRead/atomicWrite
 *  variants are applied here — non-mutating so tests don't cross-contaminate). */
function coreOver(
  over: Partial<SandboxCapabilityDescriptor["core"]>
): SandboxCapabilityDescriptor {
  const base = buildLocalBareDescriptor({ isolation: "bwrap", search: true })
  return { ...base, core: { ...base.core, ...over } }
}

function bareFsTools(desc: SandboxCapabilityDescriptor): RuntimeCatalogTool[] {
  return buildBareCoreCatalog(desc).find(
    (e) => e.builtin_kind === "filesystem"
  )!.tools
}

function propsOf(t: RuntimeCatalogTool): Record<string, unknown> {
  return (schemaOf(t).properties ?? {}) as Record<string, unknown>
}

/** A bare plane bound to a fresh root under a CORE-overridden descriptor. */
async function makeBarePlaneCore(
  over: Partial<SandboxCapabilityDescriptor["core"]>
): Promise<{ plane: SandboxDataPlane; writeCtx: ConfinementCtx }> {
  const root = await mkdtemp(join(tmpdir(), "synapse-bare-caps-"))
  const plane = createLocalBareDataPlane({
    sandboxRoot: root,
    descriptor: coreOver(over),
  })
  return { plane, writeCtx: { scope: WHOLE_SCOPE, access: "write" } }
}

test("F-D: the bare catalog is descriptor-gated", () => {
  const withBwrap = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap" })
  )
  const kinds = withBwrap.map((e) => e.builtin_kind)
  assert.deepEqual([...kinds].sort(), ["commandline", "filesystem"])

  // isolation:null → filesystem ONLY (no commandline; fail-closed).
  const noBwrap = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: null })
  )
  assert.deepEqual(
    noBwrap.map((e) => e.builtin_kind),
    ["filesystem"]
  )
})

test("golden-drift: every bare filesystem tool is a SUBSET of the device builtin's schema for the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-drift-"))
  // Instantiate the REAL device filesystem builtin with the tool families the
  // bare catalog exposes enabled + visible (ripgrep forced present so fs_search
  // is advertised; allowUnversionedWrite so the write-family tools are visible
  // without a sqlite helper).
  const builtin = createFilesystemBuiltin({
    rootPath: root,
    enableRead: true,
    enableWrite: true,
    enableDelete: true,
    allowUnversionedWrite: true,
    ripgrepPath: process.execPath,
  })
  const exposures = await builtin.describeExposures()
  const deviceFs = exposures.find((e) => e.builtin_kind === "filesystem")
  assert.ok(deviceFs, "device advertises a filesystem exposure")
  const deviceTools = toolMap(deviceFs!.tools)

  const bare = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap", search: true })
  )
  const bareFs = bare.find((e) => e.builtin_kind === "filesystem")!
  for (const t of bareFs.tools) {
    const deviceTool = deviceTools.get(t.name)
    assert.ok(
      deviceTool,
      `bare fs tool ${t.name} is backed by the device builtin`
    )
    // FULL SEPARATE CONTRACT (owner decision): a tool whose bare semantics/result
    // fields diverge publishes a bare-SPECIFIC truthful description, NOT the
    // resident one. For those we assert the override is a non-empty string that
    // DIFFERS from resident (the lie is gone); a non-overridden tool must still
    // match the resident description byte-for-byte (no silent drift).
    if (t.name in BARE_TOOL_DESCRIPTION_OVERRIDES) {
      assert.ok(
        typeof t.description === "string" && t.description.length > 0,
        `${t.name} has a non-empty bare-specific description`
      )
      assert.notEqual(
        t.description,
        deviceTool!.description,
        `${t.name} bare description must diverge from resident`
      )
    } else {
      assert.equal(
        t.description,
        deviceTool!.description,
        `${t.name} description`
      )
    }
    // Reduced-fidelity: the bare schema is a documented SUBSET of the device
    // schema. Top-level shape + every param the bare catalog DOES advertise must
    // match the device's definition exactly (no silent divergence), but the bare
    // catalog may OMIT params it does not honor.
    const bareSchema = schemaOf(t)
    const devSchema = schemaOf(deviceTool!)
    assert.equal(bareSchema.type, devSchema.type, `${t.name} schema type`)
    assert.deepEqual(
      bareSchema.required,
      devSchema.required,
      `${t.name} required[]`
    )
    const bareProps = bareSchema.properties ?? {}
    const devProps = devSchema.properties ?? {}
    for (const [k, v] of Object.entries(bareProps)) {
      assert.ok(
        k in devProps,
        `bare ${t.name}.${k} exists in the device schema`
      )
      assert.deepEqual(
        v,
        devProps[k],
        `${t.name}.${k} param def matches the device builtin (no drift)`
      )
    }
  }
})

test("reduced-fidelity: bare STRIPS line_range (fs_read) + include_sha256 (fs_stat) without corrupting the shared device schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-strip-"))
  const builtin = createFilesystemBuiltin({
    rootPath: root,
    enableRead: true,
    enableWrite: true,
    allowUnversionedWrite: true,
    ripgrepPath: process.execPath,
  })
  const bare = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap", search: true })
  )
  const bareFs = toolMap(
    bare.find((e) => e.builtin_kind === "filesystem")!.tools
  )

  // Bare omits the ignored params.
  assert.ok(
    !("line_range" in (schemaOf(bareFs.get("fs_read")!).properties ?? {})),
    "bare fs_read omits line_range"
  )
  assert.ok(
    !("include_sha256" in (schemaOf(bareFs.get("fs_stat")!).properties ?? {})),
    "bare fs_stat omits include_sha256"
  )
  // The bare plane has no in-sandbox index, so `indexed` could never be honored
  // and is stripped (F-D reduced-fidelity).
  assert.ok(
    !("indexed" in (schemaOf(bareFs.get("fs_search")!).properties ?? {})),
    "bare fs_search omits indexed"
  )

  // The shared resident schema is UNTOUCHED (structuredClone, not a live delete).
  const exposures = await builtin.describeExposures()
  const deviceFs = toolMap(
    exposures.find((e) => e.builtin_kind === "filesystem")!.tools
  )
  assert.ok(
    "line_range" in (schemaOf(deviceFs.get("fs_read")!).properties ?? {}),
    "device fs_read STILL has line_range (shared schema not corrupted)"
  )
  assert.ok(
    "include_sha256" in (schemaOf(deviceFs.get("fs_stat")!).properties ?? {}),
    "device fs_stat STILL has include_sha256 (shared schema not corrupted)"
  )
})

test("full separate contract: every BARE_TOOL_DESCRIPTION_OVERRIDES tool ships a non-empty bare-specific description that DIFFERS from resident (fs + commandline)", async () => {
  const root = await mkdtemp(join(tmpdir(), "synapse-override-"))
  const fsBuiltin = createFilesystemBuiltin({
    rootPath: root,
    enableRead: true,
    enableWrite: true,
    enableDelete: true,
    allowUnversionedWrite: true,
    ripgrepPath: process.execPath,
  })
  const cmdBuiltin = createCommandlineBuiltin({})
  // Resident descriptions by tool name, across BOTH device builtins the bare
  // catalog derives from.
  const residentDesc = new Map<string, string>()
  for (const builtin of [fsBuiltin, cmdBuiltin]) {
    for (const exp of await builtin.describeExposures()) {
      for (const t of exp.tools) residentDesc.set(t.name, t.description)
    }
  }

  const bare = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap", search: true })
  )
  const bareTools = new Map<string, RuntimeCatalogTool>()
  for (const exp of bare) {
    for (const t of exp.tools) bareTools.set(t.name, t)
  }

  const overridden = Object.keys(BARE_TOOL_DESCRIPTION_OVERRIDES)
  assert.ok(overridden.length > 0, "there is at least one override")
  for (const name of overridden) {
    const bareTool = bareTools.get(name)
    assert.ok(
      bareTool,
      `overridden tool ${name} is present in the bare catalog`
    )
    assert.equal(
      bareTool!.description,
      BARE_TOOL_DESCRIPTION_OVERRIDES[name],
      `${name} publishes the bare override verbatim`
    )
    assert.ok(
      bareTool!.description.length > 0,
      `${name} bare description is non-empty`
    )
    const resident = residentDesc.get(name)
    assert.ok(resident, `resident builtin defines ${name}`)
    assert.notEqual(
      bareTool!.description,
      resident,
      `${name} bare description DIFFERS from resident (no lie)`
    )
  }
})

test("gate: fs_search is OMITTED from the bare catalog when descriptor.core.search is false", () => {
  const withSearch = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap", search: true })
  )
  const fsWith = withSearch.find((e) => e.builtin_kind === "filesystem")!
  assert.ok(
    fsWith.tools.some((t) => t.name === "fs_search"),
    "search=true advertises fs_search"
  )

  const noSearch = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap", search: false })
  )
  const fsNo = noSearch.find((e) => e.builtin_kind === "filesystem")!
  assert.ok(
    !fsNo.tools.some((t) => t.name === "fs_search"),
    "search=false OMITS fs_search (no dead/unbacked tool)"
  )
})

test("golden-drift: the bare commandline tools are backed by the device commandline builtin (bash + exec_file)", async () => {
  const builtin = createCommandlineBuiltin({})
  const exposures = await builtin.describeExposures()
  const deviceCmd = exposures.find((e) => e.builtin_kind === "commandline")
  assert.ok(deviceCmd, "device advertises a commandline exposure")
  const deviceTools = toolMap(deviceCmd!.tools)

  const bare = buildBareCoreCatalog(
    buildLocalBareDescriptor({ isolation: "bwrap" })
  )
  const bareCmd = bare.find((e) => e.builtin_kind === "commandline")!
  for (const t of bareCmd.tools) {
    const deviceTool = deviceTools.get(t.name)
    assert.ok(deviceTool, `bare commandline tool ${t.name} is device-backed`)
    assert.deepEqual(
      t.input_schema,
      deviceTool!.input_schema,
      `${t.name} schema`
    )
  }
})

// ─────────────────────────── bare handler behavior (P6) ──────────────────────

test("behavior: fs_write REJECTS invalid base64 (strict decode; no silent corruption)", async () => {
  const { plane, writeCtx } = await makeBarePlane()
  try {
    const bad = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: {
        path: "/bad.bin",
        content: "not@valid#base64",
        encoding: "base64",
      },
      ctx: writeCtx,
    })
    assert.equal(bad.ok, false, "malformed base64 must be rejected")
    assert.equal(bad.error?.code, "invalid_request")

    // A VALID base64 payload still writes and round-trips (we didn't break it).
    const good = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: {
        path: "/good.bin",
        content: Buffer.from("hi").toString("base64"),
        encoding: "base64",
      },
      ctx: writeCtx,
    })
    assert.equal(good.ok, true)
    const readBack = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_read",
      args: { path: "/good.bin", encoding: "utf-8" },
      ctx: writeCtx,
    })
    assert.equal(parseOkBody(readBack)["content"], "hi")
  } finally {
    await plane.dispose()
  }
})

test("behavior: fs_write stale-guard REJECTS a wrong expected_sha256 (lost-update prevention)", async () => {
  const { plane, writeCtx } = await makeBarePlane()
  try {
    const seed = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: { path: "/s.txt", content: "v1", encoding: "utf-8" },
      ctx: writeCtx,
    })
    const goodSha = parseOkBody(seed)["sha256"] as string

    // A caller who expects a DIFFERENT prior sha is racing a lost update → reject.
    const stale = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: {
        path: "/s.txt",
        content: "v2",
        encoding: "utf-8",
        expected_sha256: "0".repeat(64),
      },
      ctx: writeCtx,
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.error?.code, "runtime_constraint")
    assert.equal(stale.error?.details?.["stale_write"], true)

    // The correct expected sha is accepted.
    const ok = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: {
        path: "/s.txt",
        content: "v2",
        encoding: "utf-8",
        expected_sha256: goodSha,
      },
      ctx: writeCtx,
    })
    assert.equal(ok.ok, true)
  } finally {
    await plane.dispose()
  }
})

test("behavior: fs_write stale-guard REJECTS a wrong expected_mtime_ms", async () => {
  const { plane, writeCtx } = await makeBarePlane()
  try {
    await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: { path: "/m.txt", content: "a", encoding: "utf-8" },
      ctx: writeCtx,
    })
    const stale = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: {
        path: "/m.txt",
        content: "b",
        encoding: "utf-8",
        expected_mtime_ms: 1, // deliberately not the real mtime
      },
      ctx: writeCtx,
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.error?.code, "runtime_constraint")
    assert.equal(stale.error?.details?.["stale_write"], true)
  } finally {
    await plane.dispose()
  }
})

// ─────────── R3.1 — capability_descriptor tool toggles are ENFORCED ────────────
// (honest contract): a toggled-off op is OMITTED from the published catalog AND
// fail-closes at the plane. Two layers: the catalog (Layer 1, bareFilesystemTools)
// and the plane (Layer 2, buildConfinedHostFs guards → runtime_constraint).

test("R3.1 Layer 1: !mkdir/!move/!remove/!search OMIT the tool from the published bare catalog", () => {
  const full = new Set(bareFsTools(coreOver({})).map((t) => t.name))
  for (const n of ["fs_mkdir", "fs_move", "fs_remove", "fs_search"]) {
    assert.ok(full.has(n), `${n} present under full caps`)
  }
  assert.ok(
    !bareFsTools(coreOver({ mkdir: false })).some((t) => t.name === "fs_mkdir"),
    "!mkdir OMITS fs_mkdir"
  )
  assert.ok(
    !bareFsTools(coreOver({ move: false })).some((t) => t.name === "fs_move"),
    "!move OMITS fs_move"
  )
  assert.ok(
    !bareFsTools(coreOver({ remove: false })).some(
      (t) => t.name === "fs_remove"
    ),
    "!remove OMITS fs_remove"
  )
  assert.ok(
    !bareFsTools(coreOver({ search: false })).some(
      (t) => t.name === "fs_search"
    ),
    "!search OMITS fs_search"
  )
})

test("R3.1 Layer 1: !rangeRead strips start_byte+end_byte from fs_read but RETAINS max_bytes (response-size cap, not a range feature)", () => {
  // Control: with rangeRead all three byte params are advertised.
  const withRange = propsOf(
    bareFsTools(coreOver({})).find((t) => t.name === "fs_read")!
  )
  assert.ok("start_byte" in withRange, "rangeRead advertises start_byte")
  assert.ok("end_byte" in withRange, "rangeRead advertises end_byte")
  assert.ok("max_bytes" in withRange, "rangeRead advertises max_bytes")

  const noRange = propsOf(
    bareFsTools(coreOver({ rangeRead: false })).find(
      (t) => t.name === "fs_read"
    )!
  )
  assert.ok(!("start_byte" in noRange), "!rangeRead STRIPS start_byte")
  assert.ok(!("end_byte" in noRange), "!rangeRead STRIPS end_byte")
  assert.ok(
    "max_bytes" in noRange,
    "!rangeRead RETAINS max_bytes (not a range feature)"
  )
})

test("R3.1 Layer 1: !mkdir also STRIPS create_parents from fs_write's schema (implicit dir-create)", () => {
  const withMkdir = propsOf(
    bareFsTools(coreOver({})).find((t) => t.name === "fs_write")!
  )
  assert.ok("create_parents" in withMkdir, "mkdir advertises create_parents")
  const noMkdir = propsOf(
    bareFsTools(coreOver({ mkdir: false })).find((t) => t.name === "fs_write")!
  )
  assert.ok(
    !("create_parents" in noMkdir),
    "!mkdir STRIPS fs_write.create_parents"
  )
})

test("R3.1: the filesystem exposure surfaces write=true (always-present CORE) and atomicWrite SEPARATELY", () => {
  const feats = (desc: SandboxCapabilityDescriptor): Record<string, unknown> =>
    (
      buildBareCoreCatalog(desc).find((e) => e.builtin_kind === "filesystem")!
        .metadata as { features: Record<string, unknown> }
    ).features
  const on = feats(coreOver({ atomicWrite: true }))
  assert.equal(on["write"], true, "write is always-present CORE")
  assert.equal(on["atomicWrite"], true, "atomicWrite reflects the descriptor")
  const off = feats(coreOver({ atomicWrite: false }))
  assert.equal(
    off["write"],
    true,
    "write stays true even when atomicity is off (no longer conflated)"
  )
  assert.equal(off["atomicWrite"], false, "atomicWrite is surfaced separately")
})

test("R3.1 Layer 2: a direct coreInvokeBarePlane call fail-closes with runtime_constraint when the capability is toggled off", async () => {
  const cases: Array<{
    over: Partial<SandboxCapabilityDescriptor["core"]>
    toolName: string
    args: Record<string, unknown>
  }> = [
    { over: { mkdir: false }, toolName: "fs_mkdir", args: { path: "/d" } },
    {
      over: { move: false },
      toolName: "fs_move",
      args: { source: "/a.txt", destination: "/b.txt" },
    },
    {
      over: { remove: false },
      toolName: "fs_remove",
      args: { path: "/x.txt" },
    },
    {
      over: { rangeRead: false },
      toolName: "fs_read",
      args: { path: "/f.txt", start_byte: 0, end_byte: 4 },
    },
    {
      over: { search: false },
      toolName: "fs_search",
      args: { mode: "content", query: "x" },
    },
  ]
  for (const c of cases) {
    const { plane, writeCtx } = await makeBarePlaneCore(c.over)
    try {
      const r = await coreInvokeBarePlane({
        plane,
        builtinKind: "filesystem",
        toolName: c.toolName,
        args: c.args,
        ctx: writeCtx,
      })
      assert.equal(r.ok, false, `${c.toolName} must fail-close`)
      assert.equal(
        r.error?.code,
        "runtime_constraint",
        `${c.toolName} → runtime_constraint (missing capability, not invalid_request)`
      )
    } finally {
      await plane.dispose()
    }
  }
})

test("R3.1 Layer 2: fs_write create_parents:true under !mkdir fail-closes (runtime_constraint); a plain write still works", async () => {
  const { plane, writeCtx } = await makeBarePlaneCore({ mkdir: false })
  try {
    const rejected = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: {
        path: "/newdir/f.txt",
        content: "hi",
        encoding: "utf-8",
        create_parents: true,
      },
      ctx: writeCtx,
    })
    assert.equal(rejected.ok, false, "create_parents:true must fail-close")
    assert.equal(rejected.error?.code, "runtime_constraint")

    // A plain write (no implicit dir-create) is unaffected by !mkdir.
    const ok = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: { path: "/f.txt", content: "hi", encoding: "utf-8" },
      ctx: writeCtx,
    })
    assert.equal(ok.ok, true, "a plain write still works under !mkdir")
  } finally {
    await plane.dispose()
  }
})

test("R3.P2a: a negative CORE numeric param (max_bytes) is REJECTED, not clamped", async () => {
  const { plane, writeCtx } = await makeBarePlaneCore({})
  try {
    await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_write",
      args: { path: "/n.txt", content: "0123456789", encoding: "utf-8" },
      ctx: writeCtx,
    })
    const neg = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_read",
      args: { path: "/n.txt", max_bytes: -5 },
      ctx: writeCtx,
    })
    assert.equal(neg.ok, false, "negative max_bytes must be rejected")
    assert.equal(neg.error?.code, "invalid_request")
    // A non-negative max_bytes still works (not clamped away).
    const ok = await coreInvokeBarePlane({
      plane,
      builtinKind: "filesystem",
      toolName: "fs_read",
      args: { path: "/n.txt", max_bytes: 4 },
      ctx: writeCtx,
    })
    assert.equal(ok.ok, true)
  } finally {
    await plane.dispose()
  }
})
