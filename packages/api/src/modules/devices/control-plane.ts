// Device Control Plane WSS handler (§7.1).
//
// Authentication flow:
//   1. WS connect → server sends `server.challenge` notification with a fresh
//      32-byte hex nonce.
//   2. Device responds with `device.hello` whose `signed_challenge` is the
//      base64-Ed25519 signature of the nonce, signed by its service private
//      key (loaded from the broker).
//   3. Server verifies the signature against the device_service_keys row
//      matching the claimed (device_id, service_id) pair. On success, a
//      device_control_plane_sessions row is INSERTed with status='active'
//      and device_services.current_session_id is bumped.
//   4. Server returns the envelope-signing pubkey + kid in the hello ack so
//      the runtime can populate its trusted_server_keys map without out-of-
//      band config.
//   5. Catalog sync + runtime sessions + tunnel registration are gated behind
//      requireAuthenticated.
//   6. On `device.tunnel.up`, the server registers the device's internalUrl
//      with DeviceTunnelRegistry so dispatchSyncTool can route to it. On
//      `device.tunnel.down` (or socket close), the registry entry is removed.

import { randomBytes, randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import { sql } from "kysely"
import {
  DeviceCatalogSyncParamsSchema,
  DeviceHelloParamsSchema,
  type JsonRpcRequest,
} from "@synapse/device-protocol"
import { db } from "../../infrastructure/database/kysely.js"
import { persistCatalogSync } from "./catalog-sync.js"
import { authenticateDeviceHello } from "./control-plane-auth.js"
import { getEnvelopeServerPublicKey } from "./envelope-signer.js"
import { getDeviceTunnelRegistry } from "./tunnel-registry.js"
import {
  persistDeviceEventEmit,
  persistRuntimeSessionClosed,
  persistRuntimeSessionOpened,
  persistTaskOutput,
  persistTaskReceived,
  persistTaskResult,
  persistTaskStarted,
  persistTaskStatus,
  persistVfsExposureUpsert,
  type PersistResult,
} from "./control-plane-events.js"

interface ParsedFrame {
  raw: string
  json: unknown
}

function parseFrame(raw: string): ParsedFrame {
  return { raw, json: JSON.parse(raw) }
}

function asJsonRpcRequest(value: unknown): JsonRpcRequest | null {
  if (
    value &&
    typeof value === "object" &&
    "jsonrpc" in value &&
    (value as { jsonrpc: unknown }).jsonrpc === "2.0" &&
    "method" in value &&
    typeof (value as { method: unknown }).method === "string"
  ) {
    return value as JsonRpcRequest
  }
  return null
}

function writeResult(
  socket: WebSocket,
  id: string | number | null | undefined,
  result: unknown
) {
  if (id === undefined || id === null) return // notification, no response
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }))
}

function writeError(
  socket: WebSocket,
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
) {
  if (id === undefined || id === null) return
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, data },
    })
  )
}

function writeNotification(
  socket: WebSocket,
  method: string,
  params: unknown
) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
}

function writePersistResult(
  socket: WebSocket,
  id: string | number | null | undefined,
  result: PersistResult
) {
  if (result.ok) {
    writeResult(socket, id, { accepted: true, ...(result.payload ?? {}) })
  } else {
    writeError(socket, id, result.code, result.message)
  }
}

interface ConnectionState {
  challengeNonce: string
  helloSeen: boolean
  authenticatedDeviceId: string | null
  authenticatedServiceId: string | null
  authenticatedWorkspaceId: string | null
  sessionId: string | null
  registeredTunnelServiceId: string | null
}

function jsonRpcCodeForAuthFailure(code: string): number {
  switch (code) {
    case "device_not_found":
    case "service_not_found":
      return -32004
    case "service_key_missing":
    case "service_revoked":
      return -32005
    case "signature_invalid":
    case "unsupported_key":
      return -32003
    default:
      return -32603
  }
}

async function insertControlPlaneSession(args: {
  deviceId: string
  serviceId: string
  clientVersion: string | null
  remoteAddr: string | null
}): Promise<string> {
  const sessionId = randomUUID()
  await db
    .insertInto("device_control_plane_sessions")
    .values({
      id: sessionId,
      device_id: args.deviceId,
      service_id: args.serviceId,
      protocol_version: 1,
      client_version: args.clientVersion,
      status: "active",
      transport: "websocket",
      remote_addr: args.remoteAddr,
      last_sequence: 0,
      last_heartbeat_at: sql`NOW()`,
      started_at: sql`NOW()`,
    } as never)
    .execute()
  await db
    .updateTable("device_services")
    .set({
      current_session_id: sessionId,
      last_seen_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    } as never)
    .where("id", "=", args.serviceId)
    .execute()
  return sessionId
}

