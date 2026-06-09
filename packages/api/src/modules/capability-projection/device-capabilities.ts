// Device capability aggregator for capability-projection. Loads device-side
// tools that an actor / conversation has access to via workspace_app_grants
// (subject_id → access_subjects → workspace_app_id=device_capability id).
//
// v3.0 ships the read path; PR #8 wires the write path UI for group chat.

import { sql } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"

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

export async function loadDeviceCapabilityToolsForSubjects(
  params: LoadDeviceToolsParams
): Promise<DeviceCapabilityToolRow[]> {
  if (params.subjectIds.length === 0) return []
  // distinctOn collapses duplicate rows when multiple subject bindings cover
  // the same capability (e.g. workspace-scope + actor-scope both grant the
  // bash tool — without distinctOn the projection surfaces it twice and the
  // planner sees duplicate names).
  let query = db
    .selectFrom("device_capabilities as dc")
    .innerJoin("workspace_apps as app", "app.id", "dc.id")
    .innerJoin("workspace_app_grants as rab", (join) =>
      join
        .onRef("rab.workspace_app_id", "=", "dc.id")
        .on("rab.status", "=", "active")
    )
    .innerJoin("device_exposures as dx", "dx.id", "dc.exposure_id")
    .innerJoin("devices as d", "d.id", "dx.device_id")
    .innerJoin("device_tools as dt", "dt.exposure_id", "dx.id")
    .innerJoin(
      "device_tool_revisions as dtr",
      "dtr.id",
      "dt.latest_revision_id"
    )
    .innerJoin(
      "device_catalog_revisions as dcr",
      "dcr.id",
      "dtr.catalog_revision_id"
    )
    .distinctOn(["dt.id"])
    .select([
      "d.id as device_id",
      "d.title as device_name",
      "dx.service_id as device_service_id",
      "dx.id as device_exposure_id",
      "dc.id as device_capability_id",
      "dt.id as device_tool_id",
      "dtr.id as device_tool_revision_id",
      "dcr.id as catalog_revision_id",
      "dx.transport as transport",
      "dx.builtin_kind as builtin_kind",
      "dx.stable_key as exposure_stable_key",
      "dx.metadata as exposure_metadata",
      "dt.current_name as visible_tool_name",
      "dtr.description as visible_description",
      "dtr.input_schema as input_schema",
      "app.conversation_type_mask_override as capability_conversation_type_mask_override",
      "d.conversation_type_mask_override as device_conversation_type_mask_override",
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
    .where("app.workspace_id", "=", params.workspaceId)
    .where("app.deleted_at", "is", null)
    // Soft-delete (§8.6): a soft-closed sandbox device keeps its child rows for
    // audit, but its tools must NOT be projected/resolved. Filter on device
    // liveness here (the projection joins device_* child tables directly rather
    // than through devices_live).
    .where("d.deleted_at", "is", null)
    .where("app.status", "=", "active")
    .where("dt.status", "=", "active")
    .where("dcr.status", "=", "active")
    .where("dx.runtime_status", "in", ["healthy", "degraded"])
    .where("rab.subject_id", "in", params.subjectIds)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(rab.permissions)`
    )
  if (params.runtimeScopeSubjectIds.length > 0) {
    query = query.where((eb) =>
      eb.or([
        eb("rab.scope_subject_id", "is", null),
        eb("rab.scope_subject_id", "in", params.runtimeScopeSubjectIds),
      ])
    )
  } else {
    // No scope context — only unscoped bindings apply.
    query = query.where("rab.scope_subject_id", "is", null)
  }
  const rows = await query.orderBy("dt.id").execute()
  return rows as unknown as DeviceCapabilityToolRow[]
}

export interface AccessTargetInput {
  kind: "workspace" | "actor" | "conversation" | "remote_agent"
  workspaceId?: string
  actorId?: string
  conversationId?: string
  remoteAgentId?: string
}

/**
 * Resolve an AccessTarget DTO into an access_subjects row id pair:
 * `(subjectId, scopeSubjectId?)`. Scope is populated when actor or
 * remote_agent targets carry a conversationId.
 *
 * Tests may inject a Kysely handle (e.g. the ephemeral DB returned by
 * `withTestDb`) so the underlying `upsertAccessSubject` writes against
 * the test connection rather than the production pool.
 */
export async function resolveScopedSubjectTarget(
  input: AccessTargetInput,
  options?: { db?: typeof db }
): Promise<{ subjectId: string; scopeSubjectId?: string }> {
  const dbHandle = options?.db ?? db
  switch (input.kind) {
    case "workspace": {
      if (!input.workspaceId) throw new Error("workspaceId required")
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: input.workspaceId,
      })
      return { subjectId }
    }
    case "actor": {
      if (!input.actorId) throw new Error("actorId required")
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: input.actorId,
      })
      if (!input.conversationId) return { subjectId }
      const scopeSubjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId, scopeSubjectId }
    }
    case "conversation": {
      if (!input.conversationId) throw new Error("conversationId required")
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId }
    }
    case "remote_agent": {
      if (!input.remoteAgentId)
        throw new Error("remoteAgentId required for remote_agent target")
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: input.remoteAgentId,
      })
      if (!input.conversationId) return { subjectId }
      const scopeSubjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId, scopeSubjectId }
    }
  }
}

/**
 * @deprecated Use `resolveScopedSubjectTarget` so callers can write
 * `scope_subject_id` properly. Returning just the subject_id silently drops
 * the scope dimension.
 */
export async function resolveAccessTargetSubjectId(
  input: AccessTargetInput
): Promise<string> {
  const resolved = await resolveScopedSubjectTarget(input)
  return resolved.subjectId
}

export interface SetActiveDeviceCapabilitiesParams {
  workspaceId: string
  target: AccessTargetInput
  deviceCapabilityIds: string[]
  createdByWorkspaceMemberId?: string | null
  reason?: string
}

export async function setActiveDeviceCapabilitiesForTarget(
  params: SetActiveDeviceCapabilitiesParams
): Promise<void> {
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target
  )
  await db.transaction().execute(async (trx) => {
    // Tuple-precise revoke: a binding under `actor + scope=conversation A` must
    // not be torn down by an unrelated `actor + scope=conversation B` write,
    // and an unscoped binding must not be torn down by any scoped write.
    let revoke = trx
      .updateTable("workspace_app_grants")
      .set({
        status: "revoked",
        revoked_at: new Date(),
      } as never)
      .where("subject_id", "=", subjectId)
      .where("workspace_id", "=", params.workspaceId)
      .where(
        sql<boolean>`'use'::workspace_app_grant_permission = ANY(permissions)`
      )
      .where("status", "=", "active")
    if (scopeSubjectId) {
      revoke = revoke.where("scope_subject_id", "=", scopeSubjectId)
    } else {
      revoke = revoke.where("scope_subject_id", "is", null)
    }
    await revoke.execute()

    if (params.deviceCapabilityIds.length === 0) return

    const rows = params.deviceCapabilityIds.map((capabilityId) => ({
      workspace_id: params.workspaceId,
      workspace_app_id: capabilityId,
      subject_id: subjectId,
      scope_subject_id: scopeSubjectId ?? null,
      permissions: ["use"],
      status: "active",
      source: "manual",
      created_by_workspace_member_id: params.createdByWorkspaceMemberId ?? null,
      reason: params.reason ?? null,
    }))

    await trx
      .insertInto("workspace_app_grants")
      .values(rows as never)
      .execute()
  })
}

export async function listActiveDeviceCapabilitiesForTarget(params: {
  workspaceId: string
  target: AccessTargetInput
}): Promise<string[]> {
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target
  )
  let query = db
    .selectFrom("workspace_app_grants")
    .select("workspace_app_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("subject_id", "=", subjectId)
    .where("status", "=", "active")
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(permissions)`
    )
  if (scopeSubjectId) {
    query = query.where("scope_subject_id", "=", scopeSubjectId)
  } else {
    query = query.where("scope_subject_id", "is", null)
  }
  const rows = await query.execute()
  return rows
    .map((r) => r.workspace_app_id as string | null)
    .filter((v): v is string => v !== null)
}

/**
 * ADDITIVE capability grant: activate bindings for exactly the given capability
 * ids on (subject, scope), WITHOUT touching the target's other capability
 * bindings. Unlike setActiveDeviceCapabilitiesForTarget (a full replace), this
 * is safe when several independent grantors (e.g. a sandbox provision + a
 * manually-granted device capability) coexist on the same actor/conversation.
 * Idempotent per (capability, subject, scope) via the active partial-unique.
 */
export async function addDeviceCapabilitiesForTarget(
  params: SetActiveDeviceCapabilitiesParams,
  options?: { db?: typeof db }
): Promise<void> {
  if (params.deviceCapabilityIds.length === 0) return
  const dbHandle = options?.db ?? db
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target,
    { db: dbHandle }
  )
  const rows = params.deviceCapabilityIds.map((capabilityId) => ({
    workspace_id: params.workspaceId,
    workspace_app_id: capabilityId,
    subject_id: subjectId,
    scope_subject_id: scopeSubjectId ?? null,
    permissions: ["use"],
    status: "active",
    source: "manual",
    created_by_workspace_member_id: params.createdByWorkspaceMemberId ?? null,
    reason: params.reason ?? null,
  }))
  await dbHandle
    .insertInto("workspace_app_grants")
    .values(rows as never)
    .onConflict((oc) => oc.doNothing())
    .execute()
}

