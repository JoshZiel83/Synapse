// P8(A) + P2(B) — fail-closed bare dispatch (DB-backed via withTestDb).
//
// P8(A): a persisted data-plane endpoint with an unrecognized / empty scheme is
//        row CORRUPTION and must yield a runtime_constraint error, NOT a silent
//        fall-through to the LOCAL plane executing on the API host.
// P2(B): when SANDBOX_PROVIDER=none the (kind='sandbox') bare dispatch is refused
//        — and a non-none provider is NOT blanket-gated (it still dispatches).

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kysely } from "kysely"
import type { OperationEnvelope } from "@synapse/device-protocol"
import { withTestDb } from "../../test/helpers/db.js"
import { mintBareSandboxRuntimeTx } from "../devices/repo.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"
import { buildBareCoreCatalog } from "./core-catalog.js"
import {
  createLocalBareDataPlane,
  type SandboxDataPlane,
} from "./data-plane.js"
import {
  dispatchBareRuntimeTool,
  registerBareDataPlane,
  getLiveBareDataPlane,
  __clearBareDataPlanes,
} from "./bare-dispatch.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"
import { decodeSandboxCapabilityDescriptor } from "./model.js"

function uniq(p: string): string {
  return `${p}-${Math.random().toString(36).slice(2, 10)}`
}

