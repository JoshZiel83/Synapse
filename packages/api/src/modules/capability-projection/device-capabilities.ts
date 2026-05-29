// Device capability aggregator for capability-projection. Loads device-side
// tools that an actor / conversation has access to via resource_access_bindings
// (subject_id → access_subjects → resource_type='device_capability').
//
// v3.0 ships the read path; PR #8 wires the write path UI for group chat.

import { sql } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { ensureConversationActorContext } from "../session/service.js"

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
    .innerJoin("resource_access_bindings as rab", (join) =>
      join
        .onRef("rab.device_capability_id", "=", "dc.id")
        .on("rab.resource_type", "=", "device_capability")
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
      "dt.current_name as visible_tool_name",
      "dtr.description as visible_description",
      "dtr.input_schema as input_schema",
      "dc.conversation_type_mask_override as capability_conversation_type_mask_override",
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
    .where("dc.workspace_id", "=", params.workspaceId)
    .where("dc.status", "=", "active")
    .where("dt.status", "=", "active")
    .where("dcr.status", "=", "active")
    .where("dx.runtime_status", "in", ["healthy", "degraded"])
    .where("rab.subject_id", "in", params.subjectIds)
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
  kind:
    | "workspace"
    | "actor"
    | "conversation"
    | "actor_in_conversation"
    | "remote_agent"
    | "remote_agent_in_conversation"
  workspaceId?: string
  actorId?: string
  conversationId?: string
  remoteAgentId?: string
}

/**
 * Resolve an AccessTarget DTO into an access_subjects row id pair:
 * `(subjectId, scopeSubjectId?)`. Scope is populated for the two
 * `*_in_conversation` flat-shape variants — `actor_in_conversation`
 * and `remote_agent_in_conversation` — which are the internal
 * representations of the wire-layer `(subject=actor|remote_agent,
 * scope=conversation)` combinations whitelisted by
 * `ScopedSubjectTargetWireSchema.superRefine`. All other variants
 * return `scopeSubjectId === undefined`.
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
      return { subjectId }
    }
    case "conversation": {
      if (!input.conversationId) throw new Error("conversationId required")
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId }
    }
    case "actor_in_conversation": {
      // D3: collapse into actor subject + conversation scope. No CAC subject.
      if (!input.actorId || !input.conversationId)
        throw new Error(
          "actorId and conversationId required for actor_in_conversation target"
        )
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: input.actorId,
      })
      const scopeSubjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
      return { subjectId, scopeSubjectId }
    }
    case "remote_agent": {
      if (!input.remoteAgentId)
        throw new Error("remoteAgentId required for remote_agent target")
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: input.remoteAgentId,
      })
      return { subjectId }
    }
    case "remote_agent_in_conversation": {
      // Mirror of `actor_in_conversation`: remote_agent subject narrowed
      // to a conversation scope. The wire layer admits this combination
      // (ScopedSubjectTargetWireSchema's superRefine whitelist) and the
      // trigger `tg_runtime_authorization_grant_validate` accepts
      // `(remote_agent, conversation)` for grants; bindings flow through
      // the same `tg_rab_validate` trigger.
      if (!input.remoteAgentId || !input.conversationId)
        throw new Error(
          "remoteAgentId and conversationId required for remote_agent_in_conversation target"
        )
      const subjectId = await upsertAccessSubject(dbHandle, {
        kind: SUBJECT_KIND.REMOTE_AGENT,
        remoteAgentId: input.remoteAgentId,
      })
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
      .updateTable("resource_access_bindings")
      .set({
        status: "revoked",
        revoked_at: new Date().toISOString(),
      } as never)
      .where("subject_id", "=", subjectId)
      .where("workspace_id", "=", params.workspaceId)
      .where("resource_type", "=", "device_capability")
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
      resource_type: "device_capability",
      device_capability_id: capabilityId,
      subject_id: subjectId,
      scope_subject_id: scopeSubjectId ?? null,
      status: "active",
      source: "manual",
      created_by_workspace_member_id: params.createdByWorkspaceMemberId ?? null,
      reason: params.reason ?? null,
    }))

    await trx
      .insertInto("resource_access_bindings")
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
    .selectFrom("resource_access_bindings")
    .select("device_capability_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("resource_type", "=", "device_capability")
    .where("subject_id", "=", subjectId)
    .where("status", "=", "active")
  if (scopeSubjectId) {
    query = query.where("scope_subject_id", "=", scopeSubjectId)
  } else {
    query = query.where("scope_subject_id", "is", null)
  }
  const rows = await query.execute()
  return rows
    .map((r) => r.device_capability_id as string | null)
    .filter((v): v is string => v !== null)
}

void sql
