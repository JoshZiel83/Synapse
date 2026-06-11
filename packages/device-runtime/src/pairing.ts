// Pairing helpers (§8). v3.0 implementation calls the REST endpoints exposed
// by packages/api/src/modules/devices/controller.ts.

import { createHash } from "node:crypto"
import type { ConsumePairingResult } from "@synapse/device-protocol"
import type {
  DevicePairingTicketView,
  StartPairingInput as ApiStartPairingInput,
} from "@synapse/shared"
import type {
  DeviceIdentityBroker,
  DeviceIdentityRecord,
  PairOptions,
  PairResult,
  RekeyOptions,
  RekeyResult,
} from "./types.js"

function joinUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`
}

async function postJson<TBody, TResponse>(
  url: string,
  body: TBody
): Promise<TResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`POST ${url} failed: ${res.status} ${text}`)
  }
  return (await res.json()) as TResponse
}

export async function startPairingSession(
  serverOrigin: string,
  workspaceId: string,
  input: Omit<ApiStartPairingInput, "workspaceId">,
  authToken: string
): Promise<DevicePairingTicketView> {
  const url = joinUrl(
    serverOrigin,
    `/api/v1/workspaces/${workspaceId}/devices/pairing-sessions`
  )
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`startPairing failed: ${res.status} ${text}`)
  }
  return (await res.json()) as DevicePairingTicketView
}

/**
 * Consume a local pairing code: generate device + service keys, exchange for
 * long-term credentials, write broker file.
 */
export async function pair(opts: PairOptions): Promise<PairResult> {
  if (opts.mode !== "local_qr") {
    throw new Error(
      `pair() currently supports mode=local_qr only (got ${opts.mode}); use bootstrap() for cloud devices`
    )
  }
  if (!opts.pairingCode) {
    throw new Error("pairingCode is required for local_qr pairing")
  }

  const deviceKey = await opts.broker.generateKeyPair("device")
  const serviceKey = await opts.broker.generateKeyPair("service:device_runtime")

  const url = joinUrl(
    opts.serverOrigin,
    "/api/v1/devices/pairing-sessions/consume"
  )
  const result = await postJson<Record<string, unknown>, ConsumePairingResult>(
    url,
    {
      pairing_code: opts.pairingCode,
      device_pubkey: deviceKey.publicKey,
      service_pubkey: serviceKey.publicKey,
      service_kind: "device_runtime",
      client_version: opts.clientVersion,
      title: opts.title,
      // Report platform + arch up-front so the API knows the
      // device's platformKey from pairing onwards. Without this the
      // `devices` row is created with platform=NULL/arch=NULL and the
      // bundle-eligibility gate (isBundleAvailableForPlatform) falls
      // back to the conservative-permissive branch, defeating the
      // Windows-no-bundled-fallback guard. cloud-bootstrap already
      // does this; this brings local_qr to parity.
      platform: process.platform,
      arch: process.arch,
    }
  )

  const identity: DeviceIdentityRecord = {
    deviceId: result.device_id,
    serverOrigin: opts.serverOrigin,
    hostKind: "local",
    devicePubkeyFingerprint: deviceKey.publicKeyFingerprint,
    devicePrivateKeyRef: deviceKey.privateKeyRef,
    services: [
      {
        serviceKind: "device_runtime",
        serviceId: result.service_id,
        pubkeyFingerprint: serviceKey.publicKeyFingerprint,
        privateKeyRef: serviceKey.privateKeyRef,
      },
    ],
  }
  await opts.broker.saveDeviceIdentity(identity)

  return {
    deviceId: result.device_id,
    serviceId: result.service_id,
    controlPlaneUrl: result.control_plane_url,
  }
}

/**
 * Re-key flow (§5.3). v3.0 stub — full re-key handler lands in PR #12
 * (cloud) and PR #5 (UI). For now the function generates a new service key,
 * persists it locally, and the caller is expected to drive the
 * service_join pairing-session loop.
 */
export async function rekeyDeviceRuntime(
  opts: RekeyOptions
): Promise<RekeyResult> {
  const identity = await opts.broker.loadDeviceIdentity()
  if (!identity || identity.deviceId !== opts.deviceId) {
    throw new Error("broker identity does not match the device being re-keyed")
  }
  const serviceKey = await opts.broker.generateKeyPair(
    "service:device_runtime:rekey"
  )
  // v3.0 skeleton returns the pubkey fingerprint as the synthesized service
  // key id. PR #5 wires the actual service_join pairing-session exchange.
  return {
    serviceId: identity.services[0]?.serviceId ?? "",
    serviceKeyId: createHash("sha256")
      .update(serviceKey.publicKey)
      .digest("hex"),
  }
}
