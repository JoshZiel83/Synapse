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
import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import type { FastifyInstance } from "fastify"
import {
  DEVICE_PAIRING_MODES,
  DEVICE_SERVICE_KINDS,
  DEVICE_TYPES,
} from "@synapse/device-protocol"
import { authMiddleware } from "../../infrastructure/middleware/auth.js"
import { workspaceMiddleware } from "../../infrastructure/middleware/workspace.js"
import { requireRequestAction } from "../access/guards.js"
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
import { consumeCloudBootstrap, createCloudDevicePairing } from "./cloud.js"

const pairingModeSchema = z.enum(DEVICE_PAIRING_MODES)
const serviceKindSchema = z.enum(DEVICE_SERVICE_KINDS)
const deviceTypeSchema = z.enum(DEVICE_TYPES)

const startPairingBodySchema = z.object({
  mode: pairingModeSchema,
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  device_type: deviceTypeSchema.optional(),
  device_id: z.uuid().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
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
  arch: z.string().optional(),
})

const claimDaemonBodySchema = z.object({
  service_kind: z.literal("remote_agent_daemon"),
  remote_agent_machine_id: z.uuid(),
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

/**
 * Authorize a workspace-scoped device action. Wraps requireRequestAction so
 * every device route enforces the right RBAC action against the workspace
 * resource (workspace.view / workspace.manage_devices / etc.) instead of
 * relying on workspaceMiddleware (which only checks workspace.view).
 *
 * Returns true if authorized; false if the request was already terminated
 * with a 403.
 */
async function authorizeWorkspaceDeviceAction(
  request: any,
  reply: any,
  action:
    | "workspace.manage_devices"
    | "workspace.view"
    | "device_capability.grant"
    | "device_capability.use",
  resourceId: string,
  errorMessage = "Forbidden"
): Promise<boolean> {
  return requireRequestAction(request, reply, action, resourceId, errorMessage)
}

export function registerDeviceRoutes(app: FastifyInstance): void {
  const workspaceHook = { preHandler: [authMiddleware, workspaceMiddleware] }
  const authHook = { preHandler: [authMiddleware] }

  app.get(
    "/api/v1/workspaces/:workspaceId/devices",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.view",
          workspaceId,
          "Cannot list devices in this workspace"
        ))
      )
        return
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
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.view",
          workspaceId,
          "Cannot view devices in this workspace"
        ))
      )
        return
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
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.manage_devices",
          workspaceId,
          "Cannot delete devices in this workspace"
        ))
      )
        return
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
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.manage_devices",
          workspaceId,
          "Cannot start a device pairing in this workspace"
        ))
      )
        return
      const parsed = startPairingBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsed.error),
        })
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
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsed.error),
        })
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
            arch: parsed.data.arch,
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
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.manage_devices",
          workspaceId,
          "Cannot manage services on this workspace's devices"
        ))
      )
        return
      const parsed = claimDaemonBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsed.error),
        })
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
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.manage_devices",
          workspaceId,
          "Cannot detach services from this workspace's devices"
        ))
      )
        return
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

  // Cloud device creation — workspace-scoped POST that returns a one-time
  // bootstrap_token for the API server to inject into the sandbox env.
  // The actual sandbox provisioning is the operator's responsibility (or a
  // host_provider plugin); the API just hands back the token.
  app.post(
    "/api/v1/workspaces/:workspaceId/devices/cloud",
    workspaceHook,
    async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId: string }
      if (
        !(await authorizeWorkspaceDeviceAction(
          request,
          reply,
          "workspace.manage_devices",
          workspaceId,
          "Cannot create cloud devices in this workspace"
        ))
      )
        return
      const body = request.body as {
        title?: string
        preset?: string
        host_provider?: string
      }
      const session = (request as { session?: { workspaceMemberId?: string } })
        .session
      try {
        const result = await createCloudDevicePairing({
          workspaceId,
          title: body.title ?? "Cloud Device",
          preset: body.preset,
          hostProvider: body.host_provider,
          requestedByWorkspaceMemberId: session?.workspaceMemberId ?? null,
        })
        reply.send(result)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  // Sandbox boot handler — runs INSIDE the sandbox. Unauthenticated;
  // bootstrap_token (sha256-hashed and matched against
  // device_pairing_sessions.bootstrap_token_hash) is the credential.
  app.post("/api/v1/devices/bootstrap", async (request, reply) => {
    const body = request.body as {
      bootstrap_token?: string
      device_pubkey?: string
      service_pubkey?: string
      client_version?: string
      host_provider?: string
      platform?: string
      arch?: string
    }
    if (!body?.bootstrap_token || !body.device_pubkey || !body.service_pubkey) {
      reply.status(400).send({
        code: "invalid_request",
        message: "bootstrap_token, device_pubkey, service_pubkey required",
      })
      return
    }
    try {
      const result = await consumeCloudBootstrap(
        {
          bootstrapToken: body.bootstrap_token,
          devicePubkey: body.device_pubkey,
          servicePubkey: body.service_pubkey,
          clientVersion: body.client_version,
          hostProvider: body.host_provider,
          platform: body.platform,
          arch: body.arch,
        },
        { controlPlaneUrl: resolveControlPlaneUrl() }
      )
      reply.send(result)
    } catch (err) {
      if (sendModuleError(reply, err)) return
      throw err
    }
  })
}
