// Sandbox module DB access (repo layer). This file is the single home for the
// sandbox module's raw db-client queries — it is exempt from guard r8/r1/r2/r4
// (basename matches /repo[^/]*\.ts$/), so it MAY import the db client and `sql`.
//
// Repo functions return camelCase DOMAIN records and KEEP Date objects (no
// time-to-ISO serialization here — that belongs to presenters, enforced by
// guard r3). Each function takes an injectable
// `run: Executor = db` so callers can thread a transaction/test handle while
// defaulting to the singleton.

import { db } from "../../infrastructure/database/kysely.js"
import type { Executor } from "../../infrastructure/database/kysely.js"

// Re-export the Executor type so module files (e.g. grants.ts) can accept an
// injectable executor WITHOUT importing the forbidden kysely.js path.
export type { Executor } from "../../infrastructure/database/kysely.js"

// ── docker-sandbox-backend.ts: bootstrap-poll + cleanup ─────────────────────

export interface PairingBootstrapResolution {
  status: string
  deviceId: string | null
}

/** Read the pairing session's bootstrap state (status + claimed device id). */
export async function getPairingSessionBootstrapState(
  pairingSessionId: string,
  run: Executor = db
): Promise<PairingBootstrapResolution | undefined> {
  return run
    .selectFrom("devicePairingSessions")
    .select(["status", "deviceId"])
    .where("id", "=", pairingSessionId)
    .executeTakeFirst()
}

/** Resolve the most-recent device_runtime service id for a bootstrapped device. */
export async function getLatestDeviceRuntimeServiceId(
  deviceId: string,
  run: Executor = db
): Promise<string | undefined> {
  const svc = await run
    .selectFrom("deviceServices")
    .select("id")
    .where("deviceId", "=", deviceId)
    .where("serviceKind", "=", "device_runtime")
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return svc?.id as string | undefined
}

/** Cancel a still-pending device pairing session so its code can't be reused.
 *  No-op if the session already advanced past pending. Best-effort caller. */
export async function cancelPendingPairingSession(
  pairingSessionId: string,
  run: Executor = db
): Promise<void> {
  await run
    .updateTable("devicePairingSessions")
    .set({ status: "cancelled" } as never)
    .where("id", "=", pairingSessionId)
    .where("status", "=", "pending")
    .execute()
}

// ── grants.ts: builtin-exposure resolution + grant revocation ───────────────

export interface DeviceBuiltinExposureRow {
  exposureId: string
  capabilityId: string
  builtinKind: string
}

/** Resolve a device's active filesystem/commandline builtin exposures +
 *  capabilities (joined to its workspace apps, soft-delete + active filtered).
 *  Returns raw rows; the domain shaper (resolveDeviceBuiltinIds) folds them. */
export async function selectDeviceBuiltinExposures(
  deviceId: string,
  run: Executor = db
): Promise<DeviceBuiltinExposureRow[]> {
  return run
    .selectFrom("deviceExposures as e")
    .innerJoin("deviceCapabilities as c", "c.exposureId", "e.id")
    .innerJoin("workspaceApps as app", "app.id", "c.id")
    .select(["e.id as exposureId", "c.id as capabilityId", "e.builtinKind"])
    .where("e.deviceId", "=", deviceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("e.builtinKind", "in", ["filesystem", "commandline"])
    .execute() as Promise<DeviceBuiltinExposureRow[]>
}

/** Resolve THIS device's capability ids within a workspace (capability rows
 *  whose exposure belongs to the device). */
export async function selectDeviceCapabilityIds(
  params: { workspaceId: string; deviceId: string },
  run: Executor = db
): Promise<string[]> {
  const rows = await run
    .selectFrom("deviceCapabilities as capability")
    .innerJoin("workspaceApps as app", "app.id", "capability.id")
    .select("capability.id")
    .where("app.workspaceId", "=", params.workspaceId)
    .where(
      "capability.exposureId",
      "in",
      run
        .selectFrom("deviceExposures")
        .select("id")
        .where("deviceId", "=", params.deviceId)
    )
    .execute()
  return rows.map((r) => r.id as string)
}

/** Revoke all ACTIVE runtime-authorization grants for a device in a workspace. */
export async function revokeActiveDeviceRuntimeGrants(
  params: { workspaceId: string; deviceId: string },
  run: Executor = db
): Promise<void> {
  await run
    .updateTable("runtimeAuthorizationGrants")
    .set({
      status: "revoked",
      revokedAt: new Date(),
    } as never)
    .where("deviceId", "=", params.deviceId)
    .where("workspaceId", "=", params.workspaceId)
    .where("status", "=", "active")
    .execute()
}
