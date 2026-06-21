// capability-projection/repo.ts — DB-touching helpers for device capability
// projection (the device-side read/write path of capability-projection).
//
// The only file in this module's device-capabilities boundary permitted to
// import the db client (guard r8). Owns the workspace_resource_grants reads/writes
// and the multi-join device-tool projection SELECT, plus the
// access_subjects resolution that threads a db handle into upsertAccessSubject.
// Orchestration / DTO shaping stays in device-capabilities.ts. round-6 P1-6.

import { sql } from "kysely"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import {
  db,
  type Executor,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { upsertAccessSubjectDefault } from "../access/guards.js"

export interface DeviceCapabilityToolRow {
  deviceId: string
  deviceName: string
  deviceServiceId: string
  deviceExposureId: string
  deviceCapabilityId: string
  deviceToolId: string
  deviceToolRevisionId: string
  catalogRevisionId: string
  transport: "builtin" | "stdio" | "http" | "sse" | "custom"
  builtinKind: "filesystem" | "commandline" | "browser" | "cua" | null
  visibleToolName: string
  visibleDescription: string
  inputSchema: unknown
  /** Per-capability mask override (NULL → fall back to workspace policy). */
  capabilityConversationTypeMaskOverride: number | null
  /** Per-device mask override. */
  deviceConversationTypeMaskOverride: number | null
  /**
   * v3.1: exposure.stable_key (e.g. "builtin/browser/navigation") + the
   * provider-emitted metadata object. Used by browser preflight to detect
   * disabled exposures and to attach disabledReason to user-facing errors.
   */
  exposureStableKey: string
  exposureMetadata: Record<string, unknown> | null
  /**
   * Raw devices.platform string ("win32", "darwin", "linux", or other).
   * Caller (capability-projection dispatch) passes this through
   * normalizeDevicePlatform before forwarding to the commandline matcher,
   * which uses it to apply Windows-specific guards (cwd unsupported in v1).
   */
  devicePlatform: string | null
  /** Raw devices.arch string (e.g. "x64", "arm64"). Combined with
   *  platform forms the bundles manifest's platformKey. */
  deviceArch: string | null
}

export interface LoadDeviceToolsParams {
  workspaceId: string
  /** subject_ids whose grants should count. */
  subjectIds: string[]
  /**
   * subject-scope-refactor: the set of scope subject_ids that may pin a
   * grant. A workspace_resource_grants row with `scope_subject_id = NULL` applies whenever the
   * subject matches; a row with non-NULL scope only applies when the scope
   * subject_id is present in this set. Without this filter,
   * `actor + scope=conversation` grants leak to the same actor's other
   * conversations.
   */
  runtimeScopeSubjectIds: string[]
}

export interface AccessTargetInput {
  kind: "workspace" | "actor" | "conversation" | "remote_agent"
  workspaceId?: string
  actorId?: string
  conversationId?: string
  remoteAgentId?: string
}

export type CapabilityProjectionRuntimeContextDb = KyselyDb

/**
 * Owns the distinctOn multi-join device-tool projection SELECT. Returns
 * the module's stable camelCase domain rows. Keeps the exposureMetadata
 * normalization map at the repo exit.
 */
export async function selectDeviceCapabilityToolsForSubjects(
  params: LoadDeviceToolsParams,
  run: Executor = db
): Promise<DeviceCapabilityToolRow[]> {
  if (params.subjectIds.length === 0) return []
  // distinctOn collapses duplicate rows when multiple subject grants cover
  // the same capability (e.g. workspace-scope + actor-scope both grant the
  // bash tool — without distinctOn the projection surfaces it twice and the
  // planner sees duplicate names).
  let query = run
    .selectFrom("deviceCapabilities as dc")
    .innerJoin("workspaceResources as resource", "resource.id", "dc.id")
    .innerJoin("workspaceResourceGrants as resource_grant", (join) =>
      join
        .onRef("resource_grant.workspaceResourceId", "=", "dc.id")
        .on("resource_grant.status", "=", "active")
    )
    .innerJoin("deviceExposures as dx", "dx.id", "dc.exposureId")
    .innerJoin("devices as d", "d.id", "dx.deviceId")
    .innerJoin("deviceTools as dt", "dt.exposureId", "dx.id")
    .innerJoin("deviceToolRevisions as dtr", "dtr.id", "dt.latestRevisionId")
    .innerJoin(
      "deviceCatalogRevisions as dcr",
      "dcr.id",
      "dtr.catalogRevisionId"
    )
    .distinctOn(["dt.id"])
    .select([
      "d.id as deviceId",
      "d.title as deviceName",
      "dx.serviceId as deviceServiceId",
      "dx.id as deviceExposureId",
      "dc.id as deviceCapabilityId",
      "dt.id as deviceToolId",
      "dtr.id as deviceToolRevisionId",
      "dcr.id as catalogRevisionId",
      "dx.transport as transport",
      "dx.builtinKind as builtinKind",
      "dx.stableKey as exposureStableKey",
      "dx.metadata as exposureMetadata",
      "dt.currentName as visibleToolName",
      "dtr.description as visibleDescription",
      "dtr.inputSchema as inputSchema",
      "resource.conversationTypeMaskOverride as capabilityConversationTypeMaskOverride",
      "d.conversationTypeMaskOverride as deviceConversationTypeMaskOverride",
      // Commit 8: surface device.platform so the commandline matcher can
      // apply Windows-specific guards (cwd unsupported in v1) at projection
      // time instead of relying solely on device-side bottom-of-stack
      // rejection. normalizeDevicePlatform turns the raw DB string into
      // "win32" | "linux" | "darwin" | undefined.
      "d.platform as devicePlatform",
      // Surface arch alongside platform so isBundleAvailableForPlatform can
      // exact-match against the runtime manifest's platformKey
      // (`<platform>-<arch>`). Without arch the API would have to assume
      // the device's arch matches an entry, which previously caused
      // "approved-but-unrunnable" for arm-only or x64-only manifests.
      "d.arch as deviceArch",
    ])
    .where("resource.workspaceId", "=", params.workspaceId)
    .where("resource.deletedAt", "is", null)
    // Soft-delete (§8.6): a soft-closed sandbox device keeps its child rows for
    // audit, but its tools must NOT be projected/resolved. Filter on device
    // liveness here (the projection joins device_* child tables directly rather
    // than through devices_live).
    .where("d.deletedAt", "is", null)
    .where("resource.status", "=", "active")
    .where("dt.status", "=", "active")
    .where("dcr.status", "=", "active")
    .where("dx.runtimeStatus", "in", ["healthy", "degraded"])
    .where("resource_grant.subjectId", "in", params.subjectIds)
    .where(
      sql<boolean>`'use'::workspace_resource_grant_permission = ANY(resource_grant.permissions)`
    )
  if (params.runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("resource_grant.scopeSubjectId", "is", null),
        eb(
          "resource_grant.scopeSubjectId",
          "in",
          params.runtimeScopeSubjectIds
        ),
      ])
    )
  } else {
    // No scope context — only unscoped grants apply.
    query = query.where("resource_grant.scopeSubjectId", "is", null)
  }
  const rows = await query.orderBy("dt.id").execute()
  // CamelCasePlugin.transformResult camelCases every top-level result key
  // (builder rows included), so the double-quoted/.as aliases arrive camelCase
  // and we read them directly. JSONB/Date values pass through untouched.
  return rows.map((row) => {
    return {
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      deviceServiceId: row.deviceServiceId,
      deviceExposureId: row.deviceExposureId,
      deviceCapabilityId: row.deviceCapabilityId,
      deviceToolId: row.deviceToolId,
      deviceToolRevisionId: row.deviceToolRevisionId,
      catalogRevisionId: row.catalogRevisionId,
      transport: row.transport,
      builtinKind: row.builtinKind,
      visibleToolName: row.visibleToolName,
      visibleDescription: row.visibleDescription,
      inputSchema: row.inputSchema,
      capabilityConversationTypeMaskOverride:
        row.capabilityConversationTypeMaskOverride,
      deviceConversationTypeMaskOverride:
        row.deviceConversationTypeMaskOverride,
      exposureStableKey: row.exposureStableKey,
      exposureMetadata:
        row.exposureMetadata &&
        typeof row.exposureMetadata === "object" &&
        !Array.isArray(row.exposureMetadata)
          ? (row.exposureMetadata as Record<string, unknown>)
          : null,
      devicePlatform: row.devicePlatform,
      deviceArch: row.deviceArch,
    }
  })
}

