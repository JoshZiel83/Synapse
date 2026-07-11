// Mode-B (local:bare) acceptance — DB-backed: the bare MINT (B1/B2) + the pure
// dispatch FORK (B3/B11). Ephemeral testcontainer DB via withTestDb; the mint's
// executor seam runs against it.

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
import { getRuntimeEndpointRegistry } from "../devices/tunnel-registry.js"
import { buildLocalBareDescriptor } from "./adapter-registry.js"
import { buildBareCoreCatalog } from "./core-catalog.js"
import {
  createLocalBareDataPlane,
  type SandboxDataPlane,
} from "./data-plane.js"
import {
  dispatchBareRuntimeTool,
  registerBareDataPlane,
  __clearBareDataPlanes,
} from "./bare-dispatch.js"
import type { RuntimeAuthorizationGrantRecord } from "../runtime-authorizations/repo.types.js"

function uniq(p: string): string {
  return `${p}-${Math.random().toString(36).slice(2, 10)}`
}

async function seedSession(
  db: Kysely<any>
): Promise<{ workspaceId: string; sessionId: string }> {
  const user = await db
    .insertInto("users")
    .values({ email: `${uniq("u")}@bare`, name: "u" })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({ owner_id: user.id, slug: uniq("ws"), name: "bare ws" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const createdBySubjectId = (
    await db
      .insertInto("access_subjects")
      .values({ kind: "workspace", workspace_id: ws.id } as any)
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id as string
  const actorRoot = await db
    .insertInto("workspace_resources")
    .values({
      id: randomUUID(),
      workspace_id: ws.id,
      kind: "actor",
      display_name: uniq("a"),
      status: "active",
      created_by_subject_id: createdBySubjectId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const actor = await db
    .insertInto("actors")
    .values({
      id: actorRoot.id as string,
      role: "assistant",
      title: "t",
      current_version: 1,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ workspace_id: ws.id, kind: "direct", title: "t" } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const session = await db
    .insertInto("sessions")
    .values({
      workspace_id: ws.id,
      conversation_id: conv.id,
      actor_id: actor.id,
      status: "running",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return { workspaceId: ws.id as string, sessionId: session.id as string }
}

async function makePlaneRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "synapse-bare-dispatch-"))
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
  capabilityId: string
  expiresAt: string
}): OperationEnvelope {
  return {
    operation_id: randomUUID(),
    attempt_id: randomUUID(),
    runtime_session_id: randomUUID(),
    runtime_capability_id: args.capabilityId,
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

test("B1/B2: mintBareSandboxRuntimeTx mints mode=bare + bare_dataplane (NO keypair) and persists the descriptor-gated api-authored catalog (no pty)", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, sessionId } = await seedSession(db)
    const runtimeId = randomUUID()
    const serviceId = randomUUID()
    const descriptor = buildLocalBareDescriptor({
      isolation: "bwrap",
      search: true,
    })
    const exposures = buildBareCoreCatalog(descriptor)

    const res = await mintBareSandboxRuntimeTx({
      runtimeId,
      workspaceId,
      sessionId,
      serviceId,
      adapter: "local",
      dataPlaneEndpoint: `inprocess:${runtimeId}`,
      capabilityDescriptor: descriptor as unknown as Record<string, unknown>,
      exposures,
      executor: db,
    })

    // B1: sandboxes row is mode='bare', pairing_session_id NULL.
    const sb = await db
      .selectFrom("sandboxes")
      .select(["mode", "adapter", "pairingSessionId"])
      .where("id", "=", runtimeId)
      .executeTakeFirstOrThrow()
    assert.equal(sb.mode, "bare")
    assert.equal(sb.adapter, "local")
    assert.equal(sb.pairingSessionId, null, "a bare sandbox never pairs")

    // B1: runtime_services is bare_dataplane w/ a non-dialable inprocess endpoint.
    const svc = await db
      .selectFrom("runtimeServices")
      .select(["serviceKind", "dataPlaneEndpoint"])
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow()
    assert.equal(svc.serviceKind, "bare_dataplane")
    assert.match(String(svc.dataPlaneEndpoint), /^inprocess:/)

    // B1: NO runtime_service_keys (no keypair, no broker).
    const keys = await db
      .selectFrom("runtimeServiceKeys")
      .select(["id"])
      .where("serviceId", "=", serviceId)
      .execute()
    assert.equal(keys.length, 0, "bare sandbox mints NO service keypair")

    // B2: catalog persisted; descriptor-gated (filesystem + commandline; NO pty).
    const exps = await db
      .selectFrom("runtimeExposures")
      .select(["builtinKind", "runtimeStatus"])
      .where("runtimeId", "=", runtimeId)
      .execute()
    const kinds = exps.map((e) => e.builtinKind).sort()
    assert.deepEqual(kinds, ["commandline", "filesystem"])
    assert.ok(!kinds.includes("pty" as never), "NO pty exposure (F-D)")
    assert.ok(exps.every((e) => e.runtimeStatus === "healthy"))

    // assignedIds surfaced for the fork's target-id check.
    assert.ok(
      res.assignedIds["builtin/filesystem"]?.tools["fs_read"]?.runtime_tool_id
    )
  })
})

test("B2: isolation:null → NO commandline exposure (fail-closed, descriptor-gated)", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, sessionId } = await seedSession(db)
    const runtimeId = randomUUID()
    const serviceId = randomUUID()
    const descriptor = buildLocalBareDescriptor({ isolation: null })
    await mintBareSandboxRuntimeTx({
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
    const exps = await db
      .selectFrom("runtimeExposures")
      .select(["builtinKind"])
      .where("runtimeId", "=", runtimeId)
      .execute()
    assert.deepEqual(
      exps.map((e) => e.builtinKind),
      ["filesystem"],
      "no bwrap ⇒ no commandline exposure"
    )
  })
})

