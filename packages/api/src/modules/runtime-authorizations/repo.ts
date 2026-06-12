// Repo for the runtime-authorizations module: owns the raw DB reads the
// service/controller/request helpers need so those files stay free of the db
// client (guard r8). Repo functions return camelCase DOMAIN records (Kysely's
// CamelCasePlugin already yields camelCase keys; raw `sql` fragments that use
// snake_case aliases are copied verbatim) and KEEP Date objects — time
// serialization belongs to presenters (guard r3).

import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import type { Executor } from "../../infrastructure/database/kysely.js"

/**
 * Device tool runtime target (service id, tool revision, etc.) for a freshly
 * approved runtime authorization. Returns null when any piece is missing —
 * caller falls back to the static approval notice (e.g. the device went
 * offline between request and approval).
 *
 * Soft-delete (§8.6) and active-status WHERE clauses are preserved verbatim:
 * never auto-retry against a soft-closed device's tool or an inactive app.
 */
export interface AutoRetryTarget {
  deviceId: string
  deviceServiceId: string
  deviceExposureId: string
  deviceToolId: string
  deviceToolRevisionId: string
}

export async function findAutoRetryTarget(args: {
  deviceCapabilityId: string
  visibleToolName: string
}): Promise<AutoRetryTarget | null> {
  const row = await db
    .selectFrom("deviceCapabilities as dc")
    .innerJoin("workspaceApps as app", "app.id", "dc.id")
    .innerJoin("deviceExposures as dx", "dx.id", "dc.exposureId")
    .innerJoin("devices as d", "d.id", "dx.deviceId")
    .innerJoin("deviceTools as dt", "dt.exposureId", "dx.id")
    .innerJoin("deviceToolRevisions as dtr", "dtr.id", "dt.latestRevisionId")
    .select([
      "d.id as deviceId",
      "dx.serviceId as deviceServiceId",
      "dx.id as deviceExposureId",
      "dt.id as deviceToolId",
      "dtr.id as deviceToolRevisionId",
    ])
    .where("dc.id", "=", args.deviceCapabilityId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("dt.currentName", "=", args.visibleToolName)
    .where("dt.status", "=", "active")
    // Soft-delete (§8.6): never auto-retry against a soft-closed device's tool.
    .where("d.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    deviceId: row.deviceId as string,
    deviceServiceId: row.deviceServiceId as string,
    deviceExposureId: row.deviceExposureId as string,
    deviceToolId: row.deviceToolId as string,
    deviceToolRevisionId: row.deviceToolRevisionId as string,
  }
}

/**
 * Reverse-lookup of a device capability for the manual-grant validation path:
 * pull device_id / workspace_id / exposure_id / stable_key / builtin_kind /
 * runtime_status / status before the write. WHERE clauses (dc.id match +
 * app.deletedAt is null soft-delete guard) preserved verbatim.
 */
export interface DeviceCapabilityGrantTarget {
  deviceId: string
  workspaceId: string
  exposureId: string
  exposureStableKey: string
  builtinKind: string
  runtimeStatus: string
  status: string
}

export async function findDeviceCapabilityGrantTarget(
  deviceCapabilityId: string,
  executor: Executor = db
): Promise<DeviceCapabilityGrantTarget | undefined> {
  return executor
    .selectFrom("deviceCapabilities as dc")
    .innerJoin("workspaceApps as app", "app.id", "dc.id")
    .innerJoin("deviceExposures as dx", "dx.id", "dc.exposureId")
    .innerJoin("devices as d", "d.id", "dx.deviceId")
    .select([
      "d.id as deviceId",
      "app.workspaceId as workspaceId",
      "dx.id as exposureId",
      "dx.stableKey as exposureStableKey",
      "dx.builtinKind as builtinKind",
      "dx.runtimeStatus as runtimeStatus",
      "app.status as status",
    ])
    .where("dc.id", "=", deviceCapabilityId)
    .where("app.deletedAt", "is", null)
    .executeTakeFirst() as Promise<DeviceCapabilityGrantTarget | undefined>
}

/**
 * Load the conversation kind row used by the request-gating helper. Caller
 * keeps the `fallback?.conversationKind` short-circuit; the repo owns only the
 * query.
 */
export async function loadConversationKindRow(
  conversationId: string
): Promise<{ kind: string } | undefined> {
  return db
    .selectFrom("conversations")
    .select(["kind"])
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst() as Promise<{ kind: string } | undefined>
}

/**
 * Capability/exposure/device reachability state for the request-gating helper.
 * The `hasActiveDeviceSession` field comes from an inline raw `sql<boolean>`
 * EXISTS subquery referencing snake_case columns — that raw fragment is NOT
 * camelCase-rewritten, so it is copied verbatim. WHERE clauses (capability.id
 * match + app.deletedAt is null soft-delete guard) preserved verbatim.
 */
export interface DeviceCapabilityRequestState {
  capabilityId: string
  capabilityStatus: string
  exposureId: string
  exposureRuntimeStatus: string
  ownerWorkspaceId: string
  hasActiveDeviceSession: boolean
}

export async function loadDeviceCapabilityRequestState(
  capabilityId: string
): Promise<DeviceCapabilityRequestState | undefined> {
  return db
    .selectFrom("deviceCapabilities as capability")
    .innerJoin("workspaceApps as app", "app.id", "capability.id")
    .innerJoin(
      "deviceExposures as exposure",
      "exposure.id",
      "capability.exposureId"
    )
    .innerJoin("devices as device", "device.id", "exposure.deviceId")
    .select([
      "capability.id as capabilityId",
      "app.status as capabilityStatus",
      "exposure.id as exposureId",
      "exposure.runtimeStatus as exposureRuntimeStatus",
      "device.workspaceId as ownerWorkspaceId",
      sql<boolean>`EXISTS (
        SELECT 1
        FROM device_control_plane_sessions session_row
        WHERE session_row.device_id = device.id
          AND session_row.status = 'active'
      )`.as("hasActiveDeviceSession"),
    ])
    .where("capability.id", "=", capabilityId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst() as Promise<DeviceCapabilityRequestState | undefined>
}

/**
 * Detect a new user-facing conversation message created after `afterIso`. The
 * caller passes an IsoInstantString (Timestamp); the repo converts it once at
 * the query boundary, matching prior behavior. WHERE/OR clauses preserved
 * verbatim (message item type, role=user OR participant subject kind in
 * [workspace_member, external]).
 */
export async function hasNewUserFacingConversationMessage(
  conversationId: string,
  afterIso: string
): Promise<boolean> {
  const row = await db
    .selectFrom("conversationItems as ci")
    .leftJoin(
      "conversationParticipants as cp",
      "cp.id",
      "ci.authorParticipantId"
    )
    .leftJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .select("ci.id")
    .where("ci.conversationId", "=", conversationId)
    .where("ci.itemType", "=", "message")
    .where("ci.createdAt", ">", new Date(afterIso))
    .where((eb) =>
      eb.or([
        eb("ci.role", "=", "user"),
        eb("cpsubj.kind", "in", ["workspace_member", "external"]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}
