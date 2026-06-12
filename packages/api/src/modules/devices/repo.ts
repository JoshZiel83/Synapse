// Devices module repo: the single file in this module allowed to import the
// DB client (guard r8) and the raw `sql` tag. Every direct query that used to
// live in the module's service/transport/route files (access-bindings.ts,
// cloud.ts, control-plane.ts, control-plane-events.ts, operations.ts) is
// centralised here. Functions return camelCase domain records and KEEP Date
// objects (no serialization — that is a presenter concern, guard r3). Raw
// `sql` fragments (NOW(), ::jsonb casts, literal status comparisons) are copied
// verbatim from the original sites so semantics (incl. snake_case literals that
// intentionally bypass the CamelCasePlugin) are preserved exactly.

import { sql } from "kysely"
import {
  db,
  type DatabaseTransaction,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import type {
  BeginOperationInput,
  BeginOperationResult,
  CompleteOperationInput,
} from "./operations.js"
import {
  assertNoDeviceToolRevisionDrift,
  beginDeviceOperationOn,
} from "./operations.js"

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
