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
  RuntimeCatalogExposure,
  RuntimeCatalogTool,
  OperationEnvelope,
  SynapseError,
} from "@synapse/device-protocol"
import {
  db,
  type DatabaseTransaction,
  type Executor,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import {
  insertWorkspaceResourceRoot,
  updateWorkspaceResourceRoot,
} from "../workspace-resources/repo.js"
import { parseInstantString } from "../../infrastructure/datetime.js"
import type {
  DeviceCapabilityRecord,
  DeviceDetailRecord,
  RuntimeServiceRecord,
  DeviceSummaryRecord,
} from "./repo.types.js"
import type {
  RuntimeServiceKind,
  DeviceTrustStatus,
  DeviceType,
} from "@synapse/device-protocol/enums"

// ════════════════════════════════════════════════════════════════════════════
// access-bindings.ts — workspace-ownership validation reads
// ════════════════════════════════════════════════════════════════════════════

/** actor ⋈ workspaceResources: returns the actor's owning workspace (app not deleted). */
export async function findActorWorkspace(
  actorId: string
): Promise<{ workspaceId: string } | undefined> {
  const row = await db
    .selectFrom("actors as actor")
    .innerJoin("workspaceResources as resource", "resource.id", "actor.id")
    .select("resource.workspaceId as workspaceId")
    .where("actor.id", "=", actorId)
    .where("resource.deletedAt", "is", null)
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

/** remoteAgents ⋈ workspaceResources: returns the agent's owning workspace (app not deleted). */
export async function findRemoteAgentWorkspace(
  remoteAgentId: string
): Promise<{ workspaceId: string } | undefined> {
  const row = await db
    .selectFrom("remoteAgents as agent")
    .innerJoin("workspaceResources as resource", "resource.id", "agent.id")
    .select("resource.workspaceId as workspaceId")
    .where("agent.id", "=", remoteAgentId)
    .where("resource.deletedAt", "is", null)
    .executeTakeFirst()
  return row ? { workspaceId: row.workspaceId as string } : undefined
}

/**
 * runtimeCapabilities ⋈ workspaceResources: of the requested capabilityIds, return
 * the set actually owned by `workspaceId` (app not deleted). The caller derives
 * the `missing` set from this — ownership comparison is validation, not query.
 */
export async function findOwnedRuntimeCapabilityIds(
  workspaceId: string,
  capabilityIds: string[]
): Promise<Set<string>> {
  if (capabilityIds.length === 0) return new Set()
  const rows = await db
    .selectFrom("runtimeCapabilities as capability")
    .innerJoin("workspaceResources as resource", "resource.id", "capability.id")
    .select(["capability.id as id", "resource.workspaceId as workspaceId"])
    .where("capability.id", "in", capabilityIds)
    .where("resource.deletedAt", "is", null)
    .execute()
  return new Set(
    rows.filter((r) => r.workspaceId === workspaceId).map((r) => r.id as string)
  )
}

/**
 * Run a consume/mint body either in a fresh atomic global-db transaction
 * (production — the default) or DIRECTLY on an injected executor (a test's
 * withTestDb transaction handle). The injected path does NOT open a nested
 * transaction: the whole test already runs in one rolled-back transaction, so
 * the deferred CTI detail-consistency triggers validate only at the outer
 * boundary. Behavior-preserving: no production caller passes an executor.
 */
function runInInjectableTx<T>(
  executor: KyselyDb | undefined,
  fn: (trx: KyselyDb) => Promise<T>
): Promise<T> {
  if (executor) return fn(executor)
  return db.transaction().execute((trx) => fn(trx as unknown as KyselyDb))
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
  targetRuntimeKind?: "device" | "sandbox"
  requestedTitle: string
  bootstrapTokenHash: Buffer
  expiresAt: Date
  contextJson: string
}): Promise<void> {
  await db
    .insertInto("runtimePairingSessions")
    .values({
      id: args.sessionId,
      workspaceId: args.workspaceId,
      requestedByWorkspaceMemberId: args.requestedByWorkspaceMemberId,
      runtimeId: null,
      targetRuntimeKind: args.targetRuntimeKind ?? "device",
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
      pendingRuntimeId: string
    }
  | {
      outcome: "not_found" | "not_pending" | "expired" | "race" | "corrupt"
      existingStatus?: string
      existingExpiresAt?: Date | null
    }

/**
 * Owns the whole consume transaction: claim UPDATE (returningAll), diagnostic
 * SELECT, then — forking on the session's target_runtime_kind — either
 * runtimes(kind='device')+devices OR runtimes(kind='sandbox')+sandboxes,
 * followed by the shared runtimeServices + runtimeServiceKeys INSERTs and the
 * runtime_id FK backfill on the pairing session — atomic in ONE
 * db.transaction(). Returns a discriminated domain result; the 404/409/410/500
 * DeviceModuleError mapping + wire-shape assembly stay in cloud.ts.
 * `pending_runtime_id` is read from the claimed session's context HERE (only
 * known after the claim; it is the id of the device- OR sandbox-detail runtime)
 * and surfaced on the `ok` result so cloud.ts can build the wire response.
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
  /** TEST SEAM only (see below). */
  executor?: KyselyDb
}): Promise<ConsumeCloudBootstrapResult> {
  // The optional `executor` is a TEST SEAM only: production callers pass nothing
  // → the atomic global db.transaction() (unchanged). A test injects its
  // withTestDb transaction handle so the consume runs on the same rolled-back
  // connection (the deferred detail-consistency trigger validates at the outer
  // boundary, i.e. never — the test rolls back).
  return runInInjectableTx(args.executor, async (trx) => {
    // Atomic single-shot consume: flip status to "consumed" only if the
    // session is still pending + matching mode + not expired. Two concurrent
    // sandbox boots can no longer both succeed and double-insert a device.
    const claimedRows = await trx
      .updateTable("runtimePairingSessions")
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
        .selectFrom("runtimePairingSessions")
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
      const existingExpiresAt = existing.expiresAt.getTime()
      if (
        Number.isFinite(existingExpiresAt) &&
        existingExpiresAt < Date.now()
      ) {
        return { outcome: "expired" }
      }
      return { outcome: "race" }
    }

    const context = (session.context ?? {}) as Record<string, unknown>
    const pendingRuntimeId = context["pending_runtime_id"] as string | undefined
    if (!pendingRuntimeId) {
      return { outcome: "corrupt" }
    }

    // P2 fork: which runtime kind this bootstrap mints. Defaults to 'device' so a
    // real cloud device stays byte-identical; a docker sandbox sets 'sandbox'.
    const targetRuntimeKind =
      (session.targetRuntimeKind as string | undefined) ?? "device"

    if (targetRuntimeKind === "device") {
      // ── DEVICE branch — TODAY's INSERTs, VERBATIM (preservation contract #1) ──
      // runtimes is the CTI supertype root: the devices detail row's deferred
      // root FK + the runtime detail-consistency trigger both validate at commit,
      // so the runtimes(kind='device') parent MUST exist in the same tx before
      // the devices insert.
      await trx
        .insertInto("runtimes")
        .values({
          id: pendingRuntimeId,
          workspaceId: session.workspaceId as string,
          kind: "device",
        } as never)
        .execute()

      await trx
        .insertInto("devices")
        .values({
          id: pendingRuntimeId,
          workspaceId: session.workspaceId as string,
          ownerWorkspaceMemberId: session.requestedByWorkspaceMemberId ?? null,
          title: (session.requestedTitle as string | null) ?? "Cloud Device",
          description: null,
          deviceType: "virtual_machine",
          platform: args.device.platform,
          arch: args.device.arch,
          publicKey: args.device.publicKey,
          publicKeyFingerprint: args.device.publicKeyFingerprint,
          trustStatus: "trusted",
        } as never)
        .execute()
    } else {
      // ── SANDBOX branch (NEW) — a device-less kind='sandbox' runtime whose
      // detail is the sandboxes row (NO devices row). The device pubkey args are
      // ignored: identity lives in runtime_service_keys. adapter/mode/session_id/
      // capability_descriptor come from the pairing context (set at
      // createCloudDevicePairing). assert_runtime_detail_consistency (DEFERRED)
      // is satisfied: exactly one sandboxes detail for this runtime. ──
      const adapter = (context["adapter"] as string | null) ?? "docker"
      const mode = (context["mode"] as string | null) ?? "resident"
      const sandboxSessionId = (context["session_id"] as string | null) ?? null
      const capabilityDescriptor =
        (context["capability_descriptor"] as Record<string, unknown> | null) ??
        {}
      await trx
        .insertInto("runtimes")
        .values({
          id: pendingRuntimeId,
          workspaceId: session.workspaceId as string,
          kind: "sandbox",
        } as never)
        .execute()
      await trx
        .insertInto("sandboxes")
        .values({
          id: pendingRuntimeId,
          workspaceId: session.workspaceId as string,
          sessionId: sandboxSessionId,
          mode,
          adapter,
          state: "provisioning",
          resourceId: "",
          hostPid: null,
          pairingSessionId: session.id as string,
          capabilityDescriptor: sql`${JSON.stringify(capabilityDescriptor)}::jsonb`,
          // P1.6: the cloud-bootstrapping host self-reports its OS facts (same
          // source the device branch above uses). Unlike the local/bare mint
          // sites — which run ON the API host and use process.platform/arch — a
          // cloud sandbox's real platform is the REMOTE host's, so it must come
          // from the bootstrap args, not the API process. Without this the
          // projection's COALESCE degrades to linux/x64 and an arm64 cloud
          // sandbox gets x64-only bundled toolchains it can't run.
          platform: args.device.platform,
          arch: args.device.arch,
        } as never)
        .execute()
    }

    await trx
      .insertInto("runtimeServices")
      .values({
        id: args.service.serviceId,
        runtimeId: pendingRuntimeId,
        serviceKind: "device_runtime",
        version: args.service.version,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()
    await trx
      .insertInto("runtimeServiceKeys")
      .values({
        id: args.serviceKey.serviceKeyId,
        serviceId: args.service.serviceId,
        pubkey: args.serviceKey.pubkey,
        pubkeyFingerprint: args.serviceKey.pubkeyFingerprint,
      } as never)
      .execute()
    // Atomic UPDATE above already flipped status/timestamps. Just backfill
    // the runtime_id FK now that the runtime detail row exists.
    await trx
      .updateTable("runtimePairingSessions")
      .set({
        runtimeId: pendingRuntimeId,
      } as never)
      .where("id", "=", session.id as string)
      .execute()

    return {
      outcome: "ok",
      pendingRuntimeId,
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

/** Insert a runtime_control_plane_sessions row + bump runtime_services pointer. */
export async function insertControlPlaneSession(args: {
  sessionId: string
  runtimeId: string
  serviceId: string
  clientVersion: string | null
  remoteAddr: string | null
}): Promise<void> {
  await db
    .insertInto("runtimeControlPlaneSessions")
    .values({
      id: args.sessionId,
      runtimeId: args.runtimeId,
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
    .updateTable("runtimeServices")
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
    .updateTable("runtimeServices")
    .set({ tunnelPathToken: freshToken } as never)
    .where("id", "=", serviceId)
    .where("tunnelPathToken", "is", null)
    .execute()
  const row = await db
    .selectFrom("runtimeServices")
    .select(["tunnelPathToken"])
    .where("id", "=", serviceId)
    .executeTakeFirst()
  return (row?.tunnelPathToken as string | null) ?? null
}

/** Read a control-plane session's runtimeId (for in-flight task failure on close). */
export async function selectControlPlaneSessionRuntimeId(
  sessionId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("runtimeControlPlaneSessions")
    .select("runtimeId")
    .where("id", "=", sessionId)
    .executeTakeFirst()
  return (row?.runtimeId as string | null) ?? null
}

/** Close a control-plane session: mark it closed + clear the runtime_services pointer. */
export async function closeControlPlaneSessionRows(
  sessionId: string,
  reason: string
): Promise<void> {
  await db
    .updateTable("runtimeControlPlaneSessions")
    .set({
      status: "closed",
      endedAt: sql`NOW()`,
      closeReason: reason,
    } as never)
    .where("id", "=", sessionId)
    .execute()
  await db
    .updateTable("runtimeServices")
    .set({
      currentSessionId: null,
    } as never)
    .where("currentSessionId", "=", sessionId)
    .execute()
}

/** device.hello workspace cache lookup. Returns the runtime's workspaceId or
 *  null. Generalized to the runtimes supertype (P2) so a device-less
 *  kind='sandbox' runtime attributes its per-message runtime_events identically
 *  (runtimes.workspace_id === devices.workspace_id for a device). */
export async function getRuntimeWorkspaceId(
  runtimeId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("runtimesLive")
    .select(["workspaceId"])
    .where("id", "=", runtimeId)
    .executeTakeFirst()
  return (row?.workspaceId as string | undefined) ?? null
}

/** Read the persisted tunnel_path_token bound to a device_service (frp-edge
 *  validation). Executor-injectable (tests pass a testcontainer db). */
export async function selectTunnelPathToken(
  runtimeServiceId: string,
  executor: KyselyDb = db
): Promise<string | null> {
  const row = await executor
    .selectFrom("runtimeServices")
    .select(["tunnelPathToken"])
    .where("id", "=", runtimeServiceId)
    .executeTakeFirst()
  return (row?.tunnelPathToken as string | null) ?? null
}

/**
 * Persist the established data-plane reachability for a device_runtime service at
 * tunnel.up (§3). The value is set from the trust path the SSRF validator actually
 * accepted (frp edge → 'indirect', loopback → 'direct'), so the column is truthful
 * by construction rather than a separately-declared intent that could drift. Scoped
 * to device_runtime — the CHECK forbids writing a non-'direct' transport onto a
 * bare_dataplane row, and daemons have no data plane.
 */
export async function updateRuntimeServiceTransport(
  runtimeServiceId: string,
  transport: "direct" | "indirect",
  executor: KyselyDb = db
): Promise<void> {
  await executor
    .updateTable("runtimeServices")
    .set({ transport })
    .where("id", "=", runtimeServiceId)
    .where("serviceKind", "=", "device_runtime")
    .execute()
}

export type RuntimeHelloAuthContext = {
  runtimeExists: boolean
  service: { id: string; runtimeId: string } | null
  activeKey: {
    id: string
    pubkey: string
    pubkeyFingerprint: string
  } | null
}

/** runtime.hello auth lookup. Signature verification stays in control-plane-auth. */
export async function selectRuntimeHelloAuthContext(
  input: { runtimeId: string; serviceId: string },
  executor: KyselyDb = db
): Promise<RuntimeHelloAuthContext> {
  // Generalized to the runtimes supertype (P2): a device-less kind='sandbox'
  // runtime must authenticate runtime.hello identically. Existence + liveness are
  // rooted on runtimes (its sole soft-delete authority); the service + key reads
  // below are already runtime-keyed, so a sandbox runtime with its
  // runtime_service_keys row authenticates exactly like a device.
  const runtime = await executor
    .selectFrom("runtimesLive")
    .select(["id"])
    .where("id", "=", input.runtimeId)
    .executeTakeFirst()
  if (!runtime) return { runtimeExists: false, service: null, activeKey: null }

  const serviceRow = await executor
    .selectFrom("runtimeServices")
    .select(["id", "runtimeId"])
    .where("id", "=", input.serviceId)
    .executeTakeFirst()
  const service =
    serviceRow && serviceRow.runtimeId === input.runtimeId
      ? {
          id: serviceRow.id as string,
          runtimeId: serviceRow.runtimeId as string,
        }
      : null
  if (!service) return { runtimeExists: true, service: null, activeKey: null }

  const keyRow = await executor
    .selectFrom("runtimeServiceKeys")
    .select(["id", "pubkey", "pubkeyFingerprint"])
    .where("serviceId", "=", input.serviceId)
    .where("revokedAt", "is", null)
    .executeTakeFirst()
  return {
    runtimeExists: true,
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
 * Whether the runtime_service belongs to a LIVE, resident local sandbox — the
 * loopback-SSRF liveness predicate that gates acceptance of a loopback
 * internal_url. Resolves purely from the `sandboxes` row (adapter='local',
 * mode='resident', state NOT IN closed/failed, runtimes.deleted_at IS NULL); it
 * touches NO file_mount. The "...Mount" suffix on the name is retained only for
 * call-site stability. Executor-injectable (tests pass a testcontainer db).
 */
export async function hasLiveLocalSandboxMount(
  runtimeServiceId: string,
  executor: KyselyDb = db
): Promise<boolean> {
  // Resolve via the sandboxes row directly (the sole identity, P3). The loopback
  // gate fires DURING backend.create() — before the mount back-fill — but
  // mintLocalSandboxRuntimeTx has already created the sandboxes row at create()
  // start, so a device-less local sandbox resolves here without any mount.
  const bySandbox = await executor
    .selectFrom("sandboxes as sb")
    .innerJoin("runtimeServices as s", "s.runtimeId", "sb.id")
    .innerJoin("runtimes as r", "r.id", "sb.id")
    .select("sb.id")
    .where("s.id", "=", runtimeServiceId)
    .where("sb.adapter", "=", "local")
    // Belt-and-braces (§3.5): only a RESIDENT local sandbox reaches the loopback
    // branch. A bare local sandbox has no CP session and never sends tunnel.up, so
    // it can't get here anyway — but the mode term makes "loopback ⇒ resident-local"
    // structural, not incidental.
    .where("sb.mode", "=", "resident")
    .where(sql<boolean>`sb.state NOT IN ('closed', 'failed')`)
    .where("r.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return Boolean(bySandbox)
}

// ════════════════════════════════════════════════════════════════════════════
// control-plane-events.ts — runtime sessions, operation lifecycle, events
// ════════════════════════════════════════════════════════════════════════════

/** Open (upsert) a runtime session + its service row in one transaction. */
export async function upsertRuntimeSessionOpened(input: {
  runtimeSessionId: string
  runtimeId: string
  serviceId: string
  conversationId: string | null
  actorId: string | null
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("runtimeSessions")
      .values({
        id: input.runtimeSessionId,
        runtimeId: input.runtimeId,
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
      .insertInto("runtimeSessionServices")
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
  runtimeId: string
  serviceId: string
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("runtimeSessions")
      .set({
        status: "closed",
        closedAt: sql`NOW()`,
      })
      .where("id", "=", input.runtimeSessionId)
      .where("runtimeId", "=", input.runtimeId)
      .execute()
    await trx
      .updateTable("runtimeSessionServices")
      .set({ status: "closed", closedAt: sql`NOW()` })
      .where("sessionId", "=", input.runtimeSessionId)
      .where("serviceId", "=", input.serviceId)
      .execute()
  })
}

/** Operation-ownership read: the runtime_operations row (id + owning device). */
export async function selectRuntimeOperationOwner(
  operationId: string
): Promise<{ id: string; runtimeId: string } | undefined> {
  const op = await db
    .selectFrom("runtimeOperations")
    .select(["id", "runtimeId"])
    .where("id", "=", operationId)
    .executeTakeFirst()
  return op
    ? { id: op.id as string, runtimeId: op.runtimeId as string }
    : undefined
}

/** Operation-ownership read: the runtime_operation_attempts row. */
export async function selectRuntimeOperationAttempt(
  attemptId: string
): Promise<
  { id: string; operationId: string; runtimeServiceId: string } | undefined
> {
  const attempt = await db
    .selectFrom("runtimeOperationAttempts")
    .select(["id", "operationId", "runtimeServiceId"])
    .where("id", "=", attemptId)
    .executeTakeFirst()
  return attempt
    ? {
        id: attempt.id as string,
        operationId: attempt.operationId as string,
        runtimeServiceId: attempt.runtimeServiceId as string,
      }
    : undefined
}

/** The tool_call_tasks.id linked to a device operation, if any. */
export async function selectTaskIdForOperation(
  operationId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("runtimeOperations")
    .select("taskId")
    .where("id", "=", operationId)
    .executeTakeFirst()
  return (row?.taskId as string | null) || null
}

/** Set a runtime_operations.status (scoped to the owning device). */
export async function setRuntimeOperationStatus(
  operationId: string,
  runtimeId: string,
  status: string
): Promise<void> {
  await db
    .updateTable("runtimeOperations")
    .set({ status } as never)
    .where("id", "=", operationId)
    .where("runtimeId", "=", runtimeId)
    .execute()
}

/** Set a runtime_operation_attempts.status (scoped to the owning service). */
export async function setRuntimeOperationAttemptStatus(
  attemptId: string,
  serviceId: string,
  status: string
): Promise<void> {
  await db
    .updateTable("runtimeOperationAttempts")
    .set({ status } as never)
    .where("id", "=", attemptId)
    .where("runtimeServiceId", "=", serviceId)
    .execute()
}

/** Guarded transition to output_streaming (only from started/output_streaming). */
export async function markRuntimeOperationOutputStreaming(
  operationId: string,
  runtimeId: string
): Promise<void> {
  await db
    .updateTable("runtimeOperations")
    .set({ status: "output_streaming" } as never)
    .where("id", "=", operationId)
    .where("runtimeId", "=", runtimeId)
    .where("status", "in", ["started", "output_streaming"])
    .execute()
}

/**
 * Finalize an operation result (succeeded/failed + completedAt NOW()), and the
 * matching attempt (acknowledged/failed + responseAt/acknowledgedAt) in one
 * transaction.
 */
export async function finalizeRuntimeOperationResult(input: {
  operationId: string
  runtimeId: string
  attemptId?: string
  serviceId: string
  ok: boolean
  resultHash: string | null
  errorCode: string | null
  errorMessage: string | null
}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("runtimeOperations")
      .set({
        status: input.ok ? "succeeded" : "failed",
        resultHash: input.resultHash,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: sql`NOW()`,
      })
      .where("id", "=", input.operationId)
      .where("runtimeId", "=", input.runtimeId)
      .execute()
    if (input.attemptId) {
      await trx
        .updateTable("runtimeOperationAttempts")
        .set({
          status: input.ok ? "acknowledged" : "failed",
          responseAt: sql`NOW()`,
          acknowledgedAt: input.ok ? sql`NOW()` : null,
        })
        .where("id", "=", input.attemptId)
        .where("runtimeServiceId", "=", input.serviceId)
        .execute()
    }
  })
}

/** In-flight (non-terminal) device_tool task ids for a device (join select). */
export async function selectInFlightRuntimeTaskIds(
  runtimeId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom("runtimeOperations as op")
    .innerJoin("toolCallTasks as t", "t.id", "op.taskId")
    .select("op.taskId as taskId")
    .where("op.runtimeId", "=", runtimeId)
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
export async function selectExpiredRuntimeTaskIds(
  now: Date
): Promise<string[]> {
  const rows = await db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("executorKind", "=", "runtime_tool")
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

/** Merge a vfs snapshot into runtime_exposures.metadata (jsonb COALESCE/|| merge). */
export async function mergeVfsExposureMetadata(
  exposureId: string,
  runtimeId: string,
  vfsJson: string
): Promise<void> {
  await db
    .updateTable("runtimeExposures")
    .set({
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('vfs', ${vfsJson}::jsonb)`,
    } as never)
    .where("id", "=", exposureId)
    .where("runtimeId", "=", runtimeId)
    .execute()
}

// ════════════════════════════════════════════════════════════════════════════
// operations.ts — device operation transactions
// ════════════════════════════════════════════════════════════════════════════

export type OperationPrincipalKind =
  | "actor"
  | "conversation"
  | "remote_agent"
  | "workspace_member"

export interface BeginOperationInput {
  workspaceId: string
  conversationId: string | null
  envelope: OperationEnvelope
  args: Record<string, unknown>
  toolName: string
  runtimeId: string
  runtimeServiceId: string
  tunnelInternalUrl: string | null
  principalKind: OperationPrincipalKind
  principalSubjectId: string
  initiatedByWorkspaceMemberId: string | null
  initiatedBySessionId: string | null
  /**
   * Attempt transport (§4.3). Defaults to 'mcp_http' so every existing caller
   * (which omits it) writes a byte-identical attempt row. The Mode-B bare
   * data-plane dispatch passes 'data_plane' (in-process / docker-exec — no
   * dialable endpoint, so tunnel_internal_url is NULL).
   */
  transport?: "mcp_http" | "control_plane_task" | "data_plane"
}

export interface BeginOperationResult {
  operationId: string
  attemptId: string
  attemptSeq: number
}

export interface CompleteOperationInput {
  operationId: string
  attemptId: string
  ok: boolean
  resultHash?: string
  error?: SynapseError
}

export class RevisionDriftError extends Error {
  readonly code = "tool_definition_changed" as const
  constructor(message: string) {
    super(message)
    this.name = "RevisionDriftError"
  }
}

export async function beginRuntimeOperationOn(
  trx: DatabaseTransaction,
  input: BeginOperationInput
): Promise<BeginOperationResult> {
  const operationId = input.envelope.operation_id
  const attemptId = input.envelope.attempt_id
  await trx
    .insertInto("runtimeOperations")
    .values({
      id: operationId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      principalKind: input.principalKind,
      principalSubjectId: input.principalSubjectId,
      initiatedByWorkspaceMemberId: input.initiatedByWorkspaceMemberId,
      initiatedBySessionId: input.initiatedBySessionId,
      runtimeId: input.runtimeId,
      runtimeExposureId: input.envelope.runtime_exposure_id,
      runtimeCapabilityId: input.envelope.runtime_capability_id,
      catalogRevisionId: await getCatalogRevisionForToolRevision(
        trx,
        input.envelope.runtime_tool_revision_id
      ),
      toolId: input.envelope.runtime_tool_id,
      toolRevisionId: input.envelope.runtime_tool_revision_id,
      visibleToolName: input.toolName,
      taskMode: input.envelope.task_mode,
      status: "dispatched",
      inputPayload: sql`${JSON.stringify(input.args)}::jsonb`,
      authorizationPayload: sql`${JSON.stringify(
        input.envelope.runtime_authorization ?? {}
      )}::jsonb`,
      inputHash: input.envelope.input_hash,
      expiresAt: parseInstantString(input.envelope.expires_at),
    })
    .execute()

  await trx
    .insertInto("runtimeOperationAttempts")
    .values({
      id: attemptId,
      operationId: operationId,
      attemptSeq: 1n,
      transport: input.transport ?? "mcp_http",
      runtimeServiceId: input.runtimeServiceId,
      tunnelInternalUrl: input.tunnelInternalUrl,
      mcpRequestId: attemptId,
      envelopeSignatureKid: input.envelope.signature_kid,
      status: "issued",
      startedAt: sql`NOW()`,
    })
    .execute()

  return { operationId, attemptId, attemptSeq: 1 }
}

async function getCatalogRevisionForToolRevision(
  trx: DatabaseTransaction,
  toolRevisionId: string
): Promise<string> {
  const row = await trx
    .selectFrom("runtimeToolRevisions")
    .select(["catalogRevisionId"])
    .where("id", "=", toolRevisionId)
    .executeTakeFirst()
  if (!row) {
    throw new Error(
      `runtime_tool_revision ${toolRevisionId} not found — envelope is stale`
    )
  }
  return row.catalogRevisionId as string
}

/**
 * Mark a previously-begun operation as completed or failed. Always called in
 * the dispatch loop's `finally` so partial states (errors mid-dispatch) still
 * land in the audit trail.
 */
export async function completeRuntimeOperation(
  input: CompleteOperationInput
): Promise<void> {
  await db.transaction().execute(async (trx: DatabaseTransaction) => {
    await trx
      .updateTable("runtimeOperationAttempts")
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
      .updateTable("runtimeOperations")
      .set({
        // Schema's runtime_operations_status terminal enum value is
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
// The whole sync is ONE db.transaction(): it spans runtime_exposures,
// runtime_capabilities, runtime_catalog_revisions, runtime_tools,
// runtime_tool_revisions PLUS the cross-module workspace_resources writes
// (insertWorkspaceResourceRoot/updateWorkspaceResourceRoot), and the stale-state reap.
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
    ([a], [b]) => {
      if (a < b) return -1
      if (a > b) return 1
      return 0
    }
  )
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`
}

function toolDefinitionHash(tool: RuntimeCatalogTool): string {
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

function exposureSchemaHash(exposure: RuntimeCatalogExposure): string {
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
  runtimeId: string
  serviceId: string
  exposures: RuntimeCatalogExposure[]
  /**
   * TEST SEAM only (mirrors mintLocalSandboxRuntimeTx.executor). When present,
   * the sync runs inside the supplied handle instead of opening a fresh global
   * `db.transaction()`, so a pin can drive the REAL persistCatalogSync against
   * an ephemeral withTestDb transaction. Production omits it → unchanged.
   */
  executor?: KyselyDb
}

export interface AssignedToolIds {
  runtime_tool_id: string
  runtime_tool_revision_id: string
}
export interface AssignedExposureIds {
  runtime_exposure_id: string
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
  const run = async (
    trx: DatabaseTransaction
  ): Promise<PersistCatalogSyncResult> => {
    // Generalized to the runtimes supertype (P4a / PREREQ-CAT): existence +
    // workspace attribution are rooted on `runtimes` (the sole soft-delete
    // root), NOT `devices` — a device-less kind='sandbox' runtime (bare or
    // resident) has NO `devices` row, so the old `selectFrom("devices")`
    // read made the api-authored catalog persist impossible for it. Byte-
    // identical for a real device: its `runtimes` row carries the same
    // workspace_id, and `workspace_id` for exposures/capabilities is
    // denormalized from the authenticated runtime, never client catalog data.
    const runtime = await trx
      .selectFrom("runtimes")
      .select(["id", "workspaceId"])
      .where("id", "=", input.runtimeId)
      .where("deletedAt", "is", null)
      .executeTakeFirst()
    if (!runtime) {
      throw new Error(
        `persistCatalogSync: runtime ${input.runtimeId} not found`
      )
    }

    let newRevisionCount = 0
    let toolRevisionCount = 0
    const seenExposureIds = new Set<string>()
    const seenToolIdsByExposure = new Map<string, Set<string>>()
    const assignedIds: AssignedCatalogIds = {}

    for (const exposure of input.exposures) {
      const exposureId = await upsertExposure(trx, {
        runtimeId: input.runtimeId,
        workspaceId: runtime.workspaceId as string,
        serviceId: input.serviceId,
        exposure,
      })
      seenExposureIds.add(exposureId)
      await ensureCapability(trx, {
        workspaceId: runtime.workspaceId as string,
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
        runtime_exposure_id: exposureId,
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
      .selectFrom("runtimeExposures")
      .select(["id"])
      .where("runtimeId", "=", input.runtimeId)
      .execute()
    const staleExposureIds = allExposureIds
      .map((r) => r.id as string)
      .filter((id) => !seenExposureIds.has(id))
    if (staleExposureIds.length > 0) {
      const updated = await trx
        .updateTable("runtimeExposures")
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
        .selectFrom("runtimeTools")
        .select(["id"])
        .where("exposureId", "=", exposureId)
        .execute()
      const stale = allToolIds
        .map((r) => r.id as string)
        .filter((id) => !seenToolIds.has(id))
      if (stale.length === 0) continue
      const updated = await trx
        .updateTable("runtimeTools")
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
  }
  // Injected executor (test seam) runs the body directly — the whole test is
  // already one rolled-back transaction; the deferred CTI-consistency triggers
  // validate at the outer boundary. Production omits it → fresh atomic tx.
  if (input.executor) {
    return run(input.executor as unknown as DatabaseTransaction)
  }
  return db.transaction().execute(run)
}

async function upsertExposure(
  trx: DatabaseTransaction,
  args: {
    runtimeId: string
    workspaceId: string
    serviceId: string
    exposure: RuntimeCatalogExposure
  }
): Promise<string> {
  const existing = await trx
    .selectFrom("runtimeExposures")
    .select(["id"])
    .where("runtimeId", "=", args.runtimeId)
    .where("stableKey", "=", args.exposure.stable_key)
    .executeTakeFirst()
  const metadata = sql`${JSON.stringify(args.exposure.metadata ?? {})}::jsonb`
  if (existing) {
    await trx
      .updateTable("runtimeExposures")
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
    .insertInto("runtimeExposures")
    .values({
      runtimeId: args.runtimeId,
      // workspace_id is NOT NULL and denormalized from the authenticated
      // runtime's workspace — NEVER from client-supplied catalog data.
      workspaceId: args.workspaceId,
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
  // Owner attribution generalized to the runtimes supertype (P4a / PREREQ-CAT).
  // Root on `runtimes` (always present) and LEFT JOIN `devices` — a bare/
  // device-less sandbox runtime has no `devices` row, so its owner is NULL
  // (owner-less, createdByPlatform). Byte-identical for a real device: the
  // LEFT JOIN is a superset of the old INNER JOIN (devices.id === runtimes.id),
  // and owner is surfaced ONLY for kind='device'.
  const capabilityOwner = await trx
    .selectFrom("runtimeExposures as exposure")
    .innerJoin("runtimes as runtime", "runtime.id", "exposure.runtimeId")
    .leftJoin("devices as device", "device.id", "runtime.id")
    .select([
      "device.ownerWorkspaceMemberId",
      "exposure.displayName",
      "runtime.kind as runtimeKind",
    ])
    .where("exposure.id", "=", args.exposureId)
    .executeTakeFirst()
  // owner only for kind='device' (bare capability is owner-less). The LEFT
  // JOIN already yields NULL for a non-device runtime; the explicit gate makes
  // the §4.3 owner-less-bare contract legible and defends against any future
  // devices-row leakage.
  const ownerWorkspaceMemberId =
    (capabilityOwner?.runtimeKind as string | null) === "device"
      ? ((capabilityOwner?.ownerWorkspaceMemberId as string | null) ?? null)
      : null
  const existing = await trx
    .selectFrom("runtimeCapabilities")
    .select(["id"])
    .where("exposureId", "=", args.exposureId)
    .executeTakeFirst()
  if (existing) {
    await updateWorkspaceResourceRoot(trx, {
      id: existing.id as string,
      displayName:
        (capabilityOwner?.displayName as string | null) || "Device capability",
      ownerWorkspaceMemberId,
    })
    return
  }
  const capabilityId = crypto.randomUUID()
  await insertWorkspaceResourceRoot(trx, {
    id: capabilityId,
    workspaceId: args.workspaceId,
    kind: "runtime_capability",
    displayName:
      (capabilityOwner?.displayName as string | null) || "Device capability",
    // owner = the backing device's owner member subject (or NULL when the
    // device has no owner, or the runtime is a device-less sandbox); creator =
    // platform (catalog-sync, no human). §B/§4.1/§4.3
    ownerWorkspaceMemberId,
    createdByPlatform: true,
    status: "active",
  })
  await trx
    .insertInto("runtimeCapabilities")
    .values({
      id: capabilityId,
      exposureId: args.exposureId,
      // workspace_id is NOT NULL and denormalized from the authenticated
      // runtime's workspace (ensureCapability's caller passes runtime.workspaceId,
      // pinned by the composite FK to runtime_exposures(id,workspace_id)).
      workspaceId: args.workspaceId,
    } as never)
    .execute()
}

/**
 * Coerce a persisted revision_seq (bigint | number | string | undefined/null)
 * to a JS number. Unknown/absent values fall back to 0 — preserving the prior
 * ternary's catch-all branch (do NOT throw: `latest?.revisionSeq` is undefined
 * when there is no prior revision).
 */
function revisionSeqToNumber(latestSeqRaw: unknown): number {
  switch (typeof latestSeqRaw) {
    case "bigint":
      return Number(latestSeqRaw)
    case "number":
      return latestSeqRaw
    case "string":
      return Number(latestSeqRaw)
    default:
      return 0
  }
}

async function ensureCatalogRevision(
  trx: DatabaseTransaction,
  args: { exposureId: string; schemaHash: string }
): Promise<{ revisionId: string; isNew: boolean }> {
  const latest = await trx
    .selectFrom("runtimeCatalogRevisions")
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
      .updateTable("runtimeCatalogRevisions")
      .set({
        status: "superseded",
        invalidatedAt: sql`NOW()`,
      } as never)
      .where("id", "=", latest.id as string)
      .execute()
  }
  const latestSeqRaw = latest?.revisionSeq
  const latestSeqNumber = revisionSeqToNumber(latestSeqRaw)
  const nextSeqNumber = latestSeqNumber + 1
  const inserted = await trx
    .insertInto("runtimeCatalogRevisions")
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
    tools: RuntimeCatalogTool[]
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
      .selectFrom("runtimeTools")
      .select(["id", "latestRevisionId"])
      .where("exposureId", "=", args.exposureId)
      .where("stableKey", "=", tool.stable_key)
      .executeTakeFirst()
    let toolId: string
    if (existingTool) {
      toolId = existingTool.id as string
      await trx
        .updateTable("runtimeTools")
        .set({
          currentName: tool.name,
          status: "active",
          lastSeenAt: sql`NOW()`,
        } as never)
        .where("id", "=", toolId)
        .execute()
    } else {
      const insertedTool = await trx
        .insertInto("runtimeTools")
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
      .selectFrom("runtimeToolRevisions")
      .select(["id", "definitionHash"])
      .where("toolId", "=", toolId)
      .where("catalogRevisionId", "=", args.catalogRevisionId)
      .executeTakeFirst()
    let revisionId: string
    if (existingRevision) {
      revisionId = existingRevision.id as string
      if ((existingRevision.definitionHash as string) !== definitionHash) {
        await trx
          .updateTable("runtimeToolRevisions")
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
        .insertInto("runtimeToolRevisions")
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
      .updateTable("runtimeTools")
      .set({ latestRevisionId: revisionId } as never)
      .where("id", "=", toolId)
      .execute()
    assignedTools[tool.name] = {
      runtime_tool_id: toolId,
      runtime_tool_revision_id: revisionId,
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
  // devicesLive folds the runtimes soft-delete root (runtimes.deleted_at);
  // devices no longer carries its own deleted_at column.
  const rows = await db
    .selectFrom("devicesLive")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .orderBy("createdAt", "desc")
    .execute()
  return rows.map((row) =>
    toDeviceSummaryRecord({
      id: row.id as string,
      workspaceId: row.workspaceId as string,
      title: row.title as string,
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
  // devicesLive folds the runtimes soft-delete root; devices has no deleted_at.
  const deviceRow = await db
    .selectFrom("devicesLive")
    .selectAll()
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", deviceId)
    .executeTakeFirst()
  if (!deviceRow) {
    return null
  }

  const serviceRows = await db
    .selectFrom("runtimeServices")
    .selectAll()
    .where("runtimeId", "=", deviceId)
    .orderBy("createdAt", "asc")
    .execute()
  const services: RuntimeServiceRecord[] = serviceRows.map((row) => ({
    id: row.id as string,
    deviceId: row.runtimeId as string,
    serviceKind: row.serviceKind as RuntimeServiceKind,
    version: (row.version as string | null) ?? null,
    status: row.status as RuntimeServiceRecord["status"],
    lastSeenAt: row.lastSeenAt as Date | null,
    remoteAgentMachineId: (row.remoteAgentMachineId as string | null) ?? null,
  }))

  const capabilityRows = await db
    .selectFrom("runtimeCapabilities as dc")
    .innerJoin("workspaceResources as resource", "resource.id", "dc.id")
    .innerJoin("runtimeExposures as dx", "dx.id", "dc.exposureId")
    .select([
      "dc.id as id",
      "resource.workspaceId as workspaceId",
      "dc.exposureId as exposureId",
      "dx.stableKey as exposureStableKey",
      "resource.displayName as displayName",
      "dx.transport as transport",
      "dx.builtinKind as builtinKind",
      "dx.runtimeStatus as runtimeStatus",
      "dx.metadata as exposureMetadata",
    ])
    .where("dx.runtimeId", "=", deviceId)
    .where("resource.deletedAt", "is", null)
    .where("resource.status", "=", "active")
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
 * Soft-delete a runtime (design §5.3): never hard-deleted — flip runtimes.deleted_at
 * and KEEP all runtime_* child rows for audit. Returns numUpdatedRows so the service
 * can decide the 404. Child rows are hidden via the runtimes-liveness filter and
 * *_live views (§8.6); hard delete is forbidden by sd_reject_delete. Pass
 * `requireKind` to scope the delete to one runtime kind (device vs sandbox).
 */
export async function softDeleteRuntime(
  workspaceId: string,
  runtimeId: string,
  opts?: { requireKind?: "device" | "sandbox" },
  run: Executor = db
): Promise<number> {
  // runtimes.deleted_at is the SOLE runtime soft-delete root (devices/sandboxes
  // shed their own deleted_at). Flip the supertype row; the detail stays for
  // audit and is hidden via runtimes-liveness folds (*_live). `requireKind`
  // scopes the flip: the /devices/:id endpoint passes 'device' so a sandbox
  // runtime id never matches (0 rows → the caller's 404), preventing a
  // manage_devices holder from terminating an Actor sandbox via the device API.
  // `run` defaults to the global db (prod); the sandbox teardown/crash-recovery
  // path threads its pinned executor so the flip lands on the same connection.
  let q = run
    .updateTable("runtimes")
    .set({ deletedAt: new Date() })
    .where("workspaceId", "=", workspaceId)
    .where("id", "=", runtimeId)
    .where("deletedAt", "is", null)
  if (opts?.requireKind) {
    q = q.where("kind", "=", opts.requireKind)
  }
  const result = await q.executeTakeFirst()
  return Number(result.numUpdatedRows ?? 0)
}

/** Insert a local/service-join pairing session. `contextJson` carries the
 *  caller-built JSON string; the ::jsonb cast lives here. */
export async function insertLocalPairingSession(args: {
  sessionId: string
  workspaceId: string
  requestedByWorkspaceMemberId: string | null
  targetRuntimeKind?: "device" | "sandbox"
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
    .insertInto("runtimePairingSessions")
    .values({
      id: args.sessionId,
      workspaceId: args.workspaceId,
      requestedByWorkspaceMemberId: args.requestedByWorkspaceMemberId,
      runtimeId: null,
      targetRuntimeKind: args.targetRuntimeKind ?? "device",
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
 * diagnostic SELECT on race-loss, three INSERTs (devices, runtimeServices,
 * runtimeServiceKeys) and the runtime_id FK backfill — atomic in ONE
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
  /** TEST SEAM only (see consumeCloudBootstrapTx / runInInjectableTx). */
  executor?: KyselyDb
}): Promise<ConsumeLocalPairingResult> {
  return runInInjectableTx(args.executor, async (trx) => {
    // Atomic single-shot consume: UPDATE the pairing session with status
    // change conditioned on it still being pending + matching mode + not
    // expired. RETURNING gives us the full row on success; nothing on any
    // race-loss or invalid state. Two concurrent claim attempts can no
    // longer both produce a trusted device.
    const claimedRows = await trx
      .updateTable("runtimePairingSessions")
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
        .selectFrom("runtimePairingSessions")
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
      const expiresAt = existing.expiresAt.getTime()
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

    // P2 fork: which runtime kind this pairing mints. Defaults to 'device' so a
    // real local device stays byte-identical. Local sandboxes normally use the
    // direct-mint path (mintLocalSandboxRuntimeTx); this branch is the documented
    // pairing-fork fallback (§4.6).
    // local_qr pairing is ALWAYS a device: startPairing never sets
    // targetRuntimeKind='sandbox', and local sandboxes direct-mint via
    // mintLocalSandboxRuntimeTx (they never pair). The old target_runtime_kind fork's
    // sandbox arm here was unreachable and has been removed; runtimes(kind='device') +
    // a devices detail row remain the verbatim device-pairing inserts.
    const title = args.title ?? session.requestedTitle ?? "Device"
    const deviceType =
      args.deviceType ??
      (session.requestedDeviceType as DeviceType | null) ??
      ("desktop_computer" as DeviceType)

    // runtimes(kind='device') supertype root MUST be inserted in the same tx
    // before the devices detail (deferred root FK + detail-consistency trigger
    // validate at commit).
    await trx
      .insertInto("runtimes")
      .values({
        id: deviceId,
        workspaceId: session.workspaceId as string,
        kind: "device",
      } as never)
      .execute()

    await trx
      .insertInto("devices")
      .values({
        id: deviceId,
        workspaceId: session.workspaceId as string,
        ownerWorkspaceMemberId: session.requestedByWorkspaceMemberId ?? null,
        title,
        description: (session.requestedDescription as string | null) ?? null,
        deviceType: deviceType,
        platform: args.platform ?? null,
        arch: args.arch ?? null,
        publicKey: args.devicePubkey,
        publicKeyFingerprint: args.pubkeyFingerprint,
        trustStatus: "trusted",
      } as never)
      .execute()

    await trx
      .insertInto("runtimeServices")
      .values({
        id: serviceId,
        runtimeId: deviceId,
        serviceKind: "device_runtime",
        version: args.clientVersion ?? null,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()

    await trx
      .insertInto("runtimeServiceKeys")
      .values({
        id: serviceKeyId,
        serviceId: serviceId,
        pubkey: args.servicePubkey,
        pubkeyFingerprint: args.serviceFingerprint,
      } as never)
      .execute()

    // Backfill runtime_id on the already-consumed pairing session row. The
    // earlier atomic UPDATE flipped status/timestamps; we just need the FK
    // wired now that the device row exists.
    await trx
      .updateTable("runtimePairingSessions")
      .set({
        runtimeId: deviceId,
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

/**
 * Direct-mint a device-less LOCAL sandbox runtime (§4.6). ONE tx:
 * runtimes(kind='sandbox') + sandboxes(adapter='local', pairing_session_id=NULL)
 * + runtime_services(device_runtime) + runtime_service_keys. Mirrors
 * consumeLocalPairingTx's sandbox branch minus the pairing claim/backfill (there
 * is no pairing session — the API authors the on-disk broker identity in-process
 * and spawns `synapse-device run` directly). runtimeId is a FRESH UUID per
 * provision (CORRECTION 1 — deriving it from sessionId would PK-collide with a
 * soft-deleted row on re-provision). The device pubkey never persists (it lives
 * in the on-disk identity file); only the SERVICE key is registered here — that
 * is what device.hello verifies.
 */
// P1.6: real OS facts persisted on the sandbox row at mint, read by the
// capability projection's bundle-eligibility + Windows-guard logic (COALESCE
// d.platform, sb.platform, 'linux'). A host-side sandbox's platform is knowable
// exactly here — local runs directly on the API host; docker (DooD) is a linux
// container on that host, so its arch matches the host. Off-box providers
// (E2B/Cube) will declare their own platform/arch when those adapters land.
function sandboxHostPlatformArch(adapter: string): {
  platform: string
  arch: string
} {
  if (adapter === "docker") return { platform: "linux", arch: process.arch }
  return { platform: process.platform, arch: process.arch }
}

export async function mintLocalSandboxRuntimeTx(args: {
  runtimeId: string
  workspaceId: string
  sessionId: string
  serviceId: string
  serviceKeyId: string
  servicePubkey: string
  serviceFingerprint: string
  adapter?: string
  mode?: "resident" | "bare"
  clientVersion?: string | null
  capabilityDescriptor?: Record<string, unknown>
  /** TEST SEAM only (see consumeCloudBootstrapTx / runInInjectableTx). */
  executor?: KyselyDb
}): Promise<{ runtimeId: string; serviceId: string; serviceKeyId: string }> {
  return runInInjectableTx(args.executor, async (trx) => {
    await trx
      .insertInto("runtimes")
      .values({
        id: args.runtimeId,
        workspaceId: args.workspaceId,
        kind: "sandbox",
      } as never)
      .execute()
    await trx
      .insertInto("sandboxes")
      .values({
        id: args.runtimeId,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        mode: args.mode ?? "resident",
        adapter: args.adapter ?? "local",
        state: "provisioning",
        resourceId: "",
        hostPid: null,
        pairingSessionId: null,
        capabilityDescriptor: sql`${JSON.stringify(args.capabilityDescriptor ?? {})}::jsonb`,
        ...sandboxHostPlatformArch(args.adapter ?? "local"),
      } as never)
      .execute()
    await trx
      .insertInto("runtimeServices")
      .values({
        id: args.serviceId,
        runtimeId: args.runtimeId,
        serviceKind: "device_runtime",
        version: args.clientVersion ?? null,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()
    await trx
      .insertInto("runtimeServiceKeys")
      .values({
        id: args.serviceKeyId,
        serviceId: args.serviceId,
        pubkey: args.servicePubkey,
        pubkeyFingerprint: args.serviceFingerprint,
      } as never)
      .execute()
    return {
      runtimeId: args.runtimeId,
      serviceId: args.serviceId,
      serviceKeyId: args.serviceKeyId,
    }
  })
}

/**
 * Direct-mint a device-less BARE (Mode-B) sandbox runtime (§4.3 / §4.7.1). ONE
 * tx: runtimes(kind='sandbox') + sandboxes(mode='bare', pairing_session_id NULL,
 * capability_descriptor=<frozen>) + runtime_services(service_kind='bare_dataplane',
 * data_plane_endpoint=<scheme-tagged non-dialable>) — and NO runtime_service_keys
 * (no keypair, no broker, no pairing). The api-authored catalog is persisted
 * SYNCHRONOUSLY in the SAME tx via persistCatalogSync (S0-repointed), so the
 * exposure/capability/tool/revision ids the fork's target-id check needs are
 * committed atomically with the runtime. This bare create() is the ONLY code
 * that ever mints `service_kind='bare_dataplane'` and links exposures to it —
 * the mint-discipline half of the closed-over-absence proof (F-B).
 */
export async function mintBareSandboxRuntimeTx(args: {
  runtimeId: string
  workspaceId: string
  sessionId: string
  serviceId: string
  adapter: string
  /** Scheme-tagged non-dialable endpoint: 'inprocess:<id>' | 'docker-exec:<id>' | 'envd:<id>'. */
  dataPlaneEndpoint: string
  /**
   * (R4 §1.7/3c) The AUTHORITATIVE provider resource id, written in THIS insert
   * (not '' -then-backfilled) so a crash between mint and the post-create
   * back-fill can't leave resource_id='' (→ kill DELETEs an empty id → orphan).
   * off-box (cube) passes the sandbox id; host bare passes '' (no resource).
   */
  resourceId?: string
  /**
   * (R4 §1.3/3c) base64 AES-256-GCM envelope of the off-box data-plane creds,
   * bound (AAD) to this row's identity. NULL for host/resident + the
   * unauthenticated local cube. Written atomically with the row — no window.
   */
  credentialsEncrypted?: string | null
  /**
   * (R4 §1.6/2e) provider platform/arch facts (off-box VM), PREFERRED over
   * process.* — an arm64 API standing up an x86_64 cube must persist the VM's
   * arch, not the host's. Absent for host bare → sandboxHostPlatformArch.
   */
  platform?: string
  arch?: string
  capabilityDescriptor: Record<string, unknown>
  /** Descriptor-gated api-authored exposure set (buildBareCoreCatalog). */
  exposures: RuntimeCatalogExposure[]
  clientVersion?: string | null
  /** TEST SEAM only (see runInInjectableTx). */
  executor?: KyselyDb
}): Promise<{
  runtimeId: string
  serviceId: string
  dataPlaneEndpoint: string
  assignedIds: AssignedCatalogIds
}> {
  return runInInjectableTx(args.executor, async (trx) => {
    await trx
      .insertInto("runtimes")
      .values({
        id: args.runtimeId,
        workspaceId: args.workspaceId,
        kind: "sandbox",
      } as never)
      .execute()
    await trx
      .insertInto("sandboxes")
      .values({
        id: args.runtimeId,
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        mode: "bare",
        adapter: args.adapter,
        state: "provisioning",
        // R4 §1.7/3c: real provider resource id in the SAME insert (not '' then
        // backfilled) — closes the crash-between-mint-and-backfill orphan window.
        resourceId: args.resourceId ?? "",
        // R4 §1.3/3c: encrypted data-plane creds atomic with the row (NULL for
        // host/resident + the unauthenticated local cube).
        dataPlaneCredentialsEncrypted: args.credentialsEncrypted ?? null,
        hostPid: null,
        // NO pairing session — a bare sandbox never pairs.
        pairingSessionId: null,
        capabilityDescriptor: sql`${JSON.stringify(args.capabilityDescriptor)}::jsonb`,
        // R4 §1.6/2e: provider platform/arch facts PREFERRED over process.* for
        // off-box; host bare falls back to the API-host facts.
        ...(args.platform && args.arch
          ? { platform: args.platform, arch: args.arch }
          : sandboxHostPlatformArch(args.adapter)),
      } as never)
      .execute()
    await trx
      .insertInto("runtimeServices")
      .values({
        id: args.serviceId,
        runtimeId: args.runtimeId,
        serviceKind: "bare_dataplane",
        version: args.clientVersion ?? null,
        status: "online",
        // schema CHECK for bare_dataplane: data_plane_endpoint NOT NULL,
        // tunnel_path_token / current_session_id / remote_agent_machine_id NULL,
        // and transport MUST be 'direct' (chk_runtime_services_transport_kind) — a
        // bare data plane is always API-dialed (incl. the degenerate in/exec planes).
        dataPlaneEndpoint: args.dataPlaneEndpoint,
        transport: "direct",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()
    // NO runtime_service_keys insert — no keypair, no broker (§4.7.1).

    // Persist the api-authored catalog SYNCHRONOUSLY inside this tx (the runtime
    // row it reads for existence/workspace attribution is the one just inserted).
    const persisted = await persistCatalogSync({
      runtimeId: args.runtimeId,
      serviceId: args.serviceId,
      exposures: args.exposures,
      executor: trx,
    })
    return {
      runtimeId: args.runtimeId,
      serviceId: args.serviceId,
      dataPlaneEndpoint: args.dataPlaneEndpoint,
      assignedIds: persisted.assignedIds,
    }
  })
}

/** Discriminated outcome of the daemon-claim transaction. */
export type ClaimRemoteAgentDaemonResult =
  | { outcome: "ok"; service: RuntimeServiceRecord }
  | {
      outcome:
        | "device_not_found"
        | "machine_not_found"
        | "workspace_mismatch"
        | "already_claimed"
    }

/**
 * Owns the whole daemon-claim transaction: device ownership SELECT, machine
 * SELECT + workspace check, existing-claim SELECT, the runtimeServices INSERT
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
      .selectFrom("runtimeServices")
      .selectAll()
      .where("remoteAgentMachineId", "=", input.remoteAgentMachineId)
      .where("serviceKind", "=", "remote_agent_daemon")
      .executeTakeFirst()
    if (existing) {
      return { outcome: "already_claimed" }
    }

    const serviceId = randomUUID()
    await trx
      .insertInto("runtimeServices")
      .values({
        id: serviceId,
        runtimeId: input.deviceId,
        serviceKind: "remote_agent_daemon",
        version: null,
        status: "online",
        metadata: sql`'{}'::jsonb`,
        remoteAgentMachineId: input.remoteAgentMachineId,
      } as never)
      .execute()

    const row = await trx
      .selectFrom("runtimeServices")
      .selectAll()
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow()

    return {
      outcome: "ok",
      service: {
        id: row.id as string,
        deviceId: row.runtimeId as string,
        serviceKind: row.serviceKind as RuntimeServiceKind,
        version: (row.version as string | null) ?? null,
        status: row.status as RuntimeServiceRecord["status"],
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
export async function isRuntimeServiceOwnedByWorkspace(
  workspaceId: string,
  runtimeId: string,
  serviceId: string
): Promise<boolean> {
  const owned = await db
    .selectFrom("runtimeServices as ds")
    .innerJoin("devices as d", "d.id", "ds.runtimeId")
    .select("ds.id")
    .where("ds.id", "=", serviceId)
    .where("ds.runtimeId", "=", runtimeId)
    .where("d.workspaceId", "=", workspaceId)
    .executeTakeFirst()
  return Boolean(owned)
}

/**
 * Physical detach of a device_service via the SECURITY DEFINER fn. runtime_services
 * is a persistent child guarded by sd_reject_delete; the detach goes through
 * sd_detach_runtime_service (design §7.5/§11). Raw RPC kept verbatim.
 */
export async function detachRuntimeServiceRpc(
  serviceId: string,
  runtimeId: string
): Promise<void> {
  await sql`SELECT sd_detach_runtime_service(${serviceId}::uuid, ${runtimeId}::uuid)`.execute(
    db
  )
}
