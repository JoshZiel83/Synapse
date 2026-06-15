// Devices module repo: the single file in this module allowed to import the
// DB client (guard r8) and the raw `sql` tag. Every direct query that used to
// live in the module's service/transport/route files (access-bindings.ts,
// cloud.ts, control-plane.ts, control-plane-events.ts, operations.ts) is
// centralised here. Functions return camelCase domain records and KEEP Date
// objects (no serialization — that is a presenter concern, guard r3). Raw
// `sql` fragments (NOW(), ::jsonb casts, literal status comparisons) are copied
// verbatim from the original sites so semantics (incl. snake_case literals that
// intentionally bypass the CamelCasePlugin) are preserved exactly.

import { createHash, randomUUID } from "node:crypto"
import { sql } from "kysely"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import {
  db,
  type DatabaseTransaction,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/root-storage.js"
import type {
  BeginOperationInput,
  BeginOperationResult,
  CompleteOperationInput,
} from "./operations.js"
import {
  assertNoDeviceToolRevisionDrift,
  beginDeviceOperationOn,
} from "./operations.js"
import type {
  DeviceCapabilityRecord,
  DeviceDetailRecord,
  DeviceServiceRecord,
  DeviceSummaryRecord,
} from "./repo.types.js"
import type {
  DeviceServiceKind,
  DeviceTrustStatus,
  DeviceType,
  HostKind,
} from "@synapse/device-protocol/enums"

// ════════════════════════════════════════════════════════════════════════════
// access-bindings.ts — workspace-ownership validation reads
// ════════════════════════════════════════════════════════════════════════════

/** actor ⋈ workspaceApps: returns the actor's owning workspace (app not deleted). */
export async function findActorWorkspace(
  actorId: string
): Promise<{ workspaceId: string } | undefined> {
  const row = await db
    .selectFrom("actors as actor")
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select("app.workspaceId as workspaceId")
    .where("actor.id", "=", actorId)
    .where("app.deletedAt", "is", null)
    .executeTakeFirst()
  return row ? { workspaceId: row.workspaceId as string } : undefined
}

/** conversations lookup: returns the conversation's owning workspace. */
export async function findConversationWorkspace(
  conversationId: string
): Promise<{ workspaceId: string } | undefined> {
  const row = await db
    .selectFrom("conversations")
    .select("workspaceId")
    .where("id", "=", conversationId)
    .executeTakeFirst()
  return row ? { workspaceId: row.workspaceId as string } : undefined
}

/** remoteAgents ⋈ workspaceApps: returns the agent's owning workspace (app not deleted). */
export async function findRemoteAgentWorkspace(
  remoteAgentId: string
): Promise<{ workspaceId: string } | undefined> {
  const row = await db
    .selectFrom("remoteAgents as agent")
    .innerJoin("workspaceApps as app", "app.id", "agent.id")
    .select("app.workspaceId as workspaceId")
    .where("agent.id", "=", remoteAgentId)
    .where("app.deletedAt", "is", null)
    .executeTakeFirst()
  return row ? { workspaceId: row.workspaceId as string } : undefined
}

/**
 * deviceCapabilities ⋈ workspaceApps: of the requested capabilityIds, return
 * the set actually owned by `workspaceId` (app not deleted). The caller derives
 * the `missing` set from this — ownership comparison is validation, not query.
 */
export async function findOwnedDeviceCapabilityIds(
  workspaceId: string,
  capabilityIds: string[]
): Promise<Set<string>> {
  if (capabilityIds.length === 0) return new Set()
  const rows = await db
    .selectFrom("deviceCapabilities as capability")
    .innerJoin("workspaceApps as app", "app.id", "capability.id")
    .select(["capability.id as id", "app.workspaceId as workspaceId"])
    .where("capability.id", "in", capabilityIds)
    .where("app.deletedAt", "is", null)
    .execute()
  return new Set(
    rows.filter((r) => r.workspaceId === workspaceId).map((r) => r.id as string)
  )
}

// ════════════════════════════════════════════════════════════════════════════
// cloud.ts — cloud bootstrap pairing
// ════════════════════════════════════════════════════════════════════════════

/** Insert a cloud_bootstrap pairing session. `contextJson` is the plain JSON
 *  string the caller built; the ::jsonb cast lives here. */
export async function insertCloudPairingSession(args: {
  sessionId: string
  workspaceId: string
  requestedByWorkspaceMemberId: string | null
  requestedTitle: string
  bootstrapTokenHash: Buffer
  expiresAt: Date
  contextJson: string
}): Promise<void> {
  await db
    .insertInto("devicePairingSessions")
    .values({
      id: args.sessionId,
      workspaceId: args.workspaceId,
      requestedByWorkspaceMemberId: args.requestedByWorkspaceMemberId,
      deviceId: null,
      mode: "cloud_bootstrap",
      serverBaseUrl: "",
      requestedTitle: args.requestedTitle,
      bootstrapTokenHash: args.bootstrapTokenHash,
      pairingCode: null,
      expiresAt: args.expiresAt,
      status: "pending",
      context: sql`${args.contextJson}::jsonb`,
    } as never)
    .execute()
}

/** camelCase domain record of a consumed bootstrap pairing session — Date
 *  instants preserved; `context` returned raw so cloud.ts can decode the rest. */
export interface ConsumedCloudPairingSession {
  id: string
  workspaceId: string
  requestedByWorkspaceMemberId: string | null
  requestedTitle: string | null
  context: Record<string, unknown>
  status: string
  expiresAt: Date | null
}

export type ConsumeCloudBootstrapResult =
  | {
      outcome: "ok"
      session: ConsumedCloudPairingSession
      pendingDeviceId: string
      hostProvider: string
    }
  | {
      outcome: "not_found" | "not_pending" | "expired" | "race" | "corrupt"
      existingStatus?: string
      existingExpiresAt?: Date | null
    }

/**
 * Owns the whole consume transaction: claim UPDATE (returningAll), diagnostic
 * SELECT, three INSERTs (devices, deviceServices, deviceServiceKeys) and the
 * device_id FK backfill — atomic in ONE db.transaction(). Returns a
 * discriminated domain result; the 404/409/410/500 DeviceModuleError mapping +
 * wire-shape assembly stay in cloud.ts. `pending_device_id` / `host_provider`
 * are extracted from the claimed session's context HERE (they are only known
 * after the claim and gate the device INSERT), and surfaced on the `ok`
 * result so cloud.ts can build the wire response.
 */
export async function consumeCloudBootstrapTx(args: {
  tokenHash: Buffer
  device: {
    platform: string
    arch: string
    publicKey: string
    publicKeyFingerprint: string
  }
  service: { serviceId: string; version: string | null }
  serviceKey: {
    serviceKeyId: string
    pubkey: string
    pubkeyFingerprint: string
  }
}): Promise<ConsumeCloudBootstrapResult> {
  return db.transaction().execute(async (trx) => {
    // Atomic single-shot consume: flip status to "consumed" only if the
    // session is still pending + matching mode + not expired. Two concurrent
    // sandbox boots can no longer both succeed and double-insert a device.
    const claimedRows = await trx
      .updateTable("devicePairingSessions")
      .set({
        status: "consumed",
        confirmedAt: sql`NOW()`,
        consumedAt: sql`NOW()`,
      } as never)
      .where("bootstrapTokenHash", "=", args.tokenHash)
      .where("status", "=", "pending")
      .where("mode", "=", "cloud_bootstrap")
      .where("expiresAt", ">", sql<Date>`NOW()`)
      .returningAll()
      .execute()
    const session = claimedRows[0]
    if (!session) {
      // Diagnose which precondition failed for a sharper error code.
      const existing = await trx
        .selectFrom("devicePairingSessions")
        .selectAll()
        .where("bootstrapTokenHash", "=", args.tokenHash)
        .where("mode", "=", "cloud_bootstrap")
        .executeTakeFirst()
      if (!existing) {
        return { outcome: "not_found" }
      }
      if ((existing.status as string) !== "pending") {
        return {
          outcome: "not_pending",
          existingStatus: existing.status as string,
        }
      }
      const existingExpiresAt = new Date(
        existing.expiresAt as unknown as string
      ).getTime()
      if (
        Number.isFinite(existingExpiresAt) &&
        existingExpiresAt < Date.now()
      ) {
        return { outcome: "expired" }
      }
      return { outcome: "race" }
    }

    const context = (session.context ?? {}) as Record<string, unknown>
    const pendingDeviceId = context["pending_device_id"] as string | undefined
    if (!pendingDeviceId) {
      return { outcome: "corrupt" }
    }
    const hostProvider =
      (context["host_provider"] as string | undefined) ?? "e2b"

    await trx
      .insertInto("devices")
      .values({
        id: pendingDeviceId,
        workspaceId: session.workspaceId as string,
        ownerWorkspaceMemberId: session.requestedByWorkspaceMemberId ?? null,
        title: (session.requestedTitle as string | null) ?? "Cloud Device",
        description: null,
        hostKind: "cloud",
        hostProvider: hostProvider,
        deviceType: "cloud_sandbox",
        platform: args.device.platform,
        arch: args.device.arch,
        publicKey: args.device.publicKey,
        publicKeyFingerprint: args.device.publicKeyFingerprint,
        trustStatus: "trusted",
      } as never)
      .execute()

    await trx
      .insertInto("deviceServices")
      .values({
        id: args.service.serviceId,
        deviceId: pendingDeviceId,
        serviceKind: "device_runtime",
        version: args.service.version,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()
    await trx
      .insertInto("deviceServiceKeys")
      .values({
        id: args.serviceKey.serviceKeyId,
        serviceId: args.service.serviceId,
        pubkey: args.serviceKey.pubkey,
        pubkeyFingerprint: args.serviceKey.pubkeyFingerprint,
      } as never)
      .execute()
    // Atomic UPDATE above already flipped status/timestamps. Just backfill
    // the device_id FK now that the device row exists.
    await trx
      .updateTable("devicePairingSessions")
      .set({
        deviceId: pendingDeviceId,
      } as never)
      .where("id", "=", session.id as string)
      .execute()

    return {
      outcome: "ok",
      pendingDeviceId,
      hostProvider,
      session: {
        id: session.id as string,
        workspaceId: session.workspaceId as string,
        requestedByWorkspaceMemberId:
          (session.requestedByWorkspaceMemberId as string | null) ?? null,
        requestedTitle: (session.requestedTitle as string | null) ?? null,
        context,
        status: session.status as string,
        expiresAt: (session.expiresAt as Date | null) ?? null,
      },
    }
  })
}

// ════════════════════════════════════════════════════════════════════════════
// control-plane.ts — session lifecycle, tunnel token, validation reads
// ════════════════════════════════════════════════════════════════════════════

/** Insert a device_control_plane_sessions row + bump device_services pointer. */
export async function insertControlPlaneSession(args: {
  sessionId: string
  deviceId: string
  serviceId: string
  clientVersion: string | null
  remoteAddr: string | null
}): Promise<void> {
  await db
    .insertInto("deviceControlPlaneSessions")
    .values({
      id: args.sessionId,
      deviceId: args.deviceId,
      serviceId: args.serviceId,
      protocolVersion: 1,
      clientVersion: args.clientVersion,
      status: "active",
      transport: "websocket",
      remoteAddr: args.remoteAddr,
      lastSequence: 0,
      lastHeartbeatAt: sql`NOW()`,
      startedAt: sql`NOW()`,
    } as never)
    .execute()
  await db
    .updateTable("deviceServices")
    .set({
      currentSessionId: args.sessionId,
      lastSeenAt: sql`NOW()`,
    } as never)
    .where("id", "=", args.serviceId)
    .execute()
}

/**
 * Concurrency-safe lookup-or-issue of the per-service tunnel path token: a
 * single UPDATE ... WHERE tunnel_path_token IS NULL then read whatever is
 * persisted (a peer may have won the race). Returns the token or null.
 */
export async function issueTunnelPathToken(
  serviceId: string,
  freshToken: string
): Promise<string | null> {
  await db
    .updateTable("deviceServices")
    .set({ tunnelPathToken: freshToken } as never)
    .where("id", "=", serviceId)
    .where("tunnelPathToken", "is", null)
    .execute()
  const row = await db
    .selectFrom("deviceServices")
    .select(["tunnelPathToken"])
    .where("id", "=", serviceId)
    .executeTakeFirst()
  return (row?.tunnelPathToken as string | null) ?? null
}

/** Read a control-plane session's deviceId (for in-flight task failure on close). */
export async function selectControlPlaneSessionDeviceId(
  sessionId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("deviceControlPlaneSessions")
    .select("deviceId")
    .where("id", "=", sessionId)
    .executeTakeFirst()
  return (row?.deviceId as string | null) ?? null
}

/** Close a control-plane session: mark it closed + clear the device_services pointer. */
export async function closeControlPlaneSessionRows(
  sessionId: string,
  reason: string
): Promise<void> {
  await db
    .updateTable("deviceControlPlaneSessions")
    .set({
      status: "closed",
      endedAt: sql`NOW()`,
      closeReason: reason,
    } as never)
    .where("id", "=", sessionId)
    .execute()
  await db
    .updateTable("deviceServices")
    .set({
      currentSessionId: null,
    } as never)
    .where("currentSessionId", "=", sessionId)
    .execute()
}

/** device.hello workspace cache lookup. Returns the device's workspaceId or null. */
export async function getDeviceWorkspaceId(
  deviceId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("devices")
    .select(["workspaceId"])
    .where("id", "=", deviceId)
    .executeTakeFirst()
  return (row?.workspaceId as string | undefined) ?? null
}

/** Read the persisted tunnel_path_token bound to a device_service (frp-edge
 *  validation). Executor-injectable (tests pass a testcontainer db). */
export async function selectTunnelPathToken(
  deviceServiceId: string,
  executor: KyselyDb = db
): Promise<string | null> {
  const row = await executor
    .selectFrom("deviceServices")
    .select(["tunnelPathToken"])
    .where("id", "=", deviceServiceId)
    .executeTakeFirst()
  return (row?.tunnelPathToken as string | null) ?? null
}

export type DeviceHelloAuthContext = {
  deviceExists: boolean
  service: { id: string; deviceId: string } | null
  activeKey: {
    id: string
    pubkey: string
    pubkeyFingerprint: string
  } | null
}

/** device.hello auth lookup. Signature verification stays in control-plane-auth. */
export async function selectDeviceHelloAuthContext(
  input: { deviceId: string; serviceId: string },
  executor: KyselyDb = db
): Promise<DeviceHelloAuthContext> {
  const device = await executor
    .selectFrom("devices")
    .select(["id"])
    .where("id", "=", input.deviceId)
    .executeTakeFirst()
  if (!device) return { deviceExists: false, service: null, activeKey: null }

  const serviceRow = await executor
    .selectFrom("deviceServices")
    .select(["id", "deviceId"])
    .where("id", "=", input.serviceId)
    .executeTakeFirst()
  const service =
    serviceRow && serviceRow.deviceId === input.deviceId
      ? {
          id: serviceRow.id as string,
          deviceId: serviceRow.deviceId as string,
        }
      : null
  if (!service) return { deviceExists: true, service: null, activeKey: null }

  const keyRow = await executor
    .selectFrom("deviceServiceKeys")
    .select(["id", "pubkey", "pubkeyFingerprint"])
    .where("serviceId", "=", input.serviceId)
    .where("revokedAt", "is", null)
    .executeTakeFirst()
  return {
    deviceExists: true,
    service,
    activeKey: keyRow
      ? {
          id: keyRow.id as string,
          pubkey: keyRow.pubkey as string,
          pubkeyFingerprint: keyRow.pubkeyFingerprint as string,
        }
      : null,
  }
}

/**
 * Whether the device_service maps to a device with a LIVE local sandbox mount.
 * Raw status comparison (matching getActiveMountsForSession) so the
 * file_mount_status enum compares against literals without a parameterized-text
 * cast mismatch — copied verbatim. Executor-injectable (tests pass a
 * testcontainer db).
 */
export async function hasLiveLocalSandboxMount(
  deviceServiceId: string,
  executor: KyselyDb = db
): Promise<boolean> {
  const liveLocalMount = await executor
    .selectFrom("fileMounts as m")
    .innerJoin("deviceServices as s", "s.deviceId", "m.deviceId")
    .select("m.id")
    .where("s.id", "=", deviceServiceId)
    .where("m.sandboxBackend", "=", "local")
    .where(sql<boolean>`m.status NOT IN ('closed', 'failed')`)
    .limit(1)
    .executeTakeFirst()
  return Boolean(liveLocalMount)
}

// ════════════════════════════════════════════════════════════════════════════
// control-plane-events.ts — runtime sessions, operation lifecycle, events
// ════════════════════════════════════════════════════════════════════════════

/** Open (upsert) a runtime session + its service row in one transaction. */
export async function upsertRuntimeSessionOpened(input: {
  runtimeSessionId: string
  deviceId: string
  serviceId: string
  conversationId: string | null
  actorId: string | null
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("deviceRuntimeSessions")
      .values({
        id: input.runtimeSessionId,
        deviceId: input.deviceId,
        conversationId: input.conversationId,
        actorId: input.actorId,
        status: "open",
        openedAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          status: "open",
          openedAt: sql`NOW()`,
        })
      )
      .execute()
    await trx
      .insertInto("deviceRuntimeSessionServices")
      .values({
        sessionId: input.runtimeSessionId,
        serviceId: input.serviceId,
        status: "open",
        openedAt: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(["sessionId", "serviceId"]).doUpdateSet({
          status: "open",
          openedAt: sql`NOW()`,
        })
      )
      .execute()
  })
}

/** Close a runtime session + its service row in one transaction. */
export async function closeRuntimeSession(input: {
  runtimeSessionId: string
  deviceId: string
  serviceId: string
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("deviceRuntimeSessions")
      .set({
        status: "closed",
        closedAt: sql`NOW()`,
      })
      .where("id", "=", input.runtimeSessionId)
      .where("deviceId", "=", input.deviceId)
      .execute()
    await trx
      .updateTable("deviceRuntimeSessionServices")
      .set({ status: "closed", closedAt: sql`NOW()` })
      .where("sessionId", "=", input.runtimeSessionId)
      .where("serviceId", "=", input.serviceId)
      .execute()
  })
}

/** Operation-ownership read: the device_operations row (id + owning device). */
export async function selectDeviceOperationOwner(
  operationId: string
): Promise<{ id: string; deviceId: string } | undefined> {
  const op = await db
    .selectFrom("deviceOperations")
    .select(["id", "deviceId"])
    .where("id", "=", operationId)
    .executeTakeFirst()
  return op
    ? { id: op.id as string, deviceId: op.deviceId as string }
    : undefined
}

/** Operation-ownership read: the device_operation_attempts row. */
export async function selectDeviceOperationAttempt(
  attemptId: string
): Promise<
  { id: string; operationId: string; deviceServiceId: string } | undefined
> {
  const attempt = await db
    .selectFrom("deviceOperationAttempts")
    .select(["id", "operationId", "deviceServiceId"])
    .where("id", "=", attemptId)
    .executeTakeFirst()
  return attempt
    ? {
        id: attempt.id as string,
        operationId: attempt.operationId as string,
        deviceServiceId: attempt.deviceServiceId as string,
      }
    : undefined
}

/** The tool_call_tasks.id linked to a device operation, if any. */
export async function selectTaskIdForOperation(
  operationId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("deviceOperations")
    .select("taskId")
    .where("id", "=", operationId)
    .executeTakeFirst()
  return (row?.taskId as string | null) || null
}

/** Set a device_operations.status (scoped to the owning device). */
export async function setDeviceOperationStatus(
  operationId: string,
  deviceId: string,
  status: string
): Promise<void> {
  await db
    .updateTable("deviceOperations")
    .set({ status } as never)
    .where("id", "=", operationId)
    .where("deviceId", "=", deviceId)
    .execute()
}

/** Set a device_operation_attempts.status (scoped to the owning service). */
export async function setDeviceOperationAttemptStatus(
  attemptId: string,
  serviceId: string,
  status: string
): Promise<void> {
  await db
    .updateTable("deviceOperationAttempts")
    .set({ status } as never)
    .where("id", "=", attemptId)
    .where("deviceServiceId", "=", serviceId)
    .execute()
}

/** Guarded transition to output_streaming (only from started/output_streaming). */
export async function markDeviceOperationOutputStreaming(
  operationId: string,
  deviceId: string
): Promise<void> {
  await db
    .updateTable("deviceOperations")
    .set({ status: "output_streaming" } as never)
    .where("id", "=", operationId)
    .where("deviceId", "=", deviceId)
    .where("status", "in", ["started", "output_streaming"])
    .execute()
}

/**
 * Finalize an operation result (succeeded/failed + completedAt NOW()), and the
 * matching attempt (acknowledged/failed + responseAt/acknowledgedAt) in one
 * transaction.
 */
export async function finalizeDeviceOperationResult(input: {
  operationId: string
  deviceId: string
  attemptId?: string
  serviceId: string
  ok: boolean
  resultHash: string | null
  errorCode: string | null
  errorMessage: string | null
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("deviceOperations")
      .set({
        status: input.ok ? "succeeded" : "failed",
        resultHash: input.resultHash,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: sql`NOW()`,
      })
      .where("id", "=", input.operationId)
      .where("deviceId", "=", input.deviceId)
      .execute()
    if (input.attemptId) {
      await trx
        .updateTable("deviceOperationAttempts")
        .set({
          status: input.ok ? "acknowledged" : "failed",
          responseAt: sql`NOW()`,
          acknowledgedAt: input.ok ? sql`NOW()` : null,
        })
        .where("id", "=", input.attemptId)
        .where("deviceServiceId", "=", input.serviceId)
        .execute()
    }
  })
}

