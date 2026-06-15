// capability-projection/repo.ts — DB-touching helpers for device capability
// projection (the device-side read/write path of capability-projection).
//
// The only file in this module's device-capabilities boundary permitted to
// import the db client (guard r8). Owns the workspace_app_grants reads/writes
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
  device_id: string
  device_name: string
  device_service_id: string
  device_exposure_id: string
  device_capability_id: string
  device_tool_id: string
  device_tool_revision_id: string
  catalog_revision_id: string
  transport: "builtin" | "stdio" | "http" | "sse" | "custom"
  builtin_kind: "filesystem" | "commandline" | "browser" | "cua" | null
  visible_tool_name: string
  visible_description: string
  input_schema: unknown
  /** Per-capability mask override (NULL → fall back to workspace policy). */
  capability_conversation_type_mask_override: number | null
  /** Per-device mask override. */
  device_conversation_type_mask_override: number | null
  /**
   * v3.1: exposure.stable_key (e.g. "builtin/browser/navigation") + the
   * provider-emitted metadata object. Used by browser preflight to detect
   * disabled exposures and to attach disabledReason to user-facing errors.
   */
  exposure_stable_key: string
  exposure_metadata: Record<string, unknown> | null
  /**
   * Raw devices.platform string ("win32", "darwin", "linux", or other).
   * Caller (capability-projection dispatch) passes this through
   * normalizeDevicePlatform before forwarding to the commandline matcher,
   * which uses it to apply Windows-specific guards (cwd unsupported in v1).
   */
  device_platform: string | null
  /** Raw devices.arch string (e.g. "x64", "arm64"). Combined with
   *  platform forms the bundles manifest's platformKey. */
  device_arch: string | null
}

