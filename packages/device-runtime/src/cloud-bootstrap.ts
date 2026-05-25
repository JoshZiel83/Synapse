// Cloud sandbox bootstrap helper. Runs inside the sandbox on first boot:
// exchanges the env-injected bootstrap_token for long-term device + service
// credentials by calling POST /api/v1/devices/bootstrap.

import type { DeviceIdentityBroker, DeviceIdentityRecord } from "./types.js"

export interface BootstrapCloudDeviceOptions {
  serverOrigin: string
  broker: DeviceIdentityBroker
  bootstrapToken: string
  clientVersion: string
}

export interface BootstrapResult {
  deviceId: string
  serviceId: string
  controlPlaneUrl: string
}

export async function bootstrapCloudDevice(
  opts: BootstrapCloudDeviceOptions
): Promise<BootstrapResult> {
  const deviceKey = await opts.broker.generateKeyPair("device")
  const serviceKey = await opts.broker.generateKeyPair("service:device_runtime")

  const url = `${opts.serverOrigin.replace(/\/$/, "")}/api/v1/devices/bootstrap`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bootstrap_token: opts.bootstrapToken,
      device_pubkey: deviceKey.publicKey,
      service_pubkey: serviceKey.publicKey,
      client_version: opts.clientVersion,
      host_provider: "e2b",
      platform: process.platform,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`bootstrap failed: ${res.status} ${text}`)
  }
  const result = (await res.json()) as {
    device_id: string
    service_id: string
    service_key_id: string
    control_plane_url: string
  }

  const identity: DeviceIdentityRecord = {
    deviceId: result.device_id,
    serverOrigin: opts.serverOrigin,
    hostKind: "cloud",
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