/**
 * TARGETED capability revoke: revoke ONLY the given capability ids' active
 * bindings on (subject, scope), leaving the target's other capabilities intact.
 * The inverse of addDeviceCapabilitiesForTarget — used at sandbox teardown so we
 * don't clobber an unrelated manual grant on the same actor/conversation.
 */
export async function revokeDeviceCapabilitiesForTarget(
  params: SetActiveDeviceCapabilitiesParams,
  options?: { db?: typeof db }
): Promise<void> {
  if (params.deviceCapabilityIds.length === 0) return
  const dbHandle = options?.db ?? db
  const { subjectId, scopeSubjectId } = await resolveScopedSubjectTarget(
    params.target,
    { db: dbHandle }
  )
  let revoke = dbHandle
    .updateTable("workspace_app_grants")
    .set({
      status: "revoked",
      revoked_at: new Date(),
    } as never)
    .where("subject_id", "=", subjectId)
    .where("workspace_id", "=", params.workspaceId)
    .where("status", "=", "active")
    .where("workspace_app_id", "in", params.deviceCapabilityIds)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(permissions)`
    )
  if (scopeSubjectId) {
    revoke = revoke.where("scope_subject_id", "=", scopeSubjectId)
  } else {
    revoke = revoke.where("scope_subject_id", "is", null)
  }
  await revoke.execute()
}

void sql