/**
 * Resolve an AccessTarget DTO into an access_subjects row id pair:
 * `(subjectId, scopeSubjectId?)`. Scope is populated when actor or
 * remote_agent targets carry a conversationId.
 *
 * `options.db` threads a Kysely handle into the underlying
 * `upsertAccessSubject` writes; the default path (no handle) routes through
 * the allowlisted `upsertAccessSubjectDefault` so callers need not import the
 * db client. Tests inject the ephemeral DB returned by `withTestDb`.
 */
export async function resolveScopedSubjectTarget(
  input: AccessTargetInput,
  options?: { db?: Executor }
): Promise<{ subjectId: string; scopeSubjectId?: string }> {
  const run = options?.db
  const upsert: (
    ref: Parameters<typeof upsertAccessSubjectDefault>[0]
  ) => Promise<string> = run
    ? (ref) => upsertAccessSubject(run, ref)
    : upsertAccessSubjectDefault
  switch (input.kind) {
    case "workspace": {
      if (!input.workspaceId) throw new Error("workspaceId required")
      const subjectId = await upsert({
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: input.workspaceId,
      })
      return { subjectId }
    }
    case "actor": {
      if (!input.actorId) throw new Error("actorId required")
      const subjectId = await upsert({
        kind: SUBJECT_KIND.ACTOR,
        actorId: input.actorId,
      })
      if (!input.conversationId) return { subjectId }
      const scopeSubjectId = await upsert({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId, scopeSubjectId }
    }
    case "conversation": {
      if (!input.conversationId) throw new Error("conversationId required")
      const subjectId = await upsert({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId }
    }
    case "remote_agent": {
      if (!input.remoteAgentId)
        throw new Error("remoteAgentId required for remote_agent target")
      const subjectId = await upsert({
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: input.remoteAgentId,
      })
      if (!input.conversationId) return { subjectId }
      const scopeSubjectId = await upsert({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId, scopeSubjectId }
    }
  }
}

export async function loadRuntimePrincipalContextForCapabilityProjection(params: {
  principal: SubjectRef
  workspaceId: string
  conversationId?: string | null
  db?: CapabilityProjectionRuntimeContextDb
}) {
  return buildRuntimePrincipalContext(params.db ?? db, {
    principal: params.principal,
    workspaceId: params.workspaceId,
    conversationId: params.conversationId ?? null,
  })
}

export interface ReplaceDeviceCapabilityGrantsParams {
  workspaceId: string
  subjectId: string
  scopeSubjectId?: string
  capabilityIds: string[]
  createdByWorkspaceMemberId?: string | null
  reason?: string
}

/**
 * Full-replace transaction body of setActiveDeviceCapabilitiesForTarget: a
 * tuple-precise revoke of the target's active `use` grants followed by the
 * insert of the new grant set. Both statements run inside a single
 * transaction so the replace is atomic.
 */
export async function replaceDeviceCapabilityGrants(
  params: ReplaceDeviceCapabilityGrantsParams,
  run: Executor = db
): Promise<void> {
  await run.transaction().execute(async (trx) => {
    // Tuple-precise revoke: a grant under `actor + scope=conversation A` must
    // not be torn down by an unrelated `actor + scope=conversation B` write,
    // and an unscoped grant must not be torn down by any scoped write.
    let revoke = trx
      .updateTable("workspaceResourceGrants")
      .set({
        status: "revoked",
        revokedAt: new Date(),
      } as never)
      .where("subjectId", "=", params.subjectId)
      .where("workspaceId", "=", params.workspaceId)
      .where(
        sql<boolean>`'use'::workspace_resource_grant_permission = ANY(permissions)`
      )
      .where("status", "=", "active")
    if (params.scopeSubjectId) {
      revoke = revoke.where("scopeSubjectId", "=", params.scopeSubjectId)
    } else {
      revoke = revoke.where("scopeSubjectId", "is", null)
    }
    await revoke.execute()

    if (params.capabilityIds.length === 0) return

    const rows = params.capabilityIds.map((capabilityId) => ({
      workspaceId: params.workspaceId,
      workspaceResourceId: capabilityId,
      subjectId: params.subjectId,
      scopeSubjectId: params.scopeSubjectId ?? null,
      permissions: ["use"],
      status: "active",
      source: "manual",
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
      reason: params.reason ?? null,
    }))

    await trx
      .insertInto("workspaceResourceGrants")
      .values(rows as never)
      .execute()
  })
}

export interface MutateDeviceCapabilityGrantsParams {
  workspaceId: string
  subjectId: string
  scopeSubjectId?: string
  capabilityIds: string[]
  createdByWorkspaceMemberId?: string | null
  reason?: string
}

/**
 * ADDITIVE insert: activate grants for exactly the given capability ids on
 * (subject, scope) via onConflict-doNothing, WITHOUT touching the target's
 * other capability grants. Idempotent per (capability, subject, scope) via
 * the active partial-unique.
 */
export async function insertDeviceCapabilityGrants(
  params: MutateDeviceCapabilityGrantsParams,
  run: Executor = db
): Promise<void> {
  if (params.capabilityIds.length === 0) return
  const rows = params.capabilityIds.map((capabilityId) => ({
    workspaceId: params.workspaceId,
    workspaceResourceId: capabilityId,
    subjectId: params.subjectId,
    scopeSubjectId: params.scopeSubjectId ?? null,
    permissions: ["use"],
    status: "active",
    source: "manual",
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
    reason: params.reason ?? null,
  }))
  await run
    .insertInto("workspaceResourceGrants")
    .values(rows as never)
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/**
 * TARGETED revoke: revoke ONLY the given capability ids' active grants on
 * (subject, scope), leaving the target's other capabilities intact.
 */
export async function revokeDeviceCapabilityGrants(
  params: MutateDeviceCapabilityGrantsParams,
  run: Executor = db
): Promise<void> {
  if (params.capabilityIds.length === 0) return
  let revoke = run
    .updateTable("workspaceResourceGrants")
    .set({
      status: "revoked",
      revokedAt: new Date(),
    } as never)
    .where("subjectId", "=", params.subjectId)
    .where("workspaceId", "=", params.workspaceId)
    .where("status", "=", "active")
    .where("workspaceResourceId", "in", params.capabilityIds)
    .where(
      sql<boolean>`'use'::workspace_resource_grant_permission = ANY(permissions)`
    )
  if (params.scopeSubjectId) {
    revoke = revoke.where("scopeSubjectId", "=", params.scopeSubjectId)
  } else {
    revoke = revoke.where("scopeSubjectId", "is", null)
  }
  await revoke.execute()
}

/**
 * Active `use`-permission device-capability grants for (subject, scope) in a
 * workspace. Returns the filtered workspace_resource_id string[].
 */
export async function selectActiveDeviceCapabilityIdsForSubject(
  workspaceId: string,
  subjectId: string,
  scopeSubjectId: string | undefined,
  run: Executor = db
): Promise<string[]> {
  let query = run
    .selectFrom("workspaceResourceGrants")
    .select("workspaceResourceId")
    .where("workspaceId", "=", workspaceId)
    .where("subjectId", "=", subjectId)
    .where("status", "=", "active")
    .where(
      sql<boolean>`'use'::workspace_resource_grant_permission = ANY(permissions)`
    )
  if (scopeSubjectId) {
    query = query.where("scopeSubjectId", "=", scopeSubjectId)
  } else {
    query = query.where("scopeSubjectId", "is", null)
  }
  const rows = await query.execute()
  return rows
    .map((r) => r.workspaceResourceId as string | null)
    .filter((v): v is string => v !== null)
}
