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
  getLiveBareDataPlane,
  __clearBareDataPlanes,
} from "./bare-dispatch.js"
import { markSandboxResourceGone, teardownSandbox } from "./service.js"
import {
  casFlipSandboxClosing,
  readSandboxTeardownEpoch,
  casCloseSandboxAtEpoch,
} from "./repo.js"
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

test("B1/B2: mintBareSandboxRuntimeTx mints mode=bare + bare_dataplane (NO keypair) and persists the descriptor-gated api-authored catalog", async () => {
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

    // B2: catalog persisted; descriptor-gated (filesystem + commandline).
    const exps = await db
      .selectFrom("runtimeExposures")
      .select(["builtinKind", "runtimeStatus"])
      .where("runtimeId", "=", runtimeId)
      .execute()
    const kinds = exps.map((e) => e.builtinKind).sort()
    assert.deepEqual(kinds, ["commandline", "filesystem"])
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

test("#5-B: a HIT whose row went 'closing' cross-process is denied + the stale plane is dropped", async () => {
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
    const root = await makePlaneRoot()
    const plane: SandboxDataPlane = createLocalBareDataPlane({
      sandboxRoot: root,
      descriptor,
    })
    registerBareDataPlane(runtimeId, plane)
    // Simulate a CROSS-PROCESS teardown: another replica flipped the row to
    // 'closing' WITHOUT touching this process's in-process registry/tombstone. The
    // in-process close-gate (closingBarePlanes) is empty here, so only the #5-B
    // persisted-state re-check can catch it.
    await db
      .updateTable("sandboxes")
      .set({ state: "closing" } as never)
      .where("id", "=", runtimeId)
      .execute()
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
      sandboxProvider: "local",
    })
    assert.equal(res.ok, false)
    assert.equal(res.error?.code, "runtime_constraint")
    assert.match(res.error?.message ?? "", /no longer active|cross-process/)
    assert.equal(
      getLiveBareDataPlane(runtimeId),
      undefined,
      "the stale local plane is dropped so the next dispatch re-gates via the DB"
    )
    __clearBareDataPlanes()
  })
})

test("resource_gone flips an active sandbox to 'closing' (NOT 'failed') so teardown still converges its mounts", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, sessionId } = await seedSession(db)
    const runtimeId = randomUUID()
    const serviceId = randomUUID()
    const descriptor = buildLocalBareDescriptor({ isolation: "bwrap" })
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
    // Model a LIVE sandbox mid-turn.
    await db
      .updateTable("sandboxes")
      .set({ state: "active" } as never)
      .where("id", "=", runtimeId)
      .execute()

    await markSandboxResourceGone(runtimeId, db)

    // The regression this guards: flipping to 'failed' left mounts stranded because
    // the Link A close-gate CAS excludes 'failed' → every teardown bailed → re-provision
    // collided on the partial unique index forever. 'closing' IS in the CAS set, so a
    // later teardown/reaper converges the row.
    const row = await db
      .selectFrom("sandboxes")
      .select("state")
      .where("id", "=", runtimeId)
      .executeTakeFirstOrThrow()
    assert.equal(
      row.state,
      "closing",
      "resource_gone must leave a convergeable 'closing' row"
    )

    // Idempotent + safe: a second call (or a call after teardown drove it terminal) is a
    // no-op, never resurrecting a closed row.
    await db
      .updateTable("sandboxes")
      .set({ state: "closed" } as never)
      .where("id", "=", runtimeId)
      .execute()
    await markSandboxResourceGone(runtimeId, db)
    const row2 = await db
      .selectFrom("sandboxes")
      .select("state")
      .where("id", "=", runtimeId)
      .executeTakeFirstOrThrow()
    assert.equal(
      row2.state,
      "closed",
      "a terminal row is never resurrected to 'closing'"
    )
  })
})

