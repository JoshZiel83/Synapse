// Cloud device bootstrap path (§8.2). v3.0 ships the server-side handler
// shape; e2b provisioning is delegated to a pluggable HostProvider so the
// API doesn't take a hard dep on @e2b/sdk in the skeleton.

import { createHash, randomUUID } from "node:crypto"
import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import { DeviceModuleError } from "./service.js"

export interface CreateCloudDeviceInput {
  workspaceId: string
  title: string
  requestedByWorkspaceMemberId?: string | null
  preset?: string
  hostProvider?: string // 'e2b' in v3.0
}

export interface CreateCloudDeviceResult {
  pending_device_id: string
  bootstrap_token: string
  pairing_session_id: string
  expires_at: string
}

/**
 * Allocate a pending device id + one-time bootstrap_token, persist them in a
 * cloud_bootstrap pairing session, and return the token for the caller (the
 * API server) to inject into the sandbox env. The `devices` row is NOT
 * created here — see consumeCloudBootstrap below — because
 * devices.public_key is NOT NULL (§6 Notes: pending_device_id stored in
 * context, never in the FK column).
 */
export async function createCloudDevicePairing(
  input: CreateCloudDeviceInput
): Promise<CreateCloudDeviceResult> {
  const pendingDeviceId = randomUUID()
  const bootstrapToken =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
  const bootstrapTokenHash = createHash("sha256")
    .update(bootstrapToken)
    .digest()
  const sessionId = randomUUID()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString()

  await db
    .insertInto("device_pairing_sessions")
    .values({
      id: sessionId,
      workspace_id: input.workspaceId,
      requested_by_workspace_member_id:
        input.requestedByWorkspaceMemberId ?? null,
      device_id: null,
      mode: "cloud_bootstrap",
      server_base_url: "",
      requested_title: input.title,
      bootstrap_token_hash: bootstrapTokenHash,
      pairing_code: null,
      expires_at: expiresAt,
      status: "pending",
      context: sql`${JSON.stringify({
        pending_device_id: pendingDeviceId,
        preset: input.preset ?? null,
        host_provider: input.hostProvider ?? "e2b",
      })}::jsonb`,
    } as never)
    .execute()

  return {
    pending_device_id: pendingDeviceId,
    bootstrap_token: bootstrapToken,
    pairing_session_id: sessionId,
    expires_at: expiresAt,
  }
}

export interface ConsumeBootstrapInput {
  bootstrapToken: string
  devicePubkey: string
  servicePubkey: string
  clientVersion?: string
  hostProvider?: string
  platform?: string
  arch?: string
}

export interface ConsumeBootstrapResult {
  device_id: string
  service_id: string
  service_key_id: string
  control_plane_url: string
}

/**
 * Sandbox boot handler. Resolves the bootstrap_token (hashed) to its
 * pairing session, atomically INSERTs devices (using context.pending_device_id
 * as the id) + device_services + device_service_keys, and marks the session
 * consumed.
 */
export async function consumeCloudBootstrap(
  input: ConsumeBootstrapInput,
  opts: { controlPlaneUrl: string }
): Promise<ConsumeBootstrapResult> {
  const tokenHash = createHash("sha256").update(input.bootstrapToken).digest()
  return db.transaction().execute(async (trx) => {
    // Atomic single-shot consume: flip status to "consumed" only if the
    // session is still pending + matching mode + not expired. Two concurrent
    // sandbox boots can no longer both succeed and double-insert a device.
    const claimedRows = await trx
      .updateTable("device_pairing_sessions")
      .set({
        status: "consumed",
        confirmed_at: sql`NOW()`,
        consumed_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      } as never)
      .where("bootstrap_token_hash", "=", tokenHash)
      .where("status", "=", "pending")
      .where("mode", "=", "cloud_bootstrap")
      .where("expires_at", ">", sql<Date>`NOW()`)
      .returningAll()
      .execute()
    const session = claimedRows[0]
    if (!session) {
      // Diagnose which precondition failed for a sharper error code.
      const existing = await trx
        .selectFrom("device_pairing_sessions")
        .selectAll()
        .where("bootstrap_token_hash", "=", tokenHash)
        .where("mode", "=", "cloud_bootstrap")
        .executeTakeFirst()
      if (!existing) {
        throw new DeviceModuleError({
          statusCode: 404,
          code: "bootstrap_token_not_found",
          message: "bootstrap token not recognised",
        })
      }
      if ((existing.status as string) !== "pending") {
        throw new DeviceModuleError({
          statusCode: 409,
          code: "pairing_session_not_pending",
          message: `pairing session is ${existing.status as string}`,
        })
      }
      const existingExpiresAt = new Date(
        existing.expires_at as unknown as string
      ).getTime()
      if (
        Number.isFinite(existingExpiresAt) &&
        existingExpiresAt < Date.now()
      ) {
        throw new DeviceModuleError({
          statusCode: 410,
          code: "pairing_session_expired",
          message: "bootstrap window expired",
        })
      }
      throw new DeviceModuleError({
        statusCode: 409,
        code: "pairing_session_race",
        message:
          "bootstrap session was claimed by another consumer; retry not allowed",
      })
    }

    const context = (session.context ?? {}) as Record<string, unknown>
    const pendingDeviceId = context["pending_device_id"] as string | undefined
    if (!pendingDeviceId) {
      throw new DeviceModuleError({
        statusCode: 500,
        code: "pairing_session_corrupt",
        message: "pairing session is missing pending_device_id",
      })
    }
    const hostProvider =
      (context["host_provider"] as string | undefined) ?? "e2b"

    const pubkeyFingerprint = createHash("sha256")
      .update(input.devicePubkey)
      .digest("hex")
    const serviceFingerprint = createHash("sha256")
      .update(input.servicePubkey)
      .digest("hex")

    await trx
      .insertInto("devices")
      .values({
        id: pendingDeviceId,
        workspace_id: session.workspace_id as string,
        owner_workspace_member_id:
          session.requested_by_workspace_member_id ?? null,
        title: (session.requested_title as string | null) ?? "Cloud Device",
        description: null,
        host_kind: "cloud",
        host_provider: hostProvider,
        device_type: "cloud_sandbox",
        platform: input.platform ?? "linux",
        arch: input.arch ?? "x64",
        public_key: input.devicePubkey,
        public_key_fingerprint: pubkeyFingerprint,
        trust_status: "trusted",
      } as never)
      .execute()

    const serviceId = randomUUID()
    const serviceKeyId = randomUUID()
    await trx
      .insertInto("device_services")
      .values({
        id: serviceId,
        device_id: pendingDeviceId,
        service_kind: "device_runtime",
        version: input.clientVersion ?? null,
        status: "starting",
        metadata: sql`'{}'::jsonb`,
      } as never)
      .execute()
    await trx
      .insertInto("device_service_keys")
      .values({
        id: serviceKeyId,
        service_id: serviceId,
        pubkey: input.servicePubkey,
        pubkey_fingerprint: serviceFingerprint,
      } as never)
      .execute()
    // Atomic UPDATE above already flipped status/timestamps. Just backfill
    // the device_id FK now that the device row exists.
    await trx
      .updateTable("device_pairing_sessions")
      .set({
        device_id: pendingDeviceId,
      } as never)
      .where("id", "=", session.id as string)
      .execute()

    return {
      device_id: pendingDeviceId,
      service_id: serviceId,
      service_key_id: serviceKeyId,
      control_plane_url: opts.controlPlaneUrl,
    }
  })
}