/** In-flight (non-terminal) device_tool task ids for a device (join select). */
export async function selectInFlightDeviceTaskIds(
  deviceId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom("deviceOperations as op")
    .innerJoin("toolCallTasks as t", "t.id", "op.taskId")
    .select("op.taskId as taskId")
    .where("op.deviceId", "=", deviceId)
    .where("op.taskId", "is not", null)
    .where("t.lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .execute()
  return rows
    .map((r) => r.taskId as string | null)
    .filter((id): id is string => Boolean(id))
}

/** Expired-but-non-terminal device_tool task ids (TTL sweeper select). */
export async function selectExpiredDeviceTaskIds(now: Date): Promise<string[]> {
  const rows = await db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("executorKind", "=", "device_tool")
    .where("lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .where("expiresAt", "is not", null)
    .where("expiresAt", "<", now)
    .execute()
  return rows.map((r) => r.id as string)
}

/** Insert a device-sourced runtime_events row (payload ::jsonb cast preserved). */
export async function insertRuntimeEvent(input: {
  workspaceId: string
  conversationId: string | null
  level: string
  eventType: string
  payloadJson: string
}): Promise<void> {
  await db
    .insertInto("runtimeEvents")
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      // runtime_events_source enum carries 'device' as the device-emitted
      // event channel.
      source: "device",
      level: input.level,
      eventType: input.eventType,
      payload: sql`${input.payloadJson}::jsonb`,
    } as never)
    .execute()
}