async function seedSession(
  db: Kysely<any>
): Promise<{ workspaceId: string; sessionId: string }> {
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@fc`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ ownerId: user.id, slug: uniq("ws"), name: "fc ws" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const createdBySubjectId = (
    await db
      .insertInto("accessSubjects")
      .values({ kind: "workspace", workspaceId: ws.id } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  const actorRoot = await db
    .insertInto("workspaceResources")
    .values({
      id: randomUUID(),
      workspaceId: ws.id,
      kind: "actor",
      displayName: uniq("a"),
      status: "active",
      createdBySubjectId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      currentVersion: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ workspaceId: ws.id, kind: "direct", title: "t" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspaceId: ws.id,
      conversationId: conv.id,
      actorId: actor.id,
      status: "running",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return { workspaceId: ws.id as string, sessionId: session.id as string }
}

async function makePlaneRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "synapse-bare-fc-"))
  const root = join(base, "sandbox")
  for (const sub of ["conversation", "actor", "actor-conversation"]) {
    await mkdir(join(root, sub), { recursive: true })
  }
  await writeFile(join(root, "conversation", "hello.txt"), "hi from bare")
  return root
}

function fsReadGrant(): RuntimeAuthorizationGrantRecord {
  return {
    capability: "filesystem",
    filesystem: { access: "read", pathPrefixes: ["/conversation"] },
  } as unknown as RuntimeAuthorizationGrantRecord
}

function envelopeFor(args: {
  exposureId: string
  toolId: string
  toolRevisionId: string
  expiresAt: string
}): OperationEnvelope {
  return {
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    runtime_session_id: randomUUID(),
    runtime_capability_id: randomUUID(),
    runtime_exposure_id: args.exposureId,
    runtime_tool_id: args.toolId,
    runtime_tool_revision_id: args.toolRevisionId,
    input_hash: "sha256:deadbeef",
    task_mode: "sync",
    runtime_authorization: {
      grant_ids: [],
      grant_scope: "actor",
      grant_specs: [],
    },
    issued_at: new Date().toISOString(),
    expires_at: args.expiresAt,
  } as unknown as OperationEnvelope
}

/** Mint an ACTIVE bare runtime, then overwrite its persisted endpoint. */
async function seedActiveBareRuntime(
  db: Kysely<any>,
  endpoint: string
): Promise<{
  runtimeId: string
  serviceId: string
  exposureId: string
  toolId: string
  toolRevisionId: string
}> {
  const { workspaceId, sessionId } = await seedSession(db)
  const runtimeId = randomUUID()
  const serviceId = randomUUID()
  const descriptor = buildLocalBareDescriptor({ isolation: "bwrap" })
  const minted = await mintBareSandboxRuntimeTx({
    runtimeId,
    workspaceId,
    sessionId,
    serviceId,
    adapter: "local",
    dataPlaneEndpoint: `inprocess:${runtimeId}`,
    capabilityDescriptor: descriptor as unknown as Record<string, unknown>,
    exposures: buildBareCoreCatalog(descriptor),
    executor: db,
  })
  // mint defaults to state='provisioning'; promote to 'active' so the row-validation
  // gate passes and dispatch reaches the endpoint-scheme guard (P8A).
  await db
    .updateTable("sandboxes")
    .set({ state: "active" } as any)
    .where("id", "=", runtimeId)
    .execute()
  // Corrupt / rewrite the persisted endpoint scheme.
  await db
    .updateTable("runtimeServices")
    .set({ dataPlaneEndpoint: endpoint } as any)
    .where("id", "=", serviceId)
    .execute()
  const fsIds = minted.assignedIds["builtin/filesystem"]!
  const fsRead = fsIds.tools["fs_read"]!
  return {
    runtimeId,
    serviceId,
    exposureId: fsIds.runtime_exposure_id,
    toolId: fsRead.runtime_tool_id,
    toolRevisionId: fsRead.runtime_tool_revision_id,
  }
}

for (const badEndpoint of ["https://attacker.example", "", "inprocessTYPO:x"]) {
  test(`P8(A): endpoint scheme '${badEndpoint || "(empty)"}' → runtime_constraint, NOT local-plane execution`, async () => {
    await withTestDb(async (db) => {
      __clearBareDataPlanes()
      const r = await seedActiveBareRuntime(db, badEndpoint)
      // Registry MISS (no live plane) → the rebuild-on-miss path runs the guard.
      const res = await dispatchBareRuntimeTool({
        runtimeId: r.runtimeId,
        runtimeServiceId: r.serviceId,
        envelope: envelopeFor({
          exposureId: r.exposureId,
          toolId: r.toolId,
          toolRevisionId: r.toolRevisionId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        args: { path: "/conversation/hello.txt" },
        builtinKind: "filesystem",
        toolName: "fs_read",
        grant: fsReadGrant(),
        run: db,
        // Pass the P2(B) none-gate so we actually reach the P8(A) endpoint guard.
        sandboxProvider: "local",
      })
      assert.equal(res.ok, false, "corrupt endpoint must NOT dispatch")
      assert.equal(res.error?.code, "runtime_constraint")
      assert.match(res.error?.message ?? "", /endpoint scheme|rebuild refused/)
      // The decisive proof it did NOT fall through to a LOCAL plane on the API
      // host: no plane was ever built/registered for this runtime.
      assert.equal(
        getLiveBareDataPlane(r.runtimeId),
        undefined,
        "no local plane built — endpoint corruption is not an implicit local plane"
      )
      __clearBareDataPlanes()
    })
  })
}

// P1.3(a) unit guard: the repo-exit decoder must ALLOW isolation:null (a
// no-commandline sandbox is a valid, common shape) yet REJECT a corrupt cap.
test("P1.3(a): decodeSandboxCapabilityDescriptor allows isolation:null and rejects a non-number cap", () => {
  const ok = buildLocalBareDescriptor({ isolation: null })
  assert.ok(
    decodeSandboxCapabilityDescriptor(ok),
    "isolation:null must decode — a sandbox with no commandline is valid"
  )
  const corrupt = { ...ok, core: { ...ok.core, maxWriteBytes: "corrupt" } }
  assert.equal(
    decodeSandboxCapabilityDescriptor(corrupt),
    null,
    "a non-number safety cap must fail the decode (fail-closed)"
  )
})

// P1.3(a): a corrupt persisted descriptor (the review's maxWriteBytes:"corrupt")
// must fail the WHOLE bare dispatch closed at the rebuild-on-miss path, never run
// the plane with a NaN/defaulted safety cap.
test("P1.3(a): a corrupt capability_descriptor fails the bare dispatch CLOSED (no plane built)", async () => {
  await withTestDb(async (db) => {
    __clearBareDataPlanes()
    const { workspaceId, sessionId } = await seedSession(db)
    const runtimeId = randomUUID()
    const serviceId = randomUUID()
    const good = buildLocalBareDescriptor({ isolation: "bwrap" })
    const corrupt = { ...good, core: { ...good.core, maxWriteBytes: "corrupt" } }
    const minted = await mintBareSandboxRuntimeTx({
      runtimeId,
      workspaceId,
      sessionId,
      serviceId,
      adapter: "local",
      dataPlaneEndpoint: `inprocess:${runtimeId}`,
      capabilityDescriptor: corrupt as unknown as Record<string, unknown>,
      exposures: buildBareCoreCatalog(good),
      executor: db,
    })
    await db
      .updateTable("sandboxes")
      .set({ state: "active" } as any)
      .where("id", "=", runtimeId)
      .execute()
    const fsIds = minted.assignedIds["builtin/filesystem"]!
    const fsRead = fsIds.tools["fs_read"]!
    const res = await dispatchBareRuntimeTool({
      runtimeId,
      runtimeServiceId: serviceId,
      envelope: envelopeFor({
        exposureId: fsIds.runtime_exposure_id,
        toolId: fsRead.runtime_tool_id,
        toolRevisionId: fsRead.runtime_tool_revision_id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem",
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
      sandboxProvider: "local",
    })
    assert.equal(res.ok, false, "corrupt descriptor must NOT dispatch")
    assert.equal(res.error?.code, "runtime_constraint")
    assert.match(res.error?.message ?? "", /descriptor|rebuild refused/)
    assert.equal(
      getLiveBareDataPlane(runtimeId),
      undefined,
      "no plane built on a corrupt descriptor"
    )
    __clearBareDataPlanes()
  })
})

// P1.3(c): a WELL-FORMED but wrong-adapter endpoint (docker-exec: on a local
// sandbox) is a MISMATCH. The old scheme-only guard accepted any recognized
// scheme and would have built a DOCKER plane for a LOCAL sandbox; the
// adapter-bound guard denies it.
test("P1.3(c): a docker-exec: endpoint on a LOCAL adapter is a mismatch → runtime_constraint", async () => {
  await withTestDb(async (db) => {
    __clearBareDataPlanes()
    const r = await seedActiveBareRuntime(db, `docker-exec:${randomUUID()}`)
    const res = await dispatchBareRuntimeTool({
      runtimeId: r.runtimeId,
      runtimeServiceId: r.serviceId,
      envelope: envelopeFor({
        exposureId: r.exposureId,
        toolId: r.toolId,
        toolRevisionId: r.toolRevisionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem",
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
      sandboxProvider: "local",
    })
    assert.equal(res.ok, false, "wrong-adapter endpoint must NOT dispatch")
    assert.equal(res.error?.code, "runtime_constraint")
    assert.match(res.error?.message ?? "", /does not match adapter|rebuild refused/)
    assert.equal(getLiveBareDataPlane(r.runtimeId), undefined)
    __clearBareDataPlanes()
  })
})

test("P2(B): a bare sandbox dispatch is refused when SANDBOX_PROVIDER=none (and dispatches otherwise)", async () => {
  await withTestDb(async (db) => {
    __clearBareDataPlanes()
    const r = await seedActiveBareRuntime(db, `inprocess:${randomUUID()}`)
    // A registry HIT (live plane bound to a real temp root) so a non-none provider
    // would genuinely dispatch — proving the gate is strictly the none-refusal.
    const root = await makePlaneRoot()
    const plane: SandboxDataPlane = createLocalBareDataPlane({
      sandboxRoot: root,
      descriptor: buildLocalBareDescriptor({ isolation: "bwrap" }),
    })
    registerBareDataPlane(r.runtimeId, plane)

    const base = {
      runtimeId: r.runtimeId,
      runtimeServiceId: r.serviceId,
      envelope: envelopeFor({
        exposureId: r.exposureId,
        toolId: r.toolId,
        toolRevisionId: r.toolRevisionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem" as const,
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
    }

    // provider=none → refused.
    const denied = await dispatchBareRuntimeTool({
      ...base,
      sandboxProvider: "none",
    })
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, "runtime_constraint")
    assert.match(denied.error?.message ?? "", /SANDBOX_PROVIDER=none/)

    // provider=local (same target) → NOT blanket-gated; dispatches to the plane.
    const ok = await dispatchBareRuntimeTool({
      ...base,
      sandboxProvider: "local",
    })
    assert.equal(ok.ok, true, "a non-none provider is not blanket-gated")
    __clearBareDataPlanes()
  })
})