test("#3 closing reaper with a runtimeId does DATA-FREE convergence of the STALE runtime, never the re-provisioned active one", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, sessionId } = await seedSession(db)
    const descriptor = buildLocalBareDescriptor({ isolation: "bwrap" })
    const mint = async () => {
      const runtimeId = randomUUID()
      const serviceId = randomUUID()
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
      return runtimeId
    }
    const setState = (id: string, state: string) =>
      db
        .updateTable("sandboxes")
        .set({ state } as never)
        .where("id", "=", id)
        .execute()

    // R_old goes 'closing' (a stuck straggler); then the session is re-provisioned
    // → R_new 'active'. The partial-unique index permits this coexistence.
    const rOld = await mint()
    await setState(rOld, "closing")
    const rNew = await mint()
    await setState(rNew, "active")

    // The closing reaper targets the SPECIFIC stale runtime.
    await teardownSandbox(sessionId, { runtimeId: rOld, executor: db })

    const oldRow = await db
      .selectFrom("sandboxes")
      .select("state")
      .where("id", "=", rOld)
      .executeTakeFirstOrThrow()
    const newRow = await db
      .selectFrom("sandboxes")
      .select("state")
      .where("id", "=", rNew)
      .executeTakeFirstOrThrow()
    const newRuntime = await db
      .selectFrom("runtimes")
      .select("deletedAt")
      .where("id", "=", rNew)
      .executeTakeFirstOrThrow()

    assert.equal(
      oldRow.state,
      "closed",
      "the stale runtime is converged terminal"
    )
    assert.equal(
      newRow.state,
      "active",
      "the re-provisioned runtime is UNTOUCHED"
    )
    assert.equal(
      newRuntime.deletedAt,
      null,
      "the re-provisioned runtime is NOT soft-deleted by the stale reaper"
    )
  })
})

// ── #6: durable teardown-epoch lease (multi-replica single-owner fencing) ──────

test("#6: casFlipSandboxClosing bumps + returns the epoch; a re-flip supersedes the prior lease", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, sessionId } = await seedSession(db)
    const runtimeId = randomUUID()
    await mintBareSandboxRuntimeTx({
      runtimeId,
      workspaceId,
      sessionId,
      serviceId: randomUUID(),
      adapter: "local",
      dataPlaneEndpoint: `inprocess:${runtimeId}`,
      capabilityDescriptor: buildLocalBareDescriptor({
        isolation: "bwrap",
      }) as unknown as Record<string, unknown>,
      exposures: [],
      executor: db,
    })

    // First flip: epoch 0 → 1, returned as the caller's lease N.
    const first = await casFlipSandboxClosing(runtimeId, db)
    assert.equal(first.flipped, true)
    assert.equal(first.epoch, 1n)
    assert.equal(await readSandboxTeardownEpoch(runtimeId, db), 1n)

    // A concurrent teardown/reaper re-flips (self-flip on 'closing') → epoch 2.
    const second = await casFlipSandboxClosing(runtimeId, db)
    assert.equal(second.flipped, true)
    assert.equal(second.epoch, 2n)

    // The FIRST teardown's terminal write (holding stale N=1) MUST no-op — it was
    // superseded — so it can't stamp a terminal state over the current owner's row.
    const staleClose = await casCloseSandboxAtEpoch(
      runtimeId,
      1n,
      { state: "closed" },
      db
    )
    assert.equal(staleClose, false, "stale-epoch terminal write no-ops")
    const stillClosing = await db
      .selectFrom("sandboxes")
      .select("state")
      .where("id", "=", runtimeId)
      .executeTakeFirstOrThrow()
    assert.equal(
      stillClosing.state,
      "closing",
      "row stays 'closing' for the owner"
    )

    // The CURRENT owner (N=2) writes the terminal state successfully.
    const ownerClose = await casCloseSandboxAtEpoch(
      runtimeId,
      2n,
      { state: "closed" },
      db
    )
    assert.equal(ownerClose, true, "current-lease terminal write lands")
    const closed = await db
      .selectFrom("sandboxes")
      .select("state")
      .where("id", "=", runtimeId)
      .executeTakeFirstOrThrow()
    assert.equal(closed.state, "closed")
  })
})

test("#6: casFlipSandboxClosing on a terminal row does not flip and returns no epoch", async () => {
  await withTestDb(async (db) => {
    const { workspaceId, sessionId } = await seedSession(db)
    const runtimeId = randomUUID()
    await mintBareSandboxRuntimeTx({
      runtimeId,
      workspaceId,
      sessionId,
      serviceId: randomUUID(),
      adapter: "local",
      dataPlaneEndpoint: `inprocess:${runtimeId}`,
      capabilityDescriptor: buildLocalBareDescriptor({
        isolation: "bwrap",
      }) as unknown as Record<string, unknown>,
      exposures: [],
      executor: db,
    })
    // Drive it terminal.
    const flip = await casFlipSandboxClosing(runtimeId, db)
    await casCloseSandboxAtEpoch(
      runtimeId,
      flip.epoch!,
      { state: "closed" },
      db
    )
    // A later teardown finds a terminal row → no flip, no lease.
    const late = await casFlipSandboxClosing(runtimeId, db)
    assert.equal(late.flipped, false)
    assert.equal(late.epoch, null)
  })
})
