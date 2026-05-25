// Device Control Plane WSS handler (§7.1).
//
// Authentication flow:
//   1. WS connect → server sends `server.challenge` notification with a fresh
//      32-byte hex nonce.
//   2. Device responds with `device.hello` whose `signed_challenge` is the
//      base64-Ed25519 signature of the nonce, signed by its service private
//      key (loaded from the broker).
//   3. Server verifies the signature against the device_service_keys row
//      matching the claimed (device_id, service_id) pair. Only then does
//      catalog.sync / runtime_session / event.emit / etc. become callable.

import { randomBytes } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import {
  DeviceCatalogSyncParamsSchema,
  DeviceHelloParamsSchema,
  type JsonRpcRequest,
} from "@synapse/device-protocol"
import { persistCatalogSync } from "./catalog-sync.js"
import { authenticateDeviceHello } from "./control-plane-auth.js"

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

interface ConnectionState {
  challengeNonce: string
  helloSeen: boolean
  authenticatedDeviceId: string | null
  authenticatedServiceId: string | null
}

/**
 * Maps device.hello auth failure codes to JSON-RPC error codes so the device
 * runtime can distinguish "you don't exist" from "your signature was wrong".
 */
function jsonRpcCodeForAuthFailure(code: string): number {
  switch (code) {
    case "device_not_found":
    case "service_not_found":
      return -32004 // resource not found
    case "service_key_missing":
    case "service_revoked":
      return -32005 // forbidden
    case "signature_invalid":
    case "unsupported_key":
      return -32003 // unauthenticated
    default:
      return -32603
  }
}

export function registerDeviceControlPlaneRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/devices/control-plane",
    { websocket: true },
    (socket: WebSocket, _request: FastifyRequest) => {
      const state: ConnectionState = {
        challengeNonce: randomBytes(32).toString("hex"),
        helloSeen: false,
        authenticatedDeviceId: null,
        authenticatedServiceId: null,
      }

      // Issue the challenge as the very first frame so the device runtime
      // has it before it sends device.hello.
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
              .then((result) => {
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
                writeResult(socket, req.id ?? null, {
                  accepted: true,
                  server_time: new Date().toISOString(),
                  service_key_id: result.serviceKeyId,
                  pubkey_fingerprint: result.pubkeyFingerprint,
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
          case "device.catalog.delta":
          case "device.service.status":
          case "device.runtime_session.opened":
          case "device.runtime_session.closed":
          case "device.task.received":
          case "device.task.started":
          case "device.task.output":
          case "device.task.status":
          case "device.task.result":
          case "device.event.emit":
          case "device.vfs.exposure.upsert": {
            if (!requireAuthenticated(req)) return
            // v3.0 skeleton: ack only. Real persistence lands in later PRs.
            writeResult(socket, req.id ?? null, {
              accepted: true,
              method: req.method,
              device_id: state.authenticatedDeviceId,
              service_id: state.authenticatedServiceId,
            })
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
        // v3.0 skeleton: nothing to clean up. A later PR closes the
        // device_control_plane_sessions row here.
      })
    }
  )
}