export interface LoadDeviceToolsParams {
  workspaceId: string
  /** subject_ids whose bindings should count. */
  subjectIds: string[]
  /**
   * subject-scope-refactor: the set of scope subject_ids that may pin a
   * binding. A RAB row with `scope_subject_id = NULL` applies whenever the
   * subject matches; a row with non-NULL scope only applies when the scope
   * subject_id is present in this set. Without this filter,
   * `actor + scope=conversation` bindings leak to the same actor's other
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
 * the module's stable snake_case-aliased domain rows (the query aliases
 * columns to snake_case explicitly, so these are NOT raw CamelCasePlugin
 * TableRows). Keeps the exposure_metadata normalization map.
 */
export async function selectDeviceCapabilityToolsForSubjects(
  params: LoadDeviceToolsParams,
  run: Executor = db
): Promise<DeviceCapabilityToolRow[]> {
  if (params.subjectIds.length === 0) return []
  // distinctOn collapses duplicate rows when multiple subject bindings cover
  // the same capability (e.g. workspace-scope + actor-scope both grant the
  // bash tool — without distinctOn the projection surfaces it twice and the
  // planner sees duplicate names).
  let query = run
    .selectFrom("deviceCapabilities as dc")
    .innerJoin("workspaceApps as app", "app.id", "dc.id")
    .innerJoin("workspaceAppGrants as rab", (join) =>
      join
        .onRef("rab.workspaceAppId", "=", "dc.id")
        .on("rab.status", "=", "active")
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
      "d.id as device_id",
      "d.title as device_name",
      "dx.serviceId as device_service_id",
      "dx.id as device_exposure_id",
      "dc.id as device_capability_id",
      "dt.id as device_tool_id",
      "dtr.id as device_tool_revision_id",
      "dcr.id as catalog_revision_id",
      "dx.transport as transport",
      "dx.builtinKind as builtin_kind",
      "dx.stableKey as exposure_stable_key",
      "dx.metadata as exposure_metadata",
      "dt.currentName as visible_tool_name",
      "dtr.description as visible_description",
      "dtr.inputSchema as input_schema",
      "app.conversationTypeMaskOverride as capability_conversation_type_mask_override",
      "d.conversationTypeMaskOverride as device_conversation_type_mask_override",
      // Commit 8: surface device.platform so the commandline matcher can
      // apply Windows-specific guards (cwd unsupported in v1) at projection
      // time instead of relying solely on device-side bottom-of-stack
      // rejection. normalizeDevicePlatform turns the raw DB string into
      // "win32" | "linux" | "darwin" | undefined.
      "d.platform as device_platform",
      // Surface arch alongside platform so isBundleAvailableForPlatform can
      // exact-match against the runtime manifest's platformKey
      // (`<platform>-<arch>`). Without arch the API would have to assume
      // the device's arch matches an entry, which previously caused
      // "approved-but-unrunnable" for arm-only or x64-only manifests.
      "d.arch as device_arch",
    ])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    // Soft-delete (§8.6): a soft-closed sandbox device keeps its child rows for
    // audit, but its tools must NOT be projected/resolved. Filter on device
    // liveness here (the projection joins device_* child tables directly rather
    // than through devices_live).
    .where("d.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("dt.status", "=", "active")
    .where("dcr.status", "=", "active")
    .where("dx.runtimeStatus", "in", ["healthy", "degraded"])
    .where("rab.subjectId", "in", params.subjectIds)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(rab.permissions)`
    )
  if (params.runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("rab.scopeSubjectId", "is", null),
        eb("rab.scopeSubjectId", "in", params.runtimeScopeSubjectIds),
      ])
    )
  } else {
    // No scope context — only unscoped bindings apply.
    query = query.where("rab.scopeSubjectId", "is", null)
  }
  const rows = await query.orderBy("dt.id").execute()
  return rows.map((row) => ({
    ...row,
    exposure_metadata:
      row.exposure_metadata &&
      typeof row.exposure_metadata === "object" &&
      !Array.isArray(row.exposure_metadata)
        ? (row.exposure_metadata as Record<string, unknown>)
        : null,
  }))
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
    // Tuple-precise revoke: a binding under `actor + scope=conversation A` must
    // not be torn down by an unrelated `actor + scope=conversation B` write,
    // and an unscoped binding must not be torn down by any scoped write.
    let revoke = trx
      .updateTable("workspaceAppGrants")
      .set({
        status: "revoked",
        revokedAt: new Date(),
      } as never)
      .where("subjectId", "=", params.subjectId)
      .where("workspaceId", "=", params.workspaceId)
      .where(
        sql<boolean>`'use'::workspace_app_grant_permission = ANY(permissions)`
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
      workspaceAppId: capabilityId,
      subjectId: params.subjectId,
      scopeSubjectId: params.scopeSubjectId ?? null,
      permissions: ["use"],
      status: "active",
      source: "manual",
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
      reason: params.reason ?? null,
    }))

    await trx
      .insertInto("workspaceAppGrants")
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
 * ADDITIVE insert: activate bindings for exactly the given capability ids on
 * (subject, scope) via onConflict-doNothing, WITHOUT touching the target's
 * other capability bindings. Idempotent per (capability, subject, scope) via
 * the active partial-unique.
 */
export async function insertDeviceCapabilityGrants(
  params: MutateDeviceCapabilityGrantsParams,
  run: Executor = db
): Promise<void> {
  if (params.capabilityIds.length === 0) return
  const rows = params.capabilityIds.map((capabilityId) => ({
    workspaceId: params.workspaceId,
    workspaceAppId: capabilityId,
    subjectId: params.subjectId,
    scopeSubjectId: params.scopeSubjectId ?? null,
    permissions: ["use"],
    status: "active",
    source: "manual",
    createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
    reason: params.reason ?? null,
  }))
  await run
    .insertInto("workspaceAppGrants")
    .values(rows as never)
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/**
 * TARGETED revoke: revoke ONLY the given capability ids' active bindings on
 * (subject, scope), leaving the target's other capabilities intact.
 */
export async function revokeDeviceCapabilityGrants(
  params: MutateDeviceCapabilityGrantsParams,
  run: Executor = db
): Promise<void> {
  if (params.capabilityIds.length === 0) return
  let revoke = run
    .updateTable("workspaceAppGrants")
    .set({
      status: "revoked",
      revokedAt: new Date(),
    } as never)
    .where("subjectId", "=", params.subjectId)
    .where("workspaceId", "=", params.workspaceId)
    .where("status", "=", "active")
    .where("workspaceAppId", "in", params.capabilityIds)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(permissions)`
    )
  if (params.scopeSubjectId) {
    revoke = revoke.where("scopeSubjectId", "=", params.scopeSubjectId)
  } else {
    revoke = revoke.where("scopeSubjectId", "is", null)
  }
  await revoke.execute()
}

/**
 * Active `use`-permission device-capability bindings for (subject, scope) in a
 * workspace. Returns the filtered workspace_app_id string[].
 */
export async function selectActiveDeviceCapabilityIdsForSubject(
  workspaceId: string,
  subjectId: string,
  scopeSubjectId: string | undefined,
  run: Executor = db
): Promise<string[]> {
  let query = run
    .selectFrom("workspaceAppGrants")
    .select("workspaceAppId")
    .where("workspaceId", "=", workspaceId)
    .where("subjectId", "=", subjectId)
    .where("status", "=", "active")
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(permissions)`
    )
  if (scopeSubjectId) {
    query = query.where("scopeSubjectId", "=", scopeSubjectId)
  } else {
    query = query.where("scopeSubjectId", "is", null)
  }
  const rows = await query.execute()
  return rows
    .map((r) => r.workspaceAppId as string | null)
    .filter((v): v is string => v !== null)
}
