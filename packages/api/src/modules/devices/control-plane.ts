// Device Control Plane WSS handler skeleton (§7.1).
//
// v3.0 skeleton: accepts a WebSocket connection, parses JSON-RPC 2.0 frames,
// validates `device.hello` (handshake + signed challenge), and emits ack
// responses. Catalog sync, runtime session, operation cancel etc. land in
// later PRs as the runtime side is built out.
//
// The handler intentionally does NOT yet drive Postgres state — that is the
// job of PR #6 (real handshake against device_service_keys) and PR #7
// (catalog_sync against device_exposures / device_tools).

import type { FastifyInstance, FastifyRequest } from "fastify"
import type { WebSocket } from "ws"
import {
  DeviceCatalogSyncParamsSchema,
  DeviceHelloParamsSchema,
  type JsonRpcRequest,
} from "@synapse/device-protocol"
import { persistCatalogSync } from "./catalog-sync.js"

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

/**
 * v3.0 skeleton handler. Real authentication + state transitions land in PR #6.
 * The path here is intentionally minimal so that other PRs can wire a real
 * Device Runtime against it for end-to-end smoke testing.
 */
export function registerDeviceControlPlaneRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/devices/control-plane",
    { websocket: true },
    (socket: WebSocket, _request: FastifyRequest) => {
      let helloSeen = false
      let helloMeta: { deviceId: string; serviceId: string } | null = null

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
            helloSeen = true
            helloMeta = {
              deviceId: parsed.data.device_id,
              serviceId: parsed.data.service_id,
            }
            writeResult(socket, req.id ?? null, {
              accepted: true,
              server_time: new Date().toISOString(),
            })
            return
          }
          case "device.catalog.sync": {
            if (!helloSeen || !helloMeta) {
              writeError(
                socket,
                req.id ?? null,
                -32002,
                "device.hello required before any other method"
              )
              return
            }
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
              deviceId: helloMeta.deviceId,
              serviceId: helloMeta.serviceId,
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
            if (!helloSeen) {
              writeError(
                socket,
                req.id ?? null,
                -32002,
                "device.hello required before any other method"
              )
              return
            }
            // v3.0 skeleton: ack only. Real persistence lands in later PRs.
            writeResult(socket, req.id ?? null, {
              accepted: true,
              method: req.method,
              device_id: helloMeta?.deviceId,
              service_id: helloMeta?.serviceId,
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
        // v3.0 skeleton: nothing to clean up. PR #6 closes the
        // device_control_plane_sessions row here.
      })
    }
  )
}
