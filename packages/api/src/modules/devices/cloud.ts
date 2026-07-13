// Cloud device bootstrap path (§8.2). v3.0 ships the server-side handler
// shape; e2b provisioning is delegated to a pluggable HostProvider so the
// API doesn't take a hard dep on @e2b/sdk in the skeleton.

import { createHash, randomUUID } from "node:crypto"
import {
  dateToIsoInstant,
  type IsoInstantString,
} from "@synapse/shared/datetime"
import type { CloudBootstrapResult } from "@synapse/device-protocol"
import { DeviceModuleError } from "./service.js"
import { insertCloudPairingSession, consumeCloudBootstrapTx } from "./repo.js"

export interface CreateCloudDeviceInput {
  workspaceId: string
  title: string
  requestedByWorkspaceMemberId?: string | null
  preset?: string
  /** P2 sandbox fork: which runtime kind this bootstrap mints (default 'device').
   *  The docker sandbox backend passes 'sandbox' + the adapter/mode/session facts
   *  the consume tx reads from context to author the sandboxes detail row. */
  targetRuntimeKind?: "device" | "sandbox"
  adapter?: string
  mode?: "resident" | "bare"
  sessionId?: string
  capabilityDescriptor?: Record<string, unknown>
}

/**
 * camelCase domain result of a cloud pairing allocation. Structurally matches
 * the app-facing shared `CreateCloudDeviceResultView` (the controller presents
 * it via that schema). The snake_case wire copy lives in device-protocol
 * (`CloudBootstrapResultSchema`) for the sandbox→/devices/bootstrap
 * handshake — same logical value, two surfaces, two contracts (§13.1).
 */
export interface CreateCloudDeviceResult {
  pendingRuntimeId: string
  bootstrapToken: string
  pairingSessionId: string
  expiresAt: IsoInstantString
}

/**
 * Allocate a pending runtime id + one-time bootstrap_token, persist them in a
 * cloud_bootstrap pairing session, and return the token for the caller (the
 * API server) to inject into the sandbox env. The `devices` row is NOT
 * created here — see consumeCloudBootstrap below — because
 * devices.public_key is NOT NULL (§6 Notes: pending_runtime_id — the id of the
 * device- OR sandbox-detail runtime — stored in context, never in the FK
 * column).
 */
export async function createCloudDevicePairing(
  input: CreateCloudDeviceInput
): Promise<CreateCloudDeviceResult> {
  const pendingRuntimeId = randomUUID()
  const bootstrapToken =
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
  const bootstrapTokenHash = createHash("sha256")
    .update(bootstrapToken)
    .digest()
  const sessionId = randomUUID()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

  await insertCloudPairingSession({
    sessionId: sessionId,
    workspaceId: input.workspaceId,
    requestedByWorkspaceMemberId: input.requestedByWorkspaceMemberId ?? null,
    targetRuntimeKind: input.targetRuntimeKind ?? "device",
    requestedTitle: input.title,
    bootstrapTokenHash: bootstrapTokenHash,
    expiresAt: expiresAt,
    // The sandbox fork facts (adapter/mode/session_id/capability_descriptor) are
    // carried in context and read by consumeCloudBootstrapTx's 'sandbox' branch.
    contextJson: JSON.stringify({
      pending_runtime_id: pendingRuntimeId,
      preset: input.preset ?? null,
      adapter: input.adapter ?? null,
      mode: input.mode ?? null,
      session_id: input.sessionId ?? null,
      capability_descriptor: input.capabilityDescriptor ?? {},
    }),
  })

  return {
    pendingRuntimeId: pendingRuntimeId,
    bootstrapToken: bootstrapToken,
    pairingSessionId: sessionId,
    expiresAt: dateToIsoInstant(expiresAt),
  }
}

export interface ConsumeBootstrapInput {
  bootstrapToken: string
  devicePubkey: string
  servicePubkey: string
  clientVersion?: string
  // R3.P2d-wire: required (sandboxes.platform/arch are NOT NULL). The wire schema
  // CloudBootstrapInputSchema now requires these, so the controller always threads
  // real OS facts here — no linux/x64 fallback.
  platform: string
  arch: string
}

// Wire result of the sandbox bootstrap handshake. The snake_case shape is the
// device-protocol contract (CloudBootstrapResultSchema) — sole consumer is the
// device-runtime cloud-bootstrap client.
export type ConsumeBootstrapResult = CloudBootstrapResult

/**
 * Sandbox boot handler. Resolves the bootstrap_token (hashed) to its
 * pairing session, atomically INSERTs the runtime detail (device OR sandbox,
 * using context.pending_runtime_id — the id of a device- or sandbox-detail
 * runtime) + runtime_services + runtime_service_keys, and marks the session
 * consumed.
 */
export async function consumeCloudBootstrap(
  input: ConsumeBootstrapInput,
  opts: { controlPlaneUrl: string }
): Promise<ConsumeBootstrapResult> {
  const tokenHash = createHash("sha256").update(input.bootstrapToken).digest()
  const pubkeyFingerprint = createHash("sha256")
    .update(input.devicePubkey)
    .digest("hex")
  const serviceFingerprint = createHash("sha256")
    .update(input.servicePubkey)
    .digest("hex")
  const serviceId = randomUUID()
  const serviceKeyId = randomUUID()

  const result = await consumeCloudBootstrapTx({
    tokenHash,
    device: {
      // R3.P2d-wire: fail-closed — platform/arch are required on the wire; the
      // old `?? "linux"` / `?? "x64"` fallback is gone.
      platform: input.platform,
      arch: input.arch,
      publicKey: input.devicePubkey,
      publicKeyFingerprint: pubkeyFingerprint,
    },
    service: { serviceId, version: input.clientVersion ?? null },
    serviceKey: {
      serviceKeyId,
      pubkey: input.servicePubkey,
      pubkeyFingerprint: serviceFingerprint,
    },
  })

  if (result.outcome !== "ok") {
    switch (result.outcome) {
      case "not_found":
        throw new DeviceModuleError({
          statusCode: 404,
          code: "bootstrap_token_not_found",
          message: "bootstrap token not recognised",
        })
      case "not_pending":
        throw new DeviceModuleError({
          statusCode: 409,
          code: "pairing_session_not_pending",
          message: `pairing session is ${result.existingStatus ?? "unknown"}`,
        })
      case "expired":
        throw new DeviceModuleError({
          statusCode: 410,
          code: "pairing_session_expired",
          message: "bootstrap window expired",
        })
      case "corrupt":
        throw new DeviceModuleError({
          statusCode: 500,
          code: "pairing_session_corrupt",
          message: "pairing session is missing pending_runtime_id",
        })
      case "race":
        throw new DeviceModuleError({
          statusCode: 409,
          code: "pairing_session_race",
          message:
            "bootstrap session was claimed by another consumer; retry not allowed",
        })
    }
  }

  return {
    runtime_id: result.pendingRuntimeId,
    service_id: serviceId,
    service_key_id: serviceKeyId,
    control_plane_url: opts.controlPlaneUrl,
  }
}
