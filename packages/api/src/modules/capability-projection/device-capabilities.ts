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
}

export interface LoadDeviceToolsParams {
  workspaceId: string
  /** subject_ids whose bindings should count. */
  subjectIds: string[]
}

export async function loadDeviceCapabilityToolsForSubjects(
  params: LoadDeviceToolsParams
): Promise<DeviceCapabilityToolRow[]> {
  if (params.subjectIds.length === 0) return []
  const rows = await db
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
    ])
    .where("dc.workspace_id", "=", params.workspaceId)
    .where("dc.status", "=", "active")
    .where("dt.status", "=", "active")
    .where("dcr.status", "=", "active")
    .where("dx.runtime_status", "in", ["healthy", "degraded"])
    .where("rab.subject_id", "in", params.subjectIds)
    .execute()
  return rows as unknown as DeviceCapabilityToolRow[]
}

export interface AccessTargetInput {
  kind: "workspace" | "actor" | "conversation" | "actor_in_conversation"
  workspaceId?: string
  actorId?: string
  conversationId?: string
}

/**
 * Resolve an AccessTarget DTO into an access_subjects row id by calling
 * upsertAccessSubject. The trx-aware ensureConversationActorContext flow
 * lives in access-target-resolver.ts; PR #8 wires that for group chat. This
 * helper is the SDK→subject_id bridge used by setActiveDeviceCapabilities.
 */
export async function resolveAccessTargetSubjectId(
  input: AccessTargetInput
): Promise<string> {
  switch (input.kind) {
    case "workspace": {
      if (!input.workspaceId) throw new Error("workspaceId required")
      return upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: input.workspaceId,
      })
    }
    case "actor": {
      if (!input.actorId) throw new Error("actorId required")
      return upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: input.actorId,
      })
    }
    case "conversation": {
      if (!input.conversationId) throw new Error("conversationId required")
      return upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      })
    }
    case "actor_in_conversation": {
      if (!input.actorId || !input.conversationId)
        throw new Error(
          "actorId and conversationId required for actor_in_conversation target"
        )
      const context = await ensureConversationActorContext({
        actorId: input.actorId,
        conversationId: input.conversationId,
      })
      return upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT,
        contextId: context.conversationActorContextId,
      })
    }
  }
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
  const subjectId = await resolveAccessTargetSubjectId(params.target)
  await db.transaction().execute(async (trx) => {
    // Revoke existing active bindings for this (subject, workspace) that are
    // device_capability-typed.
    await trx
      .updateTable("resource_access_bindings")
      .set({
        status: "revoked",
        revoked_at: new Date().toISOString(),
      } as never)
      .where("subject_id", "=", subjectId)
      .where("workspace_id", "=", params.workspaceId)
      .where("resource_type", "=", "device_capability")
      .where("status", "=", "active")
      .execute()

    if (params.deviceCapabilityIds.length === 0) return

    const rows = params.deviceCapabilityIds.map((capabilityId) => ({
      workspace_id: params.workspaceId,
      resource_type: "device_capability",
      device_capability_id: capabilityId,
      subject_id: subjectId,
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
  const subjectId = await resolveAccessTargetSubjectId(params.target)
  const rows = await db
    .selectFrom("resource_access_bindings")
    .select("device_capability_id")
    .where("workspace_id", "=", params.workspaceId)
    .where("resource_type", "=", "device_capability")
    .where("subject_id", "=", subjectId)
    .where("status", "=", "active")
    .execute()
  return rows
    .map((r) => r.device_capability_id as string | null)
    .filter((v): v is string => v !== null)
}

void sql