/** Merge a vfs snapshot into device_exposures.metadata (jsonb COALESCE/|| merge). */
export async function mergeVfsExposureMetadata(
  exposureId: string,
  deviceId: string,
  vfsJson: string
): Promise<void> {
  await db
    .updateTable("deviceExposures")
    .set({
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('vfs', ${vfsJson}::jsonb)`,
    } as never)
    .where("id", "=", exposureId)
    .where("deviceId", "=", deviceId)
    .execute()
}

// ════════════════════════════════════════════════════════════════════════════
// operations.ts — device operation transactions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Insert a device_operations + first device_operation_attempts row pair, with a
 * revision drift check: the envelope's device_tool_revision_id must match
 * device_tools.latest_revision_id, otherwise we throw tool_definition_changed
 * before issuing the dispatch. The drift check + INSERT run in the same Kysely
 * transaction so a concurrent catalog sync can't slip in between.
 */
export async function beginDeviceOperation(
  input: BeginOperationInput
): Promise<BeginOperationResult> {
  return db.transaction().execute(async (trx: DatabaseTransaction) => {
    await assertNoDeviceToolRevisionDrift(
      trx,
      input.envelope.device_tool_id,
      input.envelope.device_tool_revision_id
    )
    return beginDeviceOperationOn(trx, input)
  })
}

/**
 * Mark a previously-begun operation as completed or failed. Always called in
 * the dispatch loop's `finally` so partial states (errors mid-dispatch) still
 * land in the audit trail.
 */
export async function completeDeviceOperation(
  input: CompleteOperationInput
): Promise<void> {
  await db.transaction().execute(async (trx: DatabaseTransaction) => {
    await trx
      .updateTable("deviceOperationAttempts")
      .set({
        status: input.ok ? "acknowledged" : "failed",
        responseAt: sql`NOW()`,
        acknowledgedAt: input.ok ? sql`NOW()` : null,
        metadata: input.error
          ? sql`${JSON.stringify({ error: input.error })}::jsonb`
          : sql`'{}'::jsonb`,
      })
      .where("id", "=", input.attemptId)
      .execute()
    await trx
      .updateTable("deviceOperations")
      .set({
        // Schema's device_operations_status terminal enum value is
        // 'succeeded' (not 'completed'). Failed dispatches use 'failed'.
        status: input.ok ? "succeeded" : "failed",
        resultHash: input.resultHash ?? null,
        errorCode: input.error?.code ?? null,
        errorMessage: input.error?.message ?? null,
        completedAt: sql`NOW()`,
      })
      .where("id", "=", input.operationId)
      .execute()
  })
}

// ════════════════════════════════════════════════════════════════════════════
// catalog-sync.ts — device.catalog.sync persistence (one large transaction)
// ════════════════════════════════════════════════════════════════════════════
//
// The whole sync is ONE db.transaction(): it spans device_exposures,
// device_capabilities, device_catalog_revisions, device_tools,
// device_tool_revisions PLUS the cross-module workspace_apps writes
// (insertWorkspaceAppRoot/updateWorkspaceAppRoot), and the stale-state reap.
// Atomicity is load-bearing (idempotent upserts + revision supersession +
// stale reaping must not partially commit), so the entire orchestration lives
// in this single transaction-owning repo fn. The pure hashing helpers
// (stableStringify/toolDefinitionHash/exposureSchemaHash) are colocated here
// because the trx-bound sub-functions call them; they touch no db.

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  )
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`
}

function toolDefinitionHash(tool: DeviceCatalogTool): string {
  return createHash("sha256")
    .update(
      stableStringify({
        stable_key: tool.stable_key,
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        annotations: tool.annotations ?? null,
      })
    )
    .digest("hex")
}

function exposureSchemaHash(exposure: DeviceCatalogExposure): string {
  const toolDigests = exposure.tools
    .map((t) => `${t.stable_key}:${toolDefinitionHash(t)}`)
    .sort()
  return createHash("sha256")
    .update(
      stableStringify({
        stable_key: exposure.stable_key,
        display_name: exposure.display_name,
        transport: exposure.transport,
        builtin_kind: exposure.builtin_kind ?? null,
        tools: toolDigests,
      })
    )
    .digest("hex")
}

export interface PersistCatalogSyncInput {
  deviceId: string
  serviceId: string
  exposures: DeviceCatalogExposure[]
}

export interface AssignedToolIds {
  device_tool_id: string
  device_tool_revision_id: string
}
export interface AssignedExposureIds {
  device_exposure_id: string
  tools: Record<string, AssignedToolIds>
}
export type AssignedCatalogIds = Record<string, AssignedExposureIds>

export interface PersistCatalogSyncResult {
  exposureCount: number
  newRevisionCount: number
  toolRevisionCount: number
  offlineExposureCount: number
  removedToolCount: number
  /**
   * Server-assigned ids per exposure stable_key → tool name. Returned to
   * the device runtime so it can verify dispatched envelopes target one
   * of its own catalog entries before invoking the local provider. Without
   * this round-trip the device has no way to know the UUIDs the server
   * minted and could be tricked into running a tool by a peer's envelope.
   */
  assignedIds: AssignedCatalogIds
}

export async function persistCatalogSync(
  input: PersistCatalogSyncInput
): Promise<PersistCatalogSyncResult> {
  return db.transaction().execute(async (trx) => {
    const device = await trx
      .selectFrom("devices")
      .select(["id", "workspaceId"])
      .where("id", "=", input.deviceId)
      .executeTakeFirst()
    if (!device) {
      throw new Error(`persistCatalogSync: device ${input.deviceId} not found`)
    }

    let newRevisionCount = 0
    let toolRevisionCount = 0
    const seenExposureIds = new Set<string>()
    const seenToolIdsByExposure = new Map<string, Set<string>>()
    const assignedIds: AssignedCatalogIds = {}

    for (const exposure of input.exposures) {
      const exposureId = await upsertExposure(trx, {
        deviceId: input.deviceId,
        serviceId: input.serviceId,
        exposure,
      })
      seenExposureIds.add(exposureId)
      await ensureCapability(trx, {
        workspaceId: device.workspaceId as string,
        exposureId,
      })
      const { revisionId, isNew } = await ensureCatalogRevision(trx, {
        exposureId,
        schemaHash: exposureSchemaHash(exposure),
      })
      if (isNew) newRevisionCount += 1
      const { writtenRevisions, seenToolIds, assignedTools } =
        await upsertTools(trx, {
          exposureId,
          catalogRevisionId: revisionId,
          tools: exposure.tools,
        })
      toolRevisionCount += writtenRevisions
      seenToolIdsByExposure.set(exposureId, seenToolIds)
      assignedIds[exposure.stable_key] = {
        device_exposure_id: exposureId,
        tools: assignedTools,
      }
    }

    // Reap stale state: every exposure on this device that wasn't in the
    // snapshot goes offline (so projection stops surfacing it). Every tool
    // under a seen exposure that wasn't in the snapshot goes removed.
    // Unseen exposures get their tools left alone — they'll be removed
    // transitively when the exposure flips offline.
    let offlineExposureCount = 0
    let removedToolCount = 0
    const allExposureIds = await trx
      .selectFrom("deviceExposures")
      .select(["id"])
      .where("deviceId", "=", input.deviceId)
      .execute()
    const staleExposureIds = allExposureIds
      .map((r) => r.id as string)
      .filter((id) => !seenExposureIds.has(id))
    if (staleExposureIds.length > 0) {
      const updated = await trx
        .updateTable("deviceExposures")
        .set({
          runtimeStatus: "offline",
        } as never)
        .where("id", "in", staleExposureIds)
        .where("runtimeStatus", "!=", "offline")
        .executeTakeFirst()
      offlineExposureCount = Number(updated?.numUpdatedRows ?? 0n)
    }
    for (const [exposureId, seenToolIds] of seenToolIdsByExposure) {
      const allToolIds = await trx
        .selectFrom("deviceTools")
        .select(["id"])
        .where("exposureId", "=", exposureId)
        .execute()
      const stale = allToolIds
        .map((r) => r.id as string)
        .filter((id) => !seenToolIds.has(id))
      if (stale.length === 0) continue
      const updated = await trx
        .updateTable("deviceTools")
        .set({
          status: "removed",
        } as never)
        .where("id", "in", stale)
        .where("status", "!=", "removed")
        .executeTakeFirst()
      removedToolCount += Number(updated?.numUpdatedRows ?? 0n)
    }

    return {
      exposureCount: input.exposures.length,
      newRevisionCount,
      toolRevisionCount,
      offlineExposureCount,
      removedToolCount,
      assignedIds,
    }
  })
}

async function upsertExposure(
  trx: DatabaseTransaction,
  args: {
    deviceId: string
    serviceId: string
    exposure: DeviceCatalogExposure
  }
): Promise<string> {
  const existing = await trx
    .selectFrom("deviceExposures")
    .select(["id"])
    .where("deviceId", "=", args.deviceId)
    .where("stableKey", "=", args.exposure.stable_key)
    .executeTakeFirst()
  const metadata = sql`${JSON.stringify(args.exposure.metadata ?? {})}::jsonb`
  if (existing) {
    await trx
      .updateTable("deviceExposures")
      .set({
        serviceId: args.serviceId,
        displayName: args.exposure.display_name,
        description: args.exposure.description ?? null,
        transport: args.exposure.transport,
        builtinKind: args.exposure.builtin_kind ?? null,
        runtimeStatus: "healthy",
        lastSeenAt: sql`NOW()`,
        lastHealthyAt: sql`NOW()`,
        metadata,
      } as never)
      .where("id", "=", existing.id as string)
      .execute()
    return existing.id as string
  }
  const inserted = await trx
    .insertInto("deviceExposures")
    .values({
      deviceId: args.deviceId,
      serviceId: args.serviceId,
      stableKey: args.exposure.stable_key,
      displayName: args.exposure.display_name,
      description: args.exposure.description ?? null,
      transport: args.exposure.transport,
      builtinKind: args.exposure.builtin_kind ?? null,
      runtimeStatus: "healthy",
      lastSeenAt: sql`NOW()`,
      lastHealthyAt: sql`NOW()`,
      metadata,
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  return inserted.id as string
}

async function ensureCapability(
  trx: DatabaseTransaction,
  args: { workspaceId: string; exposureId: string }
): Promise<void> {
  const capabilityOwner = await trx
    .selectFrom("deviceExposures as exposure")
    .innerJoin("devices as device", "device.id", "exposure.deviceId")
    .select(["device.ownerWorkspaceMemberId", "exposure.displayName"])
    .where("exposure.id", "=", args.exposureId)
    .executeTakeFirst()
  const existing = await trx
    .selectFrom("deviceCapabilities")
    .select(["id"])
    .where("exposureId", "=", args.exposureId)
    .executeTakeFirst()
  if (existing) {
    await updateWorkspaceAppRoot(trx, {
      id: existing.id as string,
      displayName:
        (capabilityOwner?.displayName as string | null) || "Device capability",
      ownerWorkspaceMemberId:
        (capabilityOwner?.ownerWorkspaceMemberId as string | null) ?? null,
    })
    return
  }
  const capabilityId = crypto.randomUUID()
  await insertWorkspaceAppRoot(trx, {
    id: capabilityId,
    workspaceId: args.workspaceId,
    kind: "device_capability",
    displayName:
      (capabilityOwner?.displayName as string | null) || "Device capability",
    ownerWorkspaceMemberId:
      (capabilityOwner?.ownerWorkspaceMemberId as string | null) ?? null,
    status: "active",
  })
  await trx
    .insertInto("deviceCapabilities")
    .values({
      id: capabilityId,
      exposureId: args.exposureId,
    } as never)
    .execute()
}

async function ensureCatalogRevision(
  trx: DatabaseTransaction,
  args: { exposureId: string; schemaHash: string }
): Promise<{ revisionId: string; isNew: boolean }> {
  const latest = await trx
    .selectFrom("deviceCatalogRevisions")
    .select(["id", "revisionSeq", "schemaHash", "status"])
    .where("exposureId", "=", args.exposureId)
    .orderBy("revisionSeq", "desc")
    .limit(1)
    .executeTakeFirst()
  if (
    latest &&
    (latest.schemaHash as string) === args.schemaHash &&
    (latest.status as string) === "active"
  ) {
    return { revisionId: latest.id as string, isNew: false }
  }
  if (latest && (latest.status as string) === "active") {
    await trx
      .updateTable("deviceCatalogRevisions")
      .set({
        status: "superseded",
        invalidatedAt: sql`NOW()`,
      } as never)
      .where("id", "=", latest.id as string)
      .execute()
  }
  const latestSeqRaw = latest?.revisionSeq
  const latestSeqNumber =
    typeof latestSeqRaw === "bigint"
      ? Number(latestSeqRaw)
      : typeof latestSeqRaw === "number"
        ? latestSeqRaw
        : typeof latestSeqRaw === "string"
          ? Number(latestSeqRaw)
          : 0
  const nextSeqNumber = latestSeqNumber + 1
  const inserted = await trx
    .insertInto("deviceCatalogRevisions")
    .values({
      exposureId: args.exposureId,
      revisionSeq: nextSeqNumber,
      schemaHash: args.schemaHash,
      status: "active",
      activatedAt: sql`NOW()`,
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow()
  return { revisionId: inserted.id as string, isNew: true }
}

async function upsertTools(
  trx: DatabaseTransaction,
  args: {
    exposureId: string
    catalogRevisionId: string
    tools: DeviceCatalogTool[]
  }
): Promise<{
  writtenRevisions: number
  seenToolIds: Set<string>
  assignedTools: Record<string, AssignedToolIds>
}> {
  let writtenRevisions = 0
  const seenToolIds = new Set<string>()
  const assignedTools: Record<string, AssignedToolIds> = {}
  for (const tool of args.tools) {
    const definitionHash = toolDefinitionHash(tool)
    const existingTool = await trx
      .selectFrom("deviceTools")
      .select(["id", "latestRevisionId"])
      .where("exposureId", "=", args.exposureId)
      .where("stableKey", "=", tool.stable_key)
      .executeTakeFirst()
    let toolId: string
    if (existingTool) {
      toolId = existingTool.id as string
      await trx
        .updateTable("deviceTools")
        .set({
          currentName: tool.name,
          status: "active",
          lastSeenAt: sql`NOW()`,
        } as never)
        .where("id", "=", toolId)
        .execute()
    } else {
      const insertedTool = await trx
        .insertInto("deviceTools")
        .values({
          exposureId: args.exposureId,
          stableKey: tool.stable_key,
          currentName: tool.name,
          status: "active",
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
      toolId = insertedTool.id as string
    }
    seenToolIds.add(toolId)

    const existingRevision = await trx
      .selectFrom("deviceToolRevisions")
      .select(["id", "definitionHash"])
      .where("toolId", "=", toolId)
      .where("catalogRevisionId", "=", args.catalogRevisionId)
      .executeTakeFirst()
    let revisionId: string
    if (existingRevision) {
      revisionId = existingRevision.id as string
      if ((existingRevision.definitionHash as string) !== definitionHash) {
        await trx
          .updateTable("deviceToolRevisions")
          .set({
            toolName: tool.name,
            description: tool.description,
            inputSchema: sql`${JSON.stringify(tool.input_schema)}::jsonb`,
            annotations: sql`${JSON.stringify(tool.annotations ?? {})}::jsonb`,
            definitionHash: definitionHash,
          } as never)
          .where("id", "=", revisionId)
          .execute()
      }
    } else {
      const insertedRevision = await trx
        .insertInto("deviceToolRevisions")
        .values({
          toolId: toolId,
          catalogRevisionId: args.catalogRevisionId,
          toolName: tool.name,
          description: tool.description,
          inputSchema: sql`${JSON.stringify(tool.input_schema)}::jsonb`,
          annotations: sql`${JSON.stringify(tool.annotations ?? {})}::jsonb`,
          definitionHash: definitionHash,
        } as never)
        .returning("id")
        .executeTakeFirstOrThrow()
      revisionId = insertedRevision.id as string
      writtenRevisions += 1
    }
    await trx
      .updateTable("deviceTools")
      .set({ latestRevisionId: revisionId } as never)
      .where("id", "=", toolId)
      .execute()
    assignedTools[tool.name] = {
      device_tool_id: toolId,
      device_tool_revision_id: revisionId,
    }
  }
  return { writtenRevisions, seenToolIds, assignedTools }
}

// ════════════════════════════════════════════════════════════════════════════
// service.ts — device list/get/delete, pairing, daemon claim, service detach
// ════════════════════════════════════════════════════════════════════════════

/** Row→domain mapper for the device summary projection (camelCase, Date kept). */
function toDeviceSummaryRecord(row: {
  id: string
  workspaceId: string
  title: string
  hostKind: HostKind
  hostProvider: string | null
  deviceType: DeviceType
  platform: string | null
  trustStatus: DeviceTrustStatus
  lastSeenAt: Date | null
  lastConnectedAt: Date | null
}): DeviceSummaryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    hostKind: row.hostKind,
    hostProvider: row.hostProvider,
    deviceType: row.deviceType,
    platform: row.platform,
    trustStatus: row.trustStatus,
    lastSeenAt: row.lastSeenAt,
    lastConnectedAt: row.lastConnectedAt,
  }
}

/** List the non-deleted devices of a workspace as summary records. */
export async function listDeviceSummaries(
  workspaceId: string
): Promise<DeviceSummaryRecord[]> {
  const rows = await db
    .selectFrom("devices")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("deletedAt", "is", null)
    .orderBy("createdAt", "desc")
    .execute()
  return rows.map((row) =>
    toDeviceSummaryRecord({
      id: row.id as string,
      workspaceId: row.workspaceId as string,
      title: row.title as string,
      hostKind: row.hostKind as HostKind,
      hostProvider: row.hostProvider as string | null,
      deviceType: row.deviceType as DeviceType,
      platform: row.platform as string | null,
      trustStatus: row.trustStatus as DeviceTrustStatus,
      lastSeenAt: row.lastSeenAt as Date | null,
      lastConnectedAt: row.lastConnectedAt as Date | null,
    })
  )
}

/**
 * Read a device + its services + capabilities. Returns null when the device
 * doesn't exist (or is soft-deleted) in the workspace; the service maps that
 * to the 404 DeviceModuleError so the error-code branching stays out of repo.
 */
export async function findDeviceDetail(
  workspaceId: string,
  deviceId: string
): Promise<DeviceDetailRecord | null> {
  const deviceRow = await db
    .selectFrom("devices")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", deviceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (!deviceRow) {
    return null
  }

  const serviceRows = await db
    .selectFrom("deviceServices")
    .selectAll()
    .where("deviceId", "=", deviceId)
    .orderBy("createdAt", "asc")
    .execute()
  const services: DeviceServiceRecord[] = serviceRows.map((row) => ({
    id: row.id as string,
    deviceId: row.deviceId as string,
    serviceKind: row.serviceKind as DeviceServiceKind,
    version: (row.version as string | null) ?? null,
    status: row.status as DeviceServiceRecord["status"],
    lastSeenAt: row.lastSeenAt as Date | null,
    remoteAgentMachineId: (row.remoteAgentMachineId as string | null) ?? null,
  }))

  const capabilityRows = await db
    .selectFrom("deviceCapabilities as dc")
    .innerJoin("workspaceApps as app", "app.id", "dc.id")
    .innerJoin("deviceExposures as dx", "dx.id", "dc.exposureId")
    .select([
      "dc.id as id",
      "app.workspaceId as workspaceId",
      "dc.exposureId as exposureId",
      "dx.stableKey as exposureStableKey",
      "app.displayName as displayName",
      "dx.transport as transport",
      "dx.builtinKind as builtinKind",
      "dx.runtimeStatus as runtimeStatus",
      "dx.metadata as exposureMetadata",
    ])
    .where("dx.deviceId", "=", deviceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .execute()
  const capabilities: DeviceCapabilityRecord[] = capabilityRows.map((row) => ({
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    exposureId: row.exposureId as string,
    exposureStableKey: row.exposureStableKey as string,
    displayName: row.displayName as string,
    transport: row.transport as DeviceCapabilityRecord["transport"],
    builtinKind:
      (row.builtinKind as DeviceCapabilityRecord["builtinKind"]) ?? null,
    runtimeStatus: row.runtimeStatus as DeviceCapabilityRecord["runtimeStatus"],
    metadata: (row.exposureMetadata as Record<string, unknown> | null) ?? null,
  }))

  return {
    ...toDeviceSummaryRecord({
      id: deviceRow.id as string,
      workspaceId: deviceRow.workspaceId as string,
      title: deviceRow.title as string,
      hostKind: deviceRow.hostKind as HostKind,
      hostProvider: deviceRow.hostProvider as string | null,
      deviceType: deviceRow.deviceType as DeviceType,
      platform: deviceRow.platform as string | null,
      trustStatus: deviceRow.trustStatus as DeviceTrustStatus,
      lastSeenAt: deviceRow.lastSeenAt as Date | null,
      lastConnectedAt: deviceRow.lastConnectedAt as Date | null,
    }),
    description: (deviceRow.description as string | null) ?? null,
    ownerWorkspaceMemberId:
      (deviceRow.ownerWorkspaceMemberId as string | null) ?? null,
    services,
    capabilities,
  }
}

/**
 * Soft-delete a device (design §5.3): never hard-deleted — flip deleted_at and
 * KEEP all device_* child rows for audit. Returns numUpdatedRows so the service
 * can decide the 404. Child rows are hidden via the device-liveness filter and
 * *_live views (§8.6); hard delete is forbidden by sd_reject_delete.
 */
export async function softDeleteDevice(
  workspaceId: string,
  deviceId: string
): Promise<number> {
  const result = await db
    .updateTable("devices")
    .set({ deletedAt: new Date() })
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", deviceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0)
}

/** Insert a local/service-join pairing session. `contextJson` carries the
 *  caller-built JSON string; the ::jsonb cast lives here. */
export async function insertLocalPairingSession(args: {
  sessionId: string
  workspaceId: string
  requestedByWorkspaceMemberId: string | null
  deviceId: string | null
  mode: string
  serverBaseUrl: string
  requestedTitle: string | null
  requestedDescription: string | null
  requestedDeviceType: string | null
  pairingCode: string | null
  bootstrapTokenHash: Buffer | null
  expiresAt: Date
  contextJson: string
}): Promise<void> {
  await db
    .insertInto("devicePairingSessions")
    .values({
      id: args.sessionId,
      workspaceId: args.workspaceId,
      requestedByWorkspaceMemberId: args.requestedByWorkspaceMemberId,
      deviceId: args.deviceId,
      mode: args.mode,
      serverBaseUrl: args.serverBaseUrl,
      requestedTitle: args.requestedTitle,
      requestedDescription: args.requestedDescription,
      requestedDeviceType: args.requestedDeviceType,
      pairingCode: args.pairingCode,
      bootstrapTokenHash: args.bootstrapTokenHash,
      verificationUri: null,
      verificationUriComplete: null,
      expiresAt: args.expiresAt,
      status: "pending",
      context: sql`${args.contextJson}::jsonb`,
    } as never)
    .execute()
}

/** Discriminated outcome of the local-pairing consume transaction. The
 *  404/409/410 DeviceModuleError mapping stays in the service. */
export type ConsumeLocalPairingResult =
  | {
      outcome: "ok"
      deviceId: string
      serviceId: string
      serviceKeyId: string
    }
  | {
      outcome:
        | "not_found"
        | "not_pending"
        | "expired"
        | "mode_mismatch"
        | "race"
      existingStatus?: string
      existingMode?: string
    }

/**
 * Owns the whole local-pairing consume transaction: a single-shot claim
 * UPDATE...RETURNING (status pending + mode local_qr + not expired), a
 * diagnostic SELECT on race-loss, three INSERTs (devices, deviceServices,
 * deviceServiceKeys) and the device_id FK backfill — atomic in ONE
 * db.transaction(). Returns a discriminated domain result; the service maps the
 * failure outcomes to the right DeviceModuleError code and assembles the wire
 * response with control_plane_url.
 */
export async function consumeLocalPairingTx(args: {
  pairingCode: string
  pubkeyFingerprint: string
  serviceFingerprint: string
  devicePubkey: string
  servicePubkey: string
  clientVersion: string | null
  title?: string
  deviceType?: DeviceType
  platform?: string
  arch?: string
}): Promise<ConsumeLocalPairingResult> {
  return db.transaction().execute(async (trx) => {
    // Atomic single-shot consume: UPDATE the pairing session with status
    // change conditioned on it still being pending + matching mode + not
    // expired. RETURNING gives us the full row on success; nothing on any
    // race-loss or invalid state. Two concurrent claim attempts can no
    // longer both produce a trusted device.
    const claimedRows = await trx
      .updateTable("devicePairingSessions")
      .set({
        status: "consumed",
        confirmedAt: sql`NOW()`,
        consumedAt: sql`NOW()`,
      } as never)
      .where("pairingCode", "=", args.pairingCode)
      .where("status", "=", "pending")
      .where("mode", "=", "local_qr")
      .where("expiresAt", ">", sql<Date>`NOW()`)
      .returningAll()
      .execute()
    const session = claimedRows[0]
    if (!session) {
      // Distinguish the failure mode for a better error code so the
      // operator/runtime can react. We do a follow-up SELECT (still inside
      // the transaction) to figure out which precondition failed.
      const existing = await trx
        .selectFrom("devicePairingSessions")
        .selectAll()
        .where("pairingCode", "=", args.pairingCode)
        .executeTakeFirst()
      if (!existing) {
        return { outcome: "not_found" }
      }
      if ((existing.status as string) !== "pending") {
        return {
          outcome: "not_pending",
          existingStatus: existing.status as string,
        }
      }
      const expiresAt = new Date(
        existing.expiresAt as unknown as string
      ).getTime()
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        return { outcome: "expired" }
      }
      if ((existing.mode as string) !== "local_qr") {
        return {
          outcome: "mode_mismatch",
          existingMode: existing.mode as string,
        }
      }
      // Should not happen — race with another worker that claimed it between
      // our UPDATE and our diagnostic SELECT.
      return { outcome: "race" }
    }

    const deviceId = randomUUID()
    const serviceId = randomUUID()
    const serviceKeyId = randomUUID()
    const title = args.title ?? session.requestedTitle ?? "Device"
    const deviceType =
      args.deviceType ??
      (session.requestedDeviceType as DeviceType | null) ??
      ("desktop_computer" as DeviceType)

    await trx
      .insertInto("devices")
      .values({
        id: deviceId,
        workspaceId: session.workspaceId as string,
        ownerWorkspaceMemberId: session.requestedByWorkspaceMemberId ?? null,
        title,
        description: (session.requestedDescription as string | null) ?? null,
        hostKind: "local",
        hostProvider: null,
        deviceType: deviceType,
        platform: args.platform ?? null,
        arch: args.arch ?? null,
        publicKey: args.devicePubkey,
        publicKeyFingerprint: args.pubkeyFingerprint,
        trustStatus: "trusted",
      } as never)
      .execute()

    await trx
      .insertInto("deviceServices")
      .values({
        id: serviceId,
        deviceId: deviceId,
        serviceKind: "device_runtime",
        version: args.clientVersion ?? null,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()

    await trx
      .insertInto("deviceServiceKeys")
      .values({
        id: serviceKeyId,
        serviceId: serviceId,
        pubkey: args.servicePubkey,
        pubkeyFingerprint: args.serviceFingerprint,
      } as never)
      .execute()

    // Backfill device_id on the already-consumed pairing session row. The
    // earlier atomic UPDATE flipped status/timestamps; we just need the FK
    // wired now that the device row exists.
    await trx
      .updateTable("devicePairingSessions")
      .set({
        deviceId: deviceId,
      } as never)
      .where("id", "=", session.id as string)
      .execute()

    return {
      outcome: "ok",
      deviceId,
      serviceId,
      serviceKeyId,
    }
  })
}

/** Discriminated outcome of the daemon-claim transaction. */
export type ClaimRemoteAgentDaemonResult =
  | { outcome: "ok"; service: DeviceServiceRecord }
  | {
      outcome:
        | "device_not_found"
        | "machine_not_found"
        | "workspace_mismatch"
        | "already_claimed"
    }

/**
 * Owns the whole daemon-claim transaction: device ownership SELECT, machine
 * SELECT + workspace check, existing-claim SELECT, the deviceServices INSERT
 * and the read-back — atomic in ONE db.transaction(). Returns a discriminated
 * domain result; the service maps the failure outcomes to DeviceModuleError.
 */
export async function claimRemoteAgentDaemonTx(input: {
  workspaceId: string
  deviceId: string
  remoteAgentMachineId: string
}): Promise<ClaimRemoteAgentDaemonResult> {
  return db.transaction().execute(async (trx) => {
    const device = await trx
      .selectFrom("devices")
      .selectAll()
      .where("workspaceId", "=", input.workspaceId)
      .where("id", "=", input.deviceId)
      .executeTakeFirst()
    if (!device) {
      return { outcome: "device_not_found" }
    }

    const machine = await trx
      .selectFrom("remoteAgentMachines")
      .select(["id", "workspaceId"])
      .where("id", "=", input.remoteAgentMachineId)
      .executeTakeFirst()
    if (!machine) {
      return { outcome: "machine_not_found" }
    }
    if (machine.workspaceId !== input.workspaceId) {
      return { outcome: "workspace_mismatch" }
    }

    const existing = await trx
      .selectFrom("deviceServices")
      .selectAll()
      .where("remoteAgentMachineId", "=", input.remoteAgentMachineId)
      .where("serviceKind", "=", "remote_agent_daemon")
      .executeTakeFirst()
    if (existing) {
      return { outcome: "already_claimed" }
    }

    const serviceId = randomUUID()
    await trx
      .insertInto("deviceServices")
      .values({
        id: serviceId,
        deviceId: input.deviceId,
        serviceKind: "remote_agent_daemon",
        version: null,
        status: "online",
        metadata: sql`'{}'::jsonb`,
        remoteAgentMachineId: input.remoteAgentMachineId,
      } as never)
      .execute()

    const row = await trx
      .selectFrom("deviceServices")
      .selectAll()
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow()

    return {
      outcome: "ok",
      service: {
        id: row.id as string,
        deviceId: row.deviceId as string,
        serviceKind: row.serviceKind as DeviceServiceKind,
        version: (row.version as string | null) ?? null,
        status: row.status as DeviceServiceRecord["status"],
        lastSeenAt: row.lastSeenAt as Date | null,
        remoteAgentMachineId:
          (row.remoteAgentMachineId as string | null) ?? null,
      },
    }
  })
}

/**
 * Verify a device_service belongs to a device in `workspaceId`. Returns whether
 * it is owned; the service maps a false result to the 404 DeviceModuleError.
 */
export async function isDeviceServiceOwnedByWorkspace(
  workspaceId: string,
  deviceId: string,
  serviceId: string
): Promise<boolean> {
  const owned = await db
    .selectFrom("deviceServices as ds")
    .innerJoin("devices as d", "d.id", "ds.deviceId")
    .select("ds.id")
    .where("ds.id", "=", serviceId)
    .where("ds.deviceId", "=", deviceId)
    .where("d.workspaceId", "=", workspaceId)
    .executeTakeFirst()
  return Boolean(owned)
}

/**
 * Physical detach of a device_service via the SECURITY DEFINER fn. device_services
 * is a persistent child guarded by sd_reject_delete; the detach goes through
 * sd_detach_device_service (design §7.5/§11). Raw RPC kept verbatim.
 */
export async function detachDeviceServiceRpc(
  serviceId: string,
  deviceId: string
): Promise<void> {
  await sql`SELECT sd_detach_device_service(${serviceId}::uuid, ${deviceId}::uuid)`.execute(
    db
  )
}
