// Devices module — REST routes. v3.0 skeleton:
//
// - GET    /api/v1/workspaces/:workspaceId/devices
// - GET    /api/v1/workspaces/:workspaceId/devices/:deviceId
// - DELETE /api/v1/workspaces/:workspaceId/devices/:deviceId
// - POST   /api/v1/workspaces/:workspaceId/devices/pairing-sessions
// - POST   /api/v1/devices/pairing-sessions/consume        (unauthenticated; bearer = pairing_code)
// - POST   /api/v1/workspaces/:workspaceId/devices/:deviceId/services
//          (daemon claim, §5.4)
// - DELETE /api/v1/workspaces/:workspaceId/devices/:deviceId/services/:serviceId
//
// Bootstrap (cloud), re-key (Case A/B), and the full pairing-session lookup
// surface land in PR #5 + PR #12.

import { z } from "zod"
import type { FastifyInstance } from "fastify"
import {
  DEVICE_PAIRING_MODES,
  DEVICE_SERVICE_KINDS,
  DEVICE_TYPES,
} from "@synapse/device-protocol"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import {
  DeviceModuleError,
  claimRemoteAgentDaemon,
  consumePairing,
  deleteDevice,
  detachDeviceService,
  getDevice,
  listDevices,
  startPairing,
} from "./service.js"

const pairingModeSchema = z.enum(DEVICE_PAIRING_MODES)
const serviceKindSchema = z.enum(DEVICE_SERVICE_KINDS)
const deviceTypeSchema = z.enum(DEVICE_TYPES)

const startPairingBodySchema = z.object({
  mode: pairingModeSchema,
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  device_type: deviceTypeSchema.optional(),
  device_id: z.string().uuid().optional(),
  context: z.record(z.unknown()).optional(),
})

const consumePairingBodySchema = z.object({
  pairing_code: z.string().min(1),
  device_pubkey: z.string().min(1),
  service_pubkey: z.string().min(1),
  service_kind: serviceKindSchema.default("device_runtime"),
  client_version: z.string().optional(),
  title: z.string().optional(),
  device_type: deviceTypeSchema.optional(),
  platform: z.string().optional(),
})

const claimDaemonBodySchema = z.object({
  service_kind: z.literal("remote_agent_daemon"),
  remote_agent_machine_id: z.string().uuid(),
})

function sendModuleError(reply: any, err: unknown) {
  if (err instanceof DeviceModuleError) {
    reply.status(err.statusCode).send({ code: err.code, message: err.message })
    return true
  }
  return false
}

function resolveControlPlaneUrl(): string {
  const explicit = process.env.SYNAPSE_DEVICE_CONTROL_PLANE_URL
  if (explicit && explicit.trim().length > 0) return explicit.trim()
  const base = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001"
  return `${base.replace(/\/$/, "")}/api/v1/devices/control-plane`
}

export function registerDeviceRoutes(app: FastifyInstance): void {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }
  const authHook = { preHandler: [authMiddleware] }

  app.get(
    "/api/v1/workspaces/:workspaceId/devices",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      try {
        const devices = await listDevices(workspaceId)
        reply.send({ devices })
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  app.get(
    "/api/v1/workspaces/:workspaceId/devices/:deviceId",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, deviceId } = request.params as {
        workspaceId: string
        deviceId: string
      }
      try {
        reply.send(await getDevice(workspaceId, deviceId))
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  app.delete(
    "/api/v1/workspaces/:workspaceId/devices/:deviceId",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, deviceId } = request.params as {
        workspaceId: string
        deviceId: string
      }
      try {
        await deleteDevice(workspaceId, deviceId)
        reply.status(204).send()
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/devices/pairing-sessions",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const parsed = startPairingBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply
          .status(400)
          .send({ code: "invalid_request", details: parsed.error.flatten() })
        return
      }
      const session = (request as { session?: { workspaceMemberId?: string } })
        .session
      try {
        const result = await startPairing({
          workspaceId,
          requestedByWorkspaceMemberId: session?.workspaceMemberId ?? null,
          mode: parsed.data.mode,
          serverBaseUrl:
            (request.headers["origin"] as string | undefined) ??
            `http://${request.headers.host ?? "localhost"}`,
          title: parsed.data.title,
          description: parsed.data.description,
          deviceType: parsed.data.device_type,
          deviceId: parsed.data.device_id,
          context: parsed.data.context,
        })
        reply.send(result)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  // Unauthenticated: pairing_code is the bearer credential (rate-limited at
  // the edge, not in this handler).
  app.post(
    "/api/v1/devices/pairing-sessions/consume",
    async (request, reply) => {
      const parsed = consumePairingBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply
          .status(400)
          .send({ code: "invalid_request", details: parsed.error.flatten() })
        return
      }
      try {
        const result = await consumePairing(
          {
            pairingCode: parsed.data.pairing_code,
            devicePubkey: parsed.data.device_pubkey,
            servicePubkey: parsed.data.service_pubkey,
            serviceKind: parsed.data.service_kind,
            clientVersion: parsed.data.client_version,
            title: parsed.data.title,
            deviceType: parsed.data.device_type,
            platform: parsed.data.platform,
          },
          { controlPlaneUrl: resolveControlPlaneUrl() }
        )
        reply.send(result)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  app.post(
    "/api/v1/workspaces/:workspaceId/devices/:deviceId/services",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, deviceId } = request.params as {
        workspaceId: string
        deviceId: string
      }
      const parsed = claimDaemonBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply
          .status(400)
          .send({ code: "invalid_request", details: parsed.error.flatten() })
        return
      }
      try {
        const service = await claimRemoteAgentDaemon({
          workspaceId,
          deviceId,
          remoteAgentMachineId: parsed.data.remote_agent_machine_id,
        })
        reply.send(service)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  app.delete(
    "/api/v1/workspaces/:workspaceId/devices/:deviceId/services/:serviceId",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId, deviceId, serviceId } = request.params as {
        workspaceId: string
        deviceId: string
        serviceId: string
      }
      try {
        await detachDeviceService(workspaceId, deviceId, serviceId)
        reply.status(204).send()
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  // Silence unused authHook lint warning until cloud bootstrap (PR #12)
  // mounts /api/v1/devices/bootstrap on it.
  void authHook
}
