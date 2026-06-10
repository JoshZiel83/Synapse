// Catalog persistence helper. Called from control-plane.ts when a device
// sends `device.catalog.sync` over the WSS Control Plane (§7.1). Closes the
// loop between what the runtime advertises and what capability-projection
// reads from `device_exposures` / `device_capabilities` / `device_tools` /
// `device_tool_revisions` / `device_catalog_revisions`.
//
// Idempotency contract:
//  - For each incoming exposure: upsert by (device_id, stable_key) and bump
//    runtime_status + last_seen_at. Create the matching device_capabilities
//    row if missing (workspace_id from devices.workspace_id).
//  - Compute a stable schema_hash from the exposure's tool set. If it has
//    moved since the last device_catalog_revisions row for this exposure,
//    create a new revision (revision_seq = max+1) and mark the previous one
//    superseded.
//  - For each tool: upsert device_tools by (exposure_id, stable_key) and
//    insert a device_tool_revisions row tied to the current revision; bump
//    device_tools.latest_revision_id.

import { createHash } from "node:crypto"
import { sql, type Transaction } from "kysely"
import type {
  DeviceCatalogExposure,
  DeviceCatalogTool,
} from "@synapse/device-protocol"
import { db } from "../../infrastructure/database/kysely.js"
import type { DB } from "../../infrastructure/database/generated/db.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/root-storage.js"

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
  trx: Transaction<DB>,
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
  trx: Transaction<DB>,
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
  trx: Transaction<DB>,
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
  trx: Transaction<DB>,
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