async function closeControlPlaneSession(
  sessionId: string,
  reason: string
): Promise<void> {
  try {
    await db
      .updateTable("device_control_plane_sessions")
      .set({
        status: "closed",
        ended_at: sql`NOW()`,
        close_reason: reason,
        updated_at: sql`NOW()`,
      } as never)
      .where("id", "=", sessionId)
      .execute()
    await db
      .updateTable("device_services")
      .set({
        current_session_id: null,
        updated_at: sql`NOW()`,
      } as never)
      .where("current_session_id", "=", sessionId)
      .execute()
  } catch {
    /* best effort; DB unavailability shouldn't block socket teardown */
  }
}

export function registerDeviceControlPlaneRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/devices/control-plane",
    { websocket: true },
    (socket: WebSocket, request: FastifyRequest) => {
      const state: ConnectionState = {
        challengeNonce: randomBytes(32).toString("hex"),
        helloSeen: false,
        authenticatedDeviceId: null,
        authenticatedServiceId: null,
        authenticatedWorkspaceId: null,
        sessionId: null,
        registeredTunnelServiceId: null,
      }

      writeNotification(socket, "server.challenge", {
        nonce: state.challengeNonce,
      })

      const requireAuthenticated = (req: JsonRpcRequest): boolean => {
        if (state.authenticatedDeviceId && state.authenticatedServiceId) {
          return true
        }
        writeError(
          socket,
          req.id ?? null,
          -32003,
          "device.hello must succeed before any other method"
        )
        return false
      }

      socket.on("message", (raw) => {
        let frame: ParsedFrame
        try {
          frame = parseFrame(String(raw))
        } catch {
          writeError(socket, null, -32700, "Parse error")
          return
        }
        const req = asJsonRpcRequest(frame.json)
        if (!req) {
          writeError(socket, null, -32600, "Invalid request")
          return
        }
        switch (req.method) {
          case "device.hello": {
            if (state.helloSeen) {
              writeError(
                socket,
                req.id ?? null,
                -32001,
                "device.hello already received on this connection"
              )
              return
            }
            const parsed = DeviceHelloParamsSchema.safeParse(req.params)
            if (!parsed.success) {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "Invalid device.hello params",
                parsed.error.flatten()
              )
              return
            }
            state.helloSeen = true
            authenticateDeviceHello({
              deviceId: parsed.data.device_id,
              serviceId: parsed.data.service_id,
              signedChallenge: parsed.data.signed_challenge,
              challengeNonce: state.challengeNonce,
            })
              .then(async (result) => {
                if (!result.ok) {
                  writeError(
                    socket,
                    req.id ?? null,
                    jsonRpcCodeForAuthFailure(result.code),
                    result.message,
                    { code: result.code }
                  )
                  try {
                    socket.close(4003, result.code)
                  } catch {
                    /* ignore */
                  }
                  return
                }
                state.authenticatedDeviceId = result.deviceId
                state.authenticatedServiceId = result.serviceId
                // Cache the device's workspace_id so per-message event
                // persistence (runtime_events) doesn't have to re-query it.
                try {
                  const deviceRow = await db
                    .selectFrom("devices")
                    .select(["workspace_id"])
                    .where("id", "=", result.deviceId)
                    .executeTakeFirst()
                  state.authenticatedWorkspaceId =
                    (deviceRow?.workspace_id as string | undefined) ?? null
                } catch {
                  /* workspace lookup is best-effort; event.emit will
                   * surface a structured error if it tries to write without
                   * it. */
                }
                // Persist the CP session so runtime-authorization requests
                // can find an active session and not reject themselves.
                try {
                  state.sessionId = await insertControlPlaneSession({
                    deviceId: result.deviceId,
                    serviceId: result.serviceId,
                    clientVersion: parsed.data.client_version ?? null,
                    remoteAddr: request.ip ?? null,
                  })
                } catch (err) {
                  writeError(
                    socket,
                    req.id ?? null,
                    -32603,
                    `session insert failed: ${(err as Error).message}`
                  )
                  try {
                    socket.close(1011, "session insert failed")
                  } catch {
                    /* ignore */
                  }
                  return
                }
                // Hand the device our envelope-signing pubkey + kid so it
                // can populate trusted_server_keys without out-of-band
                // config. If the env var isn't set, ship null so the
                // operator notices on the dashboard.
                let serverEnvelopeKey: {
                  signatureKid: string
                  publicKeyPem: string
                } | null = null
                try {
                  serverEnvelopeKey = getEnvelopeServerPublicKey()
                } catch {
                  serverEnvelopeKey = null
                }
                writeResult(socket, req.id ?? null, {
                  accepted: true,
                  server_time: new Date().toISOString(),
                  service_key_id: result.serviceKeyId,
                  pubkey_fingerprint: result.pubkeyFingerprint,
                  control_plane_session_id: state.sessionId,
                  envelope_signing: serverEnvelopeKey
                    ? {
                        kid: serverEnvelopeKey.signatureKid,
                        public_key_pem: serverEnvelopeKey.publicKeyPem,
                      }
                    : null,
                })
              })
              .catch((err) => {
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  `auth lookup failed: ${(err as Error).message}`
                )
              })
            return
          }
          case "device.catalog.sync": {
            if (!requireAuthenticated(req)) return
            const parsedCatalog = DeviceCatalogSyncParamsSchema.safeParse(
              req.params
            )
            if (!parsedCatalog.success) {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "Invalid device.catalog.sync params",
                parsedCatalog.error.flatten()
              )
              return
            }
            persistCatalogSync({
              deviceId: state.authenticatedDeviceId!,
              serviceId: state.authenticatedServiceId!,
              exposures: parsedCatalog.data.exposures,
            })
              .then((result) => {
                writeResult(socket, req.id ?? null, {
                  accepted: true,
                  ...result,
                })
              })
              .catch((err) => {
                writeError(
                  socket,
                  req.id ?? null,
                  -32603,
                  `catalog persist failed: ${(err as Error).message}`
                )
              })
            return
          }
          case "device.tunnel.up": {
            if (!requireAuthenticated(req)) return
            const params = req.params as
              | { internal_url?: unknown }
              | undefined
            if (!params || typeof params.internal_url !== "string") {
              writeError(
                socket,
                req.id ?? null,
                -32602,
                "device.tunnel.up: 'internal_url' (string) required"
              )
              return
            }
            getDeviceTunnelRegistry().register({
              deviceServiceId: state.authenticatedServiceId!,
              internalUrl: params.internal_url,
            })
            state.registeredTunnelServiceId = state.authenticatedServiceId
            writeResult(socket, req.id ?? null, { registered: true })
            return
          }
          case "device.tunnel.down": {
            if (!requireAuthenticated(req)) return
            if (state.registeredTunnelServiceId) {
              getDeviceTunnelRegistry().unregister(
                state.registeredTunnelServiceId
              )
              state.registeredTunnelServiceId = null
            }
            writeResult(socket, req.id ?? null, { unregistered: true })
            return
          }
          case "device.catalog.delta":
          case "device.service.status": {
            if (!requireAuthenticated(req)) return
            // v3.0 skeleton: ack only (catalog delta + service status
            // streaming aren't yet wired into the projection invalidation
            // hooks). Scoped for a follow-up.
            writeResult(socket, req.id ?? null, {
              accepted: true,
              method: req.method,
              device_id: state.authenticatedDeviceId,
              service_id: state.authenticatedServiceId,
            })
            return
          }
          case "device.runtime_session.opened": {
            if (!requireAuthenticated(req)) return
            persistRuntimeSessionOpened(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.runtime_session.closed": {
            if (!requireAuthenticated(req)) return
            persistRuntimeSessionClosed(
              state.authenticatedDeviceId!,
              state.authenticatedServiceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.task.received": {
            if (!requireAuthenticated(req)) return
            persistTaskReceived(req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.task.started": {
            if (!requireAuthenticated(req)) return
            persistTaskStarted(req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.task.output": {
            if (!requireAuthenticated(req)) return
            persistTaskOutput(req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.task.status": {
            if (!requireAuthenticated(req)) return
            persistTaskStatus(req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.task.result": {
            if (!requireAuthenticated(req)) return
            persistTaskResult(req.params)
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.event.emit": {
            if (!requireAuthenticated(req)) return
            if (!state.authenticatedWorkspaceId) {
              writeError(
                socket,
                req.id ?? null,
                -32603,
                "device.event.emit needs workspace context; auth did not resolve workspace_id"
              )
              return
            }
            persistDeviceEventEmit(
              state.authenticatedWorkspaceId,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          case "device.vfs.exposure.upsert": {
            if (!requireAuthenticated(req)) return
            persistVfsExposureUpsert(
              state.authenticatedDeviceId!,
              req.params
            )
              .then((r) => writePersistResult(socket, req.id ?? null, r))
              .catch((err) =>
                writeError(socket, req.id ?? null, -32603, (err as Error).message)
              )
            return
          }
          default: {
            writeError(
              socket,
              req.id ?? null,
              -32601,
              `Method not found: ${req.method}`
            )
          }
        }
      })

      socket.on("close", () => {
        if (state.registeredTunnelServiceId) {
          getDeviceTunnelRegistry().unregister(
            state.registeredTunnelServiceId
          )
          state.registeredTunnelServiceId = null
        }
        if (state.sessionId) {
          void closeControlPlaneSession(state.sessionId, "socket_close")
          state.sessionId = null
        }
      })
    }
  )
}