test("B3/B11: dispatchBareRuntimeTool routes to the plane, checks envelope expiry + target-id binding, and registers NO tunnel endpoint", async () => {
  await withTestDb(async (db) => {
    __clearBareDataPlanes()
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
    const fsIds = minted.assignedIds["builtin/filesystem"]!
    const fsRead = fsIds.tools["fs_read"]!

    // Register a live plane bound to a real temp sandbox (registry HIT path).
    const root = await makePlaneRoot()
    const plane: SandboxDataPlane = createLocalBareDataPlane({
      sandboxRoot: root,
      descriptor,
    })
    registerBareDataPlane(runtimeId, plane)

    // B3: no tunnel endpoint is EVER registered for a bare runtime.
    assert.equal(
      getRuntimeEndpointRegistry().resolve(serviceId),
      undefined,
      "bare fork registers no tunnel endpoint"
    )

    const future = new Date(Date.now() + 60_000).toISOString()
    const okRes = await dispatchBareRuntimeTool({
      runtimeId,
      runtimeServiceId: serviceId,
      envelope: envelopeFor({
        exposureId: fsIds.runtime_exposure_id,
        toolId: fsRead.runtime_tool_id,
        toolRevisionId: fsRead.runtime_tool_revision_id,
        capabilityId: randomUUID(),
        expiresAt: future,
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem",
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
      // These tests simulate an active-provider world (a bare sandbox only exists
      // when the substrate is enabled); force it so the P2(B) none-gate doesn't
      // pre-empt the dispatch under the test env's ambient SANDBOX_PROVIDER=none.
      sandboxProvider: "local",
    })
    assert.equal(okRes.ok, true, "fresh envelope dispatches to the plane")
    const body = JSON.parse(
      (okRes.result as { content: { text: string }[] }).content[0]!.text
    )
    assert.equal(body.content, "hi from bare")

    // B11: an EXPIRED envelope is rejected in-fork.
    const expired = await dispatchBareRuntimeTool({
      runtimeId,
      runtimeServiceId: serviceId,
      envelope: envelopeFor({
        exposureId: fsIds.runtime_exposure_id,
        toolId: fsRead.runtime_tool_id,
        toolRevisionId: fsRead.runtime_tool_revision_id,
        capabilityId: randomUUID(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem",
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
      // These tests simulate an active-provider world (a bare sandbox only exists
      // when the substrate is enabled); force it so the P2(B) none-gate doesn't
      // pre-empt the dispatch under the test env's ambient SANDBOX_PROVIDER=none.
      sandboxProvider: "local",
    })
    assert.equal(expired.ok, false)
    assert.equal(expired.error?.code, "runtime_constraint")
    assert.match(expired.error?.message ?? "", /expired/)

    // Target-id binding: a cross-runtime exposure id does NOT bind.
    const wrongTarget = await dispatchBareRuntimeTool({
      runtimeId,
      runtimeServiceId: serviceId,
      envelope: envelopeFor({
        exposureId: randomUUID(),
        toolId: fsRead.runtime_tool_id,
        toolRevisionId: fsRead.runtime_tool_revision_id,
        capabilityId: randomUUID(),
        expiresAt: future,
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem",
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
      // These tests simulate an active-provider world (a bare sandbox only exists
      // when the substrate is enabled); force it so the P2(B) none-gate doesn't
      // pre-empt the dispatch under the test env's ambient SANDBOX_PROVIDER=none.
      sandboxProvider: "local",
    })
    assert.equal(wrongTarget.ok, false)
    assert.equal(wrongTarget.error?.code, "permission_denied")
    __clearBareDataPlanes()
  })
})

test("B3: lazy rebuild-on-miss hard-denies a non-active/deleted runtime (registry miss branch)", async () => {
  await withTestDb(async (db) => {
    __clearBareDataPlanes()
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
    const fsIds = minted.assignedIds["builtin/filesystem"]!
    const fsRead = fsIds.tools["fs_read"]!
    // No live plane registered → registry MISS. State is 'provisioning' (mint
    // default), not 'active' ⇒ hard deny (rebuild refused).
    const res = await dispatchBareRuntimeTool({
      runtimeId,
      runtimeServiceId: serviceId,
      envelope: envelopeFor({
        exposureId: fsIds.runtime_exposure_id,
        toolId: fsRead.runtime_tool_id,
        toolRevisionId: fsRead.runtime_tool_revision_id,
        capabilityId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      args: { path: "/conversation/hello.txt" },
      builtinKind: "filesystem",
      toolName: "fs_read",
      grant: fsReadGrant(),
      run: db,
      // These tests simulate an active-provider world (a bare sandbox only exists
      // when the substrate is enabled); force it so the P2(B) none-gate doesn't
      // pre-empt the dispatch under the test env's ambient SANDBOX_PROVIDER=none.
      sandboxProvider: "local",
    })
    assert.equal(res.ok, false)
    assert.equal(res.error?.code, "runtime_constraint")
    assert.match(res.error?.message ?? "", /rebuild refused/)
    __clearBareDataPlanes()
  })
})
