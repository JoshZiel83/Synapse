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

import { formatValidationDetails } from "../../infrastructure/validation-error.js"
import type { FastifyInstance } from "fastify"
import {
  ConsumePairingInputSchema,
  CloudBootstrapInputSchema,
} from "@synapse/device-protocol"
import {
  StartPairingInputSchema,
  ClaimDaemonServiceInputSchema,
  CreateCloudDeviceInputSchema,
  CreateCloudDeviceResultViewSchema,
  DeviceViewSchema,
  DeviceListViewSchema,
  DeviceDetailViewSchema,
  DevicePairingTicketViewSchema,
  DeviceServiceViewSchema,
} from "@synapse/shared/schemas"
import { appRoute, wireRoute } from "../../infrastructure/http/route.js"
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
import {
  presentDevice,
  presentDeviceDetail,
  presentDevicePairingTicket,
  presentDeviceService,
} from "./presenter.js"
import { consumeCloudBootstrap, createCloudDevicePairing } from "./cloud.js"

// App-facing request bodies (camelCase, §5.1.1). workspaceId travels in the URL
// param, so the body schema omits it from the shared logical input contract.
export const startPairingBodySchema = StartPairingInputSchema.omit({
  workspaceId: true,
})

// WIRE — consume/bootstrap handshake bodies are snake_case wire contracts owned
// by @synapse/device-protocol (single source for runtime client + SDK + API).
const consumePairingBodySchema = ConsumePairingInputSchema
const cloudBootstrapBodySchema = CloudBootstrapInputSchema

const claimDaemonBodySchema = ClaimDaemonServiceInputSchema

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

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/devices",
    { schema: DeviceListViewSchema, options: workspaceHook },
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
        const records = await listDevices(workspaceId)
        return records.map(presentDevice)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  appRoute(
    app,
    "GET",
    "/api/v1/workspaces/:workspaceId/devices/:deviceId",
    { schema: DeviceDetailViewSchema, options: workspaceHook },
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
        return presentDeviceDetail(await getDevice(workspaceId, deviceId))
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/devices/:deviceId",
    { schema: DeviceDetailViewSchema, options: workspaceHook },
    async (request, reply): Promise<undefined> => {
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
        return
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/devices/pairing-sessions",
    { schema: DevicePairingTicketViewSchema, options: workspaceHook },
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
          deviceType: parsed.data.deviceType,
          deviceId: parsed.data.deviceId,
          context: parsed.data.context,
        })
        return presentDevicePairingTicket(result)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  // Unauthenticated: pairing_code is the bearer credential (rate-limited at
  // the edge, not in this handler). WIRE — daemon handshake; bare payload.
  wireRoute(
    app,
    "POST",
    "/api/v1/devices/pairing-sessions/consume",
    {},
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

  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/devices/:deviceId/services",
    { schema: DeviceServiceViewSchema, options: workspaceHook },
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
          remoteAgentMachineId: parsed.data.remoteAgentMachineId,
        })
        return presentDeviceService(service)
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  appRoute(
    app,
    "DELETE",
    "/api/v1/workspaces/:workspaceId/devices/:deviceId/services/:serviceId",
    { schema: DeviceServiceViewSchema, options: workspaceHook },
    async (request, reply): Promise<undefined> => {
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
        return
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
  appRoute(
    app,
    "POST",
    "/api/v1/workspaces/:workspaceId/devices/cloud",
    { schema: CreateCloudDeviceResultViewSchema, options: workspaceHook },
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
      // Body carries title/preset/hostProvider (camelCase, §5.1.1); workspaceId
      // travels in the URL param. title/hostProvider are already optional on the
      // shared schema (server applies defaults), so the SDK and server validate
      // the identical body shape.
      const cloudBodySchema = CreateCloudDeviceInputSchema.omit({
        workspaceId: true,
      })
      const parsedBody = cloudBodySchema.safeParse(request.body)
      if (!parsedBody.success) {
        reply.status(400).send({
          code: "invalid_request",
          details: formatValidationDetails(parsedBody.error),
        })
        return
      }
      const session = (request as { session?: { workspaceMemberId?: string } })
        .session
      try {
        const result = await createCloudDevicePairing({
          workspaceId,
          title: parsedBody.data.title ?? "Cloud Device",
          preset: parsedBody.data.preset,
          hostProvider: parsedBody.data.hostProvider,
          requestedByWorkspaceMemberId: session?.workspaceMemberId ?? null,
        })
        return result
      } catch (err) {
        if (sendModuleError(reply, err)) return
        throw err
      }
    }
  )

  // Sandbox boot handler — runs INSIDE the sandbox. Unauthenticated;
  // bootstrap_token (sha256-hashed and matched against
  // device_pairing_sessions.bootstrap_token_hash) is the credential.
  // WIRE — machine bootstrap handshake; bare payload.
  wireRoute(
    app,
    "POST",
    "/api/v1/devices/bootstrap",
    {},
    async (request, reply) => {
      const parsed = cloudBootstrapBodySchema.safeParse(request.body)
      if (!parsed.success) {
        reply.status(400).send({
          code: "invalid_request",
          message: "bootstrap_token, device_pubkey, service_pubkey required",
          details: formatValidationDetails(parsed.error),
        })
        return
      }
      const body = parsed.data
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
    }
  )
}
