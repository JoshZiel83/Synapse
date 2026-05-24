import crypto from "crypto"
import type { FastifyInstance } from "fastify"
import type {
  RelayCatalogToolSnapshot,
  RelayHiddenToolBinding,
  RelayOperationError,
  RelayVisibleToolDefinition,
} from "@synapse/shared"
import type {
  RelayAuthorizationGrantSpec,
  RelayAuthorizationGrantScope,
} from "@synapse/shared/types"
import {
  extractText,
  GrantPolicySchema,
  RELAY_AUTH_TIMEOUT,
  RELAY_DELIVERY_ACK_TIMEOUT_MS,
  RELAY_HEARTBEAT_INTERVAL,
  RELAY_OPERATION_TTL_MS,
  RELAY_PROTOCOL_VERSION,
  RELAY_TOOL_CALL_TIMEOUT,
  relayDeviceOfflineEventDefinition,
  relayDeviceOnlineEventDefinition,
  textBlocks,
} from "@synapse/shared"
import { redis } from "../../infrastructure/redis/index.js"
import { transaction } from "../../infrastructure/database/index.js"
import {
  executeSql,
  executeSqlOn,
} from "../../infrastructure/database/kysely.js"
import { incrementMcpVersion } from "./runtime-version.js"
import {
  getRuntimeNodeId,
  registerRuntimeCommandHandler,
  sendRuntimeCommand,
} from "./runtime-control-plane.js"
import { logEvent } from "./audit.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { touchRelayExposureAccessState } from "./relay-access.js"
import { ingestAutomationProviderEvent } from "../automation/service.js"
import {
  enqueueAutomationExecutionJobs,
  sessionThinkingQueue,
} from "../../workers/queues.js"
import {
  appendToolCallTaskOutput,
  completeToolCallTask,
  failToolCallTask,
  getToolCallTask,
  insertToolCallTask,
  markToolCallTaskCancelRequested,
  markToolCallTaskDispatched,
  markToolCallTaskReceived,
  markToolCallTaskStarted,
  requestToolCallTaskCancel,
  cancelToolCallTask,
  type ToolCallTaskDeliveryPolicy,
  type ToolCallTaskRecord,
} from "../tool-call-tasks/service.js"
import { findMatchingRelayAuthorizationGrant } from "../relay-authorizations/service.js"
import { normalizeMcpToolResult } from "./result-normalizer.js"
import { inferRelaySpecialAuthorizationPlan } from "./relay-special-mcp.js"
import { createRelayAuthorizationRequest } from "../relay-authorizations/requests.js"
import {
  classifyRelayLocalPermissionDenial,
  normalizeRelayRequestAuthorizationMode,
  type RelayRequestAuthorizationMode,
} from "./relay-invoke-options.js"

interface RelayToolRegistration {
  stableKey: string
  visible: RelayVisibleToolDefinition
  annotations: Record<string, unknown>
  metadata: Record<string, unknown>
}

interface RelayExposureRegistration {
  stableKey: string
  syncSourceKey: string | null
  displayName: string
  transport: "builtin" | "stdio" | "http" | "sse" | "custom"
  runtimeStatus:
    | "discovered"
    | "starting"
    | "healthy"
    | "degraded"
    | "failed"
    | "quarantined"
    | "offline"
  metadata: Record<string, unknown>
  tools: RelayToolRegistration[]
}

interface RelaySyncSourceRegistration {
  sourceKind:
    | "manual"
    | "claude_code"
    | "claude_desktop"
    | "codex"
    | "gemini"
    | "opencode"
    | "custom"
  sourceKey: string
  configPath: string | null
  syncMode: "snapshot" | "follow"
  status: "unknown" | "idle" | "syncing" | "error" | "disabled"
  lastSyncedAt: string | null
  lastError: string | null
  metadata: Record<string, unknown>
}

interface ConnectedRelayExposure {
  deviceId?: string
  deviceDisplayName?: string
  exposureId: string
  stableKey: string
  displayName: string
  transport: string
  runtimeStatus: string
  metadata: Record<string, unknown>
  tools: RelayCatalogToolSnapshot[]
}

interface PendingRelayOperation {
  responseMode: "sync" | "async"
  operationStatus:
    | "created"
    | "cancel_requested"
    | "dispatched"
    | "received"
    | "started"
    | "completed"
    | "failed"
    | "cancelled"
    | "aborted"
    | "expired"
  operationId: string
  deviceId: string
  workspaceId: string
  conversationId: string | null
  sessionId: string | null
  actorId: string | null
  workspaceMemberId: string | null
  exposureId: string
  exposureStableKey: string
  runtimeSessionId: string
  visibleToolName: string
  sourceToolName: string
  toolId: string
  toolRevisionId: string
  catalogRevisionId: string
  args: Record<string, unknown>
  authorization?: RelayAuthorizationEnvelope
  inputHash: string
  taskId: string | null
  operationTimeoutMs: number
  expiresAt: string | null
  timeoutTimer: NodeJS.Timeout
  ackTimer: NodeJS.Timeout | null
  relaySessionRowId: string | null
  deliverySeq: number | null
  deliveryId: string | null
  cancelRequested: boolean
  cancelReason: string | null
  resolve?: (value: unknown) => void
  reject?: (error: Error) => void
}

interface PendingRelayRuntimeSessionRequest {
  action: "open" | "close"
  runtimeSessionId: string
  deviceId: string
  deliveryId: string | null
  timeoutTimer: NodeJS.Timeout
  resolve: () => void
  reject: (error: Error) => void
}

interface ConnectedRelay {
  deviceId: string
  workspaceId: string
  ownerWorkspaceMemberId: string | null
  displayName: string
  sessionRowId: string
  sessionId: string
  ws: any
  exposures: Map<string, ConnectedRelayExposure>
  heartbeatTimer: NodeJS.Timeout | null
  pongTimer: NodeJS.Timeout | null
  nextDeliverySeq: number
}

interface RelayExposureCatalog {
  deviceId: string
  deviceDisplayName: string
  exposureId: string
  exposureStableKey: string
  exposureDisplayName: string
  transport: string
  runtimeStatus: string
  metadata: Record<string, unknown>
  tools: RelayCatalogToolSnapshot[]
}

interface RelayAuthorizationEnvelope {
  grantIds?: string[]
  grantScope?: RelayAuthorizationGrantScope
  grantSpecs?: RelayAuthorizationGrantSpec[]
  retryNonce?: string
}

interface RelayCallParams {
  conversationId?: string
  sessionId?: string
  requestedByWorkspaceMemberId?: string
  requestedByActorId?: string
  relayCapabilityId: string
  deviceId: string
  exposureId: string
  visibleToolName: string
  binding: RelayHiddenToolBinding
  args: Record<string, unknown>
  runtimeSessionId: string
  authorization?: RelayAuthorizationEnvelope
}

interface RelayAsyncCallParams extends RelayCallParams {
  workspaceId: string
  conversationId: string
  sessionId: string
  requestedByActorId: string
  sourceToolCallId: string
  sourceToolName: string
  turnId?: string
  requestedByWorkspaceMemberId?: string
  deliveryPolicy: ToolCallTaskDeliveryPolicy
  serverInvokeOptions?: {
    requestAuthorization?: RelayRequestAuthorizationMode
  }
}

type RelayOperationLifecycleStatus = PendingRelayOperation["operationStatus"]

type RelayAuthRow = {
  id: string
  workspace_id: string
  owner_workspace_member_id: string | null
  display_name: string
  public_key: string
  public_key_fingerprint: string
  trust_status: "pending" | "active" | "revoked" | "blocked"
}

const connectedRelays = new Map<string, ConnectedRelay>()
const pendingRelayOperations = new Map<string, PendingRelayOperation>()
let relayLifecycleSweepTimer: NodeJS.Timeout | null = null
const RELAY_LIFECYCLE_OFFLINE_GRACE_MS =
  relayDeviceOfflineEventDefinition.graceWindowMs || 60_000
const RELAY_LIFECYCLE_SWEEP_INTERVAL_MS = 15_000
const RELAY_RUNTIME_SESSION_TIMEOUT_MS = 15_000
const pendingRelayRuntimeSessionRequests = new Map<
  string,
  PendingRelayRuntimeSessionRequest
>()
const RELAY_ROUTE_TTL_MS = Math.max(RELAY_HEARTBEAT_INTERVAL * 3, 45_000)
const RELAY_RUNTIME_NODE_ID = getRuntimeNodeId()
let relayCommandHandlersRegistered = false

type RelayRouteRecord = {
  deviceId: string
  nodeId: string
  sessionId: string
  updatedAt: number
}

type RelayCommandPayload =
  | {
      command: "open_runtime_session"
      deviceId: string
      exposureId: string
      exposureStableKey: string
    }
  | {
      command: "close_runtime_session"
      deviceId: string
      runtimeSessionId: string
    }
  | {
      command: "call_tool"
      params: RelayCallParams
    }
  | {
      command: "enqueue_tool_task"
      params: RelayAsyncCallParams
    }

function relayRouteKey(deviceId: string) {
  return `mcp:relay:route:${deviceId}`
}

async function publishRelayRoute(connected: ConnectedRelay) {
  const record: RelayRouteRecord = {
    deviceId: connected.deviceId,
    nodeId: RELAY_RUNTIME_NODE_ID,
    sessionId: connected.sessionId,
    updatedAt: Date.now(),
  }
  await redis.set(
    relayRouteKey(connected.deviceId),
    JSON.stringify(record),
    "PX",
    RELAY_ROUTE_TTL_MS
  )
}

async function readRelayRoute(
  deviceId: string
): Promise<RelayRouteRecord | null> {
  const raw = await redis.get(relayRouteKey(deviceId))
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as RelayRouteRecord
    return parsed?.nodeId && parsed?.sessionId ? parsed : null
  } catch {
    return null
  }
}

async function clearRelayRoute(deviceId: string, sessionId: string) {
  await redis
    .eval(
      `local raw = redis.call("GET", KEYS[1])
     if not raw then
       return 0
     end
     local decoded = cjson.decode(raw)
     if decoded["sessionId"] == ARGV[1] then
       return redis.call("DEL", KEYS[1])
     end
     return 0`,
      1,
      relayRouteKey(deviceId),
      sessionId
    )
    .catch(() => undefined)
}

export function handleRelayConnection(
  socket: any,
  _req: any,
  _app: FastifyInstance
) {
  let deviceId: string | null = null
  let authenticated = false
  let authInProgress = false
  let pendingChallenge: {
    device: RelayAuthRow
    challenge: string
    nonce: string
    protocolVersion: number
    clientVersion: string | null
  } | null = null

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      try {
        sendAuthError(socket, "auth_timeout", "Authentication timeout", true)
      } catch {}
      socket.close()
    }
  }, RELAY_AUTH_TIMEOUT)

  socket.on("message", async (raw: any) => {
    const msg = parseMessage(raw)
    if (!msg) return

    if (msg.type === "auth.begin") {
      if (authenticated) {
        sendAuthError(
          socket,
          "already_authenticated",
          "Already authenticated",
          false
        )
        return
      }
      if (authInProgress) {
        sendAuthError(
          socket,
          "auth_in_progress",
          "Authentication in progress",
          true
        )
        return
      }
      authInProgress = true
      clearTimeout(authTimer)

      try {
        const device = await authenticateRelayDevice(msg.deviceId)
        if (!device) {
          sendAuthError(socket, "unknown_device", "Unknown device", false)
          socket.close()
          return
        }

        if (device.trust_status !== "active") {
          sendAuthError(
            socket,
            `device_${device.trust_status}`,
            `Device trust status is ${device.trust_status}`,
            false
          )
          socket.close()
          return
        }

        if (
          typeof msg.publicKeyFingerprint === "string" &&
          msg.publicKeyFingerprint !== device.public_key_fingerprint
        ) {
          sendAuthError(
            socket,
            "public_key_fingerprint_mismatch",
            "Public key fingerprint mismatch",
            false
          )
          socket.close()
          return
        }

        pendingChallenge = {
          device,
          challenge: crypto.randomUUID(),
          nonce: crypto.randomBytes(32).toString("base64url"),
          protocolVersion: Number.isFinite(msg.protocolVersion)
            ? Number(msg.protocolVersion)
            : RELAY_PROTOCOL_VERSION,
          clientVersion:
            typeof msg.clientVersion === "string" ? msg.clientVersion : null,
        }
        socket.send(
          JSON.stringify({
            type: "auth.challenge",
            deviceId: device.id,
            challenge: pendingChallenge.challenge,
            nonce: pendingChallenge.nonce,
          })
        )
      } catch (error: any) {
        console.error("[Relay Manager] Auth error:", error.message)
        try {
          sendAuthError(
            socket,
            "auth_internal_error",
            "Internal error during authentication",
            true
          )
        } catch {}
        socket.close()
      } finally {
        authInProgress = false
      }
      return
    }

    if (msg.type === "auth.finish") {
      if (authenticated) {
        sendAuthError(
          socket,
          "already_authenticated",
          "Already authenticated",
          false
        )
        return
      }
      if (!pendingChallenge) {
        sendAuthError(
          socket,
          "auth_challenge_missing",
          "No auth challenge in progress",
          true
        )
        socket.close()
        return
      }
      if (
        msg.deviceId !== pendingChallenge.device.id ||
        msg.challenge !== pendingChallenge.challenge
      ) {
        sendAuthError(
          socket,
          "auth_challenge_mismatch",
          "Auth challenge mismatch",
          false
        )
        socket.close()
        return
      }

      try {
        const verified = verifyRelayAuthSignature(
          pendingChallenge.device.public_key,
          pendingChallenge.device.id,
          pendingChallenge.challenge,
          pendingChallenge.nonce,
          typeof msg.signature === "string" ? msg.signature : ""
        )
        if (!verified) {
          sendAuthError(
            socket,
            "invalid_auth_signature",
            "Invalid auth signature",
            false
          )
          socket.close()
          return
        }

        const existing = connectedRelays.get(pendingChallenge.device.id)
        if (existing) {
          if (existing.ws.readyState === 1) {
            sendAuthError(
              socket,
              "device_already_connected",
              "Device already connected",
              true
            )
            socket.close()
            return
          }
          cleanupRelay(pendingChallenge.device.id)
        }

        const sessionId = crypto.randomUUID()
        const sessionResult = await executeSql(
          `INSERT INTO relay_device_sessions (
             device_id, protocol_version, client_version, status, transport, remote_addr, last_heartbeat_at
           )
           VALUES ($1, $2, $3, 'active', 'websocket', $4, NOW())
           RETURNING id`,
          [
            pendingChallenge.device.id,
            pendingChallenge.protocolVersion,
            pendingChallenge.clientVersion,
            typeof _req?.socket?.remoteAddress === "string"
              ? _req.socket.remoteAddress
              : null,
          ]
        )

        deviceId = pendingChallenge.device.id
        authenticated = true

        const connected: ConnectedRelay = {
          deviceId: pendingChallenge.device.id,
          workspaceId: pendingChallenge.device.workspace_id,
          ownerWorkspaceMemberId:
            pendingChallenge.device.owner_workspace_member_id,
          displayName: pendingChallenge.device.display_name,
          sessionRowId: sessionResult.rows[0].id,
          sessionId,
          ws: socket,
          exposures: new Map(),
          heartbeatTimer: null,
          pongTimer: null,
          nextDeliverySeq: 1,
        }
        connectedRelays.set(connected.deviceId, connected)
        await publishRelayRoute(connected)

        await onRelayAuthenticated(connected)

        socket.send(
          JSON.stringify({
            type: "auth_ok",
            protocolVersion: RELAY_PROTOCOL_VERSION,
            deviceId: connected.deviceId,
            sessionId: connected.sessionId,
          })
        )

        connected.heartbeatTimer = setInterval(() => {
          if (socket.readyState !== 1) return
          if (connected.pongTimer) {
            clearTimeout(connected.pongTimer)
            connected.pongTimer = null
          }
          socket.send(
            JSON.stringify({
              type: "ping",
              sessionId: connected.sessionId,
              protocolVersion: RELAY_PROTOCOL_VERSION,
            })
          )
          connected.pongTimer = setTimeout(() => {
            try {
              socket.close()
            } catch {}
            cleanupRelay(connected.deviceId)
          }, 10_000)
        }, RELAY_HEARTBEAT_INTERVAL)
      } catch (error: any) {
        console.error("[Relay Manager] Auth finish error:", error.message)
        try {
          sendAuthError(
            socket,
            "auth_internal_error",
            "Internal error during authentication",
            true
          )
        } catch {}
        socket.close()
      } finally {
        pendingChallenge = null
      }
      return
    }

    if (!authenticated || !deviceId) {
      sendAuthError(socket, "not_authenticated", "Not authenticated", false)
      return
    }

    const connected = connectedRelays.get(deviceId)
    if (!connected) return

    if (msg.type === "pong") {
      if (connected.pongTimer) {
        clearTimeout(connected.pongTimer)
        connected.pongTimer = null
      }
      void publishRelayRoute(connected).catch(() => {})
      void executeSql(
        `UPDATE relay_device_sessions SET last_heartbeat_at = NOW() WHERE id = $1`,
        [connected.sessionRowId]
      ).catch(() => {})
      return
    }

    if (msg.type === "catalog.sync") {
      try {
        const syncSources = normalizeSyncSourceRegistrations(msg)
        const exposures = normalizeExposureRegistrations(msg)
        const error = await syncDeviceCatalog(connected, syncSources, exposures)
        if (error) {
          socket.send(
            JSON.stringify({
              type: "catalog.sync_error",
              code: "catalog_sync_rejected",
              message: error,
              retryable: true,
            })
          )
        } else {
          void redrivePendingRelayOperations(connected)
          socket.send(
            JSON.stringify({
              type: "catalog.synced",
              exposureCount: exposures.length,
            })
          )
        }
      } catch (error: any) {
        console.error("[Relay Manager] catalog sync error:", error.message)
        socket.send(
          JSON.stringify({
            type: "catalog.sync_error",
            code: "catalog_sync_internal_error",
            message: "Internal error during catalog sync",
            retryable: true,
          })
        )
      }
      return
    }

    if (msg.type === "relay.cua.terminate") {
      await handleRelayCUATermination(connected, msg).catch((error: any) => {
        console.error(
          "[Relay Manager] cua termination error:",
          error?.message || String(error)
        )
      })
      return
    }

    if (
      msg.type === "operation.received" &&
      typeof msg.operationId === "string"
    ) {
      await markOperationStatus(msg.operationId, "received")
      await markDeliveryAcknowledged(
        msg.operationId,
        typeof msg.deliveryId === "string" ? msg.deliveryId : undefined
      )
      return
    }

    if (
      msg.type === "operation.started" &&
      typeof msg.operationId === "string"
    ) {
      await markOperationStatus(msg.operationId, "started")
      await markDeliveryAcknowledged(
        msg.operationId,
        typeof msg.deliveryId === "string" ? msg.deliveryId : undefined
      )
      return
    }

    if (
      msg.type === "operation.output" &&
      typeof msg.operationId === "string"
    ) {
      await appendOperationOutput(msg)
      await markDeliveryAcknowledged(
        msg.operationId,
        typeof msg.deliveryId === "string" ? msg.deliveryId : undefined
      )
      return
    }

    if (
      msg.type === "operation.result" &&
      typeof msg.operationId === "string"
    ) {
      await resolveOperationResult(connected, msg)
      return
    }

    if (
      msg.type === "runtime_session.result" &&
      typeof msg.runtimeSessionId === "string"
    ) {
      await resolveRuntimeSessionResult(connected, msg)
      return
    }
  })

  socket.on("close", () => {
    clearTimeout(authTimer)
    if (deviceId) cleanupRelay(deviceId)
  })

  socket.on("error", () => {
    clearTimeout(authTimer)
    if (deviceId) cleanupRelay(deviceId)
  })
}

function resolveRelayOperationTimeoutMs(
  args: Record<string, unknown>,
  fallbackMs: number
) {
  const timeoutSec =
    typeof args.timeout_sec === "number" && Number.isFinite(args.timeout_sec)
      ? Math.max(1, Math.trunc(Number(args.timeout_sec)))
      : null
  if (!timeoutSec) {
    return fallbackMs
  }
  return Math.max(1_000, timeoutSec * 1_000 + 30_000)
}

function buildAsyncRelayBinaryMetadata(params: {
  deviceId: string
  deviceDisplayName: string
  exposureId: string
  exposureStableKey: string
  exposureDisplayName: string
  runtimeSessionId: string
  visibleToolName: string
  namespacedToolName: string
}) {
  return {
    source: {
      kind: "relay_mcp",
      deviceId: params.deviceId,
      deviceDisplayName: params.deviceDisplayName,
      exposureId: params.exposureId,
      exposureStableKey: params.exposureStableKey,
      exposureDisplayName: params.exposureDisplayName,
      runtimeSessionId: params.runtimeSessionId,
      visibleToolName: params.visibleToolName,
      namespacedToolName: params.namespacedToolName,
    },
  }
}

async function validateRelayCallTargetLocal(params: RelayCallParams) {
  if (!params.runtimeSessionId) {
    throw buildRelayExecutionError({
      code: "delivery_rejected",
      message:
        "Relay runtime session is not initialized for this tool instance",
      retryable: true,
    })
  }

  const connected = connectedRelays.get(params.deviceId)
  if (!connected || connected.ws.readyState !== 1) {
    throw buildRelayExecutionError({
      code: "mcp_unavailable",
      message: `Relay device ${params.deviceId} is not connected`,
      retryable: true,
    })
  }

  const exposure = connected.exposures.get(params.exposureId)
  if (!exposure) {
    throw buildRelayExecutionError({
      code: "mcp_unavailable",
      message: `Relay exposure ${params.exposureId} is not available`,
      retryable: true,
    })
  }

  const currentTool = exposure.tools.find(
    (tool) => tool.binding.toolId === params.binding.toolId
  )
  if (!currentTool || currentTool.visible.name !== params.visibleToolName) {
    throw buildRelayExecutionError({
      code: "tool_removed",
      message: `Tool "${params.visibleToolName}" is no longer available`,
      retryable: true,
      requiresReplan: true,
    })
  }

  if (
    currentTool.binding.catalogRevisionId !==
      params.binding.catalogRevisionId ||
    currentTool.binding.toolRevisionId !== params.binding.toolRevisionId
  ) {
    throw buildRelayExecutionError({
      code: "tool_definition_changed",
      message: `Tool "${params.visibleToolName}" changed after planning. Re-read the latest tool definition before retrying.`,
      retryable: true,
      requiresReplan: true,
      currentToolRevisionId: currentTool.binding.toolRevisionId,
    })
  }

  return {
    connected,
    exposure,
    currentTool,
  }
}

function relayAuthorizationGrantToSpec(
  grant: RelayAuthorizationGrantSpec
): RelayAuthorizationGrantSpec {
  // Validate wire shape against the Zod source-of-truth before pushing to the
  // relay. Parse strips unknown fields and rejects malformed policies so the
  // Go end never has to defend against drift. Reuse the parsed object — it's
  // already a deep clone.
  return GrantPolicySchema.parse(grant) as RelayAuthorizationGrantSpec
}

export async function resolveRelayToolAuthorization(params: {
  workspaceId: string
  relayDeviceId: string
  relayCapabilityId: string
  relayExposureId: string
  conversationId?: string | null
  actorId?: string | null
  relayToolStableKey?: string
  relayToolName: string
  toolArguments: Record<string, unknown>
  runtimeSessionId: string
  exposureMetadata: Record<string, unknown>
  authorization?: RelayAuthorizationEnvelope
}) {
  const plan = inferRelaySpecialAuthorizationPlan({
    toolStableKey: params.relayToolStableKey,
    visibleToolName: params.relayToolName,
    toolInput: params.toolArguments,
    exposureMetadata: params.exposureMetadata,
  })
  if (!plan) {
    return {
      authorization: params.authorization,
    }
  }

  const matched = await findMatchingRelayAuthorizationGrant({
    workspaceId: params.workspaceId,
    relayDeviceId: params.relayDeviceId,
    relayCapabilityId: params.relayCapabilityId,
    relayExposureId: params.relayExposureId,
    conversationId: params.conversationId || undefined,
    actorId: params.actorId || undefined,
    retryNonce: params.authorization?.retryNonce,
    requestedAction: plan.requestedAction,
    consumeOnce: true,
  })
  if (!matched.matchedGrant) {
    return {
      authorization: undefined,
      authorizationPlan: plan,
    }
  }

  return {
    authorization: {
      grantIds: [matched.matchedGrant.id],
      grantScope: matched.matchedGrant.scope,
      grantSpecs: [relayAuthorizationGrantToSpec(matched.matchedGrant)],
      retryNonce: params.authorization?.retryNonce,
    } satisfies RelayAuthorizationEnvelope,
    authorizationPlan: plan,
  }
}

function readAsyncRelayRequestAuthorizationMode(
  task: ToolCallTaskRecord | null
): RelayRequestAuthorizationMode {
  return (
    normalizeRelayRequestAuthorizationMode(
      task?.requestPayload?.serverInvokeOptions &&
        typeof task.requestPayload.serverInvokeOptions === "object"
        ? (task.requestPayload.serverInvokeOptions as Record<string, unknown>)
            .requestAuthorization
        : undefined
    ) || "none"
  )
}

async function createAsyncRelayAuthorizationRequestFromLocalDenial(params: {
  operation: RelayTaskOperationRecord
  task: ToolCallTaskRecord
  relayResult: unknown
}) {
  const localDenial = classifyRelayLocalPermissionDenial(params.relayResult)
  if (!localDenial) {
    return null
  }
  if (
    !params.operation.conversation_id ||
    !params.operation.requested_by_session_id ||
    !params.operation.requested_by_actor_id
  ) {
    throw new Error(
      "Async relay authorization request requires a conversation-backed actor task."
    )
  }

  const requestPayload =
    params.task.requestPayload && typeof params.task.requestPayload === "object"
      ? params.task.requestPayload
      : {}
  const relayCapabilityId =
    typeof requestPayload.relayCapabilityId === "string"
      ? requestPayload.relayCapabilityId
      : ""
  if (!relayCapabilityId) {
    throw new Error("Async relay task is missing relay capability metadata.")
  }

  const relayCatalog = await loadRelayExposureCatalogSnapshot(
    params.operation.device_id,
    params.operation.exposure_id
  )
  if (!relayCatalog) {
    throw new Error("The relay exposure is not currently available.")
  }
  const relayTool = relayCatalog.tools.find(
    (tool) => tool.visible.name === params.operation.visible_tool_name
  )
  if (!relayTool) {
    throw new Error("The relay tool definition is no longer available.")
  }

  const toolArguments =
    params.operation.input_payload &&
    typeof params.operation.input_payload === "object" &&
    !Array.isArray(params.operation.input_payload)
      ? (params.operation.input_payload as Record<string, unknown>)
      : {}
  const authorizationPlan = inferRelaySpecialAuthorizationPlan({
    toolStableKey: relayTool.binding.stableKey,
    visibleToolName: params.operation.visible_tool_name,
    toolInput: toolArguments,
    exposureMetadata: relayCatalog.metadata,
  })
  if (!authorizationPlan) {
    throw new Error(
      "Synapse could not infer a relay authorization request for this async tool call."
    )
  }

  return createRelayAuthorizationRequest({
    source: {
      workspaceId: params.operation.workspace_id,
      conversationId: params.operation.conversation_id,
      sessionId: params.operation.requested_by_session_id,
      actorId: params.operation.requested_by_actor_id,
      workspaceMemberId:
        params.operation.requested_by_workspace_member_id || undefined,
      turnId: params.task.turnId,
      sourceToolCallId: params.task.sourceToolCallId,
      sourceToolName:
        params.task.sourceToolName ||
        params.operation.source_tool_name ||
        params.operation.visible_tool_name,
    },
    relayTarget: {
      relayCapabilityId,
      relayDeviceId: params.operation.device_id,
      relayExposureId: params.operation.exposure_id,
      requestedToolName: params.operation.visible_tool_name,
      relayToolStableKey: authorizationPlan.toolStableKey,
      runtimeSessionId: params.operation.runtime_session_id || "",
      relayDeviceDisplayName: params.operation.device_display_name || undefined,
      relayExposureDisplayName:
        params.operation.exposure_display_name || undefined,
    },
    authorizationPlan,
    requestMode: "background",
    availablePresets: ["actor", "conversation", "workspace"],
    reason: localDenial.message?.trim()
      ? `The relay client locally denied ${params.operation.visible_tool_name}. ${localDenial.message.trim()}`
      : `The relay client locally denied ${params.operation.visible_tool_name}, so Synapse is requesting user authorization for the same async action.`,
    sourceRequestArgs: toolArguments,
  })
}

async function insertRelayOperation(params: {
  operationId: string
  workspaceId: string
  conversationId?: string
  sessionId?: string
  requestedByWorkspaceMemberId?: string
  requestedByActorId?: string
  taskId?: string
  deviceId: string
  exposureId: string
  catalogRevisionId: string
  toolId: string
  toolRevisionId: string
  visibleToolName: string
  runtimeSessionId?: string
  deliveryPolicy: "online_only" | "store_and_forward"
  status?: RelayOperationLifecycleStatus
  inputPayload: Record<string, unknown>
  authorizationPayload?: RelayAuthorizationEnvelope
  inputHash: string
  operationTimeoutMs: number
  expiresAt: string | null
}) {
  await executeSql(
    `INSERT INTO relay_operations (
       id,
       workspace_id,
       conversation_id,
       requested_by_session_id,
       requested_by_workspace_member_id,
       requested_by_actor_id,
       task_id,
       device_id,
       exposure_id,
       catalog_revision_id,
       tool_id,
       tool_revision_id,
       visible_tool_name,
       runtime_session_id,
       delivery_policy,
       status,
       input_payload,
       authorization_payload,
       input_hash,
       operation_timeout_ms,
       expires_at,
       created_at,
       updated_at
     )
     VALUES (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10,
       $11,
       $12,
       $13,
       $14,
       $15,
       $16,
       $17::jsonb,
       $18::jsonb,
       $19,
       $20,
       $21,
       NOW(),
       NOW()
     )`,
    [
      params.operationId,
      params.workspaceId,
      params.conversationId || null,
      params.sessionId || null,
      params.requestedByWorkspaceMemberId || null,
      params.requestedByActorId || null,
      params.taskId || null,
      params.deviceId,
      params.exposureId,
      params.catalogRevisionId,
      params.toolId,
      params.toolRevisionId,
      params.visibleToolName,
      params.runtimeSessionId || null,
      params.deliveryPolicy,
      params.status || "created",
      JSON.stringify(params.inputPayload),
      JSON.stringify(params.authorizationPayload || {}),
      params.inputHash,
      params.operationTimeoutMs,
      params.expiresAt,
    ]
  )
}

async function callRelayToolLocal(params: RelayCallParams): Promise<unknown> {
  const { connected, exposure, currentTool } =
    await validateRelayCallTargetLocal(params)
  const authorizationState = await resolveRelayToolAuthorization({
    workspaceId: connected.workspaceId,
    relayDeviceId: params.deviceId,
    relayCapabilityId: params.relayCapabilityId,
    relayExposureId: params.exposureId,
    conversationId: params.conversationId,
    actorId: params.requestedByActorId,
    relayToolStableKey: currentTool.binding.stableKey,
    relayToolName: currentTool.visible.name,
    toolArguments: params.args,
    runtimeSessionId: params.runtimeSessionId,
    exposureMetadata: exposure.metadata,
    authorization: params.authorization,
  })

  const operationId = crypto.randomUUID()
  const inputHash = hashValue(params.args)
  const operationTimeoutMs = Math.min(
    RELAY_TOOL_CALL_TIMEOUT,
    resolveRelayOperationTimeoutMs(params.args, RELAY_OPERATION_TTL_MS)
  )
  const expiresAt = new Date(Date.now() + operationTimeoutMs).toISOString()

  await insertRelayOperation({
    operationId,
    workspaceId: connected.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    requestedByWorkspaceMemberId: params.requestedByWorkspaceMemberId,
    requestedByActorId: params.requestedByActorId,
    deviceId: params.deviceId,
    exposureId: params.exposureId,
    catalogRevisionId: params.binding.catalogRevisionId,
    toolId: params.binding.toolId,
    toolRevisionId: params.binding.toolRevisionId,
    visibleToolName: params.visibleToolName,
    runtimeSessionId: params.runtimeSessionId,
    deliveryPolicy: "online_only",
    inputPayload: params.args,
    authorizationPayload: authorizationState.authorization,
    inputHash,
    operationTimeoutMs,
    expiresAt,
  })

  return new Promise<unknown>((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      const pending = pendingRelayOperations.get(operationId)
      if (!pending) return

      clearPendingRelayOperation(pending)
      pendingRelayOperations.delete(operationId)
      void failOperation(
        operationId,
        "delivery_timed_out",
        `Relay operation timed out after ${operationTimeoutMs}ms`,
        true,
        false
      )
      reject(
        buildRelayExecutionError({
          code: "delivery_timed_out",
          message: `Relay operation timed out after ${operationTimeoutMs}ms`,
          retryable: true,
        })
      )
    }, operationTimeoutMs)

    const pending: PendingRelayOperation = {
      responseMode: "sync",
      operationStatus: "created",
      operationId,
      deviceId: connected.deviceId,
      workspaceId: connected.workspaceId,
      conversationId: params.conversationId || null,
      sessionId: params.sessionId || null,
      actorId: params.requestedByActorId || null,
      workspaceMemberId: params.requestedByWorkspaceMemberId || null,
      exposureId: params.exposureId,
      exposureStableKey: exposure.stableKey,
      runtimeSessionId: params.runtimeSessionId,
      visibleToolName: currentTool.visible.name,
      sourceToolName: params.visibleToolName,
      toolId: params.binding.toolId,
      toolRevisionId: params.binding.toolRevisionId,
      catalogRevisionId: params.binding.catalogRevisionId,
      args: params.args,
      authorization: authorizationState.authorization,
      inputHash,
      taskId: null,
      operationTimeoutMs,
      expiresAt,
      timeoutTimer,
      ackTimer: null,
      relaySessionRowId: null,
      deliverySeq: null,
      deliveryId: null,
      cancelRequested: false,
      cancelReason: null,
      resolve,
      reject,
    }
    pendingRelayOperations.set(operationId, pending)

    void dispatchPendingRelayOperation(connected, pending)
  })
}

async function resolveRelayRoute(
  deviceId: string
): Promise<RelayRouteRecord | null> {
  const connected = connectedRelays.get(deviceId)
  if (connected && connected.ws.readyState === 1) {
    void publishRelayRoute(connected).catch(() => {})
    return {
      deviceId: connected.deviceId,
      nodeId: RELAY_RUNTIME_NODE_ID,
      sessionId: connected.sessionId,
      updatedAt: Date.now(),
    }
  }
  return readRelayRoute(deviceId)
}

export async function callRelayTool(params: RelayCallParams): Promise<unknown> {
  const route = await resolveRelayRoute(params.deviceId)
  if (route?.nodeId && route.nodeId !== RELAY_RUNTIME_NODE_ID) {
    return sendRuntimeCommand<unknown>(route.nodeId, "relay.command", {
      command: "call_tool",
      params,
    } satisfies RelayCommandPayload)
  }
  return callRelayToolLocal(params)
}

async function enqueueRelayToolTaskLocal(
  params: RelayAsyncCallParams
): Promise<{ operationId: string; taskId: string }> {
  const { connected, exposure, currentTool } =
    await validateRelayCallTargetLocal(params)
  const authorizationState = await resolveRelayToolAuthorization({
    workspaceId: params.workspaceId,
    relayDeviceId: params.deviceId,
    relayCapabilityId: params.relayCapabilityId,
    relayExposureId: params.exposureId,
    conversationId: params.conversationId,
    actorId: params.requestedByActorId,
    relayToolStableKey: currentTool.binding.stableKey,
    relayToolName: currentTool.visible.name,
    toolArguments: params.args,
    runtimeSessionId: params.runtimeSessionId,
    exposureMetadata: exposure.metadata,
    authorization: params.authorization,
  })

  const operationId = crypto.randomUUID()
  const inputHash = hashValue(params.args)
  const operationTimeoutMs = resolveRelayOperationTimeoutMs(
    params.args,
    RELAY_OPERATION_TTL_MS
  )
  const expiresAt = new Date(Date.now() + operationTimeoutMs).toISOString()
  const acceptedSummary = `Accepted async ${params.visibleToolName} request. The relay will execute it and wake you with the final result.`

  const created = await transaction(async (client) => {
    const task = await insertToolCallTask(client, {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      actorId: params.requestedByActorId,
      turnId: params.turnId,
      sourceToolCallId: params.sourceToolCallId,
      sourceToolName: params.sourceToolName,
      executorKind: "relay_mcp",
      deliveryPolicy: params.deliveryPolicy,
      status: "working",
      statusMessage: `Queued async ${params.visibleToolName} on the relay.`,
      dispatchStatus: "queued",
      supportsCancel: true,
      supportsOutputTail: true,
      requestPayload: {
        relayCapabilityId: params.relayCapabilityId,
        deviceId: params.deviceId,
        exposureId: params.exposureId,
        runtimeSessionId: params.runtimeSessionId,
        visibleToolName: params.visibleToolName,
        args: params.args,
        serverInvokeOptions: params.serverInvokeOptions || {},
      },
      immediateResultPayload: {
        content: textBlocks(acceptedSummary),
        structuredContent: {
          deferred: true,
          task: {
            status: "working",
            dispatchStatus: "queued",
            statusMessage: `Queued async ${params.visibleToolName} on the relay.`,
          },
        },
        isError: false,
      },
      deadlineAt: expiresAt,
    })

    if (!task) {
      throw new Error("Failed to create relay task")
    }

    await executeSqlOn(
      client,
      `INSERT INTO relay_operations (
         id,
         workspace_id,
         conversation_id,
         requested_by_session_id,
         requested_by_workspace_member_id,
         requested_by_actor_id,
         task_id,
         device_id,
         exposure_id,
         catalog_revision_id,
         tool_id,
         tool_revision_id,
         visible_tool_name,
         runtime_session_id,
         delivery_policy,
         status,
         input_payload,
         authorization_payload,
         input_hash,
         operation_timeout_ms,
         expires_at,
         created_at,
         updated_at
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         'created',
         $16::jsonb,
         $17::jsonb,
         $18,
         $19,
         $20,
         NOW(),
         NOW()
       )`,
      [
        operationId,
        params.workspaceId,
        params.conversationId,
        params.sessionId,
        params.requestedByWorkspaceMemberId || null,
        params.requestedByActorId,
        task.id,
        params.deviceId,
        params.exposureId,
        params.binding.catalogRevisionId,
        params.binding.toolId,
        params.binding.toolRevisionId,
        params.visibleToolName,
        params.runtimeSessionId,
        params.deliveryPolicy,
        JSON.stringify(params.args),
        JSON.stringify(authorizationState.authorization || {}),
        inputHash,
        operationTimeoutMs,
        expiresAt,
      ]
    )

    return task
  })

  const timeoutTimer = setTimeout(() => {
    const pending = pendingRelayOperations.get(operationId)
    if (!pending) return

    if (pending.cancelRequested) {
      void finalizePendingRelayCancellation(
        pending,
        pending.cancelReason?.trim() ||
          `Async ${pending.sourceToolName} was cancelled.`
      )
      return
    }

    clearPendingRelayOperation(pending)
    pendingRelayOperations.delete(operationId)
    void failOperation(
      operationId,
      "delivery_timed_out",
      `Relay operation timed out after ${operationTimeoutMs}ms`,
      true,
      false
    )
    if (pending.taskId) {
      void failToolCallTask(pending.taskId, {
        summary: `Async ${pending.sourceToolName} timed out before the relay returned a result.`,
        finalResultPayload: {
          content: textBlocks(
            `Async ${pending.sourceToolName} timed out before the relay returned a result.`
          ),
          isError: true,
        },
        finalErrorPayload: {
          code: "delivery_timed_out",
          message: `Relay operation timed out after ${operationTimeoutMs}ms`,
          operationId,
        },
      }).catch(() => {})
    }
  }, operationTimeoutMs)

  const pending: PendingRelayOperation = {
    responseMode: "async",
    operationStatus: "created",
    operationId,
    deviceId: connected.deviceId,
    workspaceId: connected.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    actorId: params.requestedByActorId,
    workspaceMemberId: params.requestedByWorkspaceMemberId || null,
    exposureId: params.exposureId,
    exposureStableKey: exposure.stableKey,
    runtimeSessionId: params.runtimeSessionId,
    visibleToolName: currentTool.visible.name,
    sourceToolName: params.sourceToolName,
    toolId: params.binding.toolId,
    toolRevisionId: params.binding.toolRevisionId,
    catalogRevisionId: params.binding.catalogRevisionId,
    args: params.args,
    authorization: authorizationState.authorization,
    inputHash,
    taskId: created.id,
    operationTimeoutMs,
    expiresAt,
    timeoutTimer,
    ackTimer: null,
    relaySessionRowId: null,
    deliverySeq: null,
    deliveryId: null,
    cancelRequested: false,
    cancelReason: null,
  }
  pendingRelayOperations.set(operationId, pending)

  void dispatchPendingRelayOperation(connected, pending)

  return {
    operationId,
    taskId: created.id,
  }
}

export async function enqueueRelayToolTask(
  params: RelayAsyncCallParams
): Promise<{ operationId: string; taskId: string }> {
  const route = await resolveRelayRoute(params.deviceId)
  if (route?.nodeId && route.nodeId !== RELAY_RUNTIME_NODE_ID) {
    return sendRuntimeCommand<{ operationId: string; taskId: string }>(
      route.nodeId,
      "relay.command",
      {
        command: "enqueue_tool_task",
        params,
      } satisfies RelayCommandPayload
    )
  }
  return enqueueRelayToolTaskLocal(params)
}

async function dispatchPendingRelayOperation(
  connected: ConnectedRelay,
  pending: PendingRelayOperation
) {
  try {
    if (pendingRelayOperations.get(pending.operationId) !== pending) {
      return
    }
    if (connected.ws.readyState !== 1) {
      return
    }

    if (pending.cancelRequested) {
      const cancelMessage =
        pending.cancelReason?.trim() ||
        `Async ${pending.sourceToolName} was cancelled before completion.`

      if (pending.operationStatus === "created") {
        await finalizePendingRelayCancellation(pending, cancelMessage)
        return
      }

      sendRelayOperationCancel(connected, pending)
      return
    }

    const exposure = connected.exposures.get(pending.exposureId)
    if (!exposure) {
      await rejectPendingRelayOperation(pending, {
        code: "mcp_unavailable",
        message: `Relay exposure ${pending.exposureId} is not available`,
        retryable: true,
      })
      return
    }

    const currentTool = exposure.tools.find(
      (tool) => tool.binding.toolId === pending.toolId
    )
    if (!currentTool || currentTool.visible.name !== pending.visibleToolName) {
      await rejectPendingRelayOperation(pending, {
        code: "tool_removed",
        message: `Tool "${pending.visibleToolName}" is no longer available`,
        retryable: true,
        requiresReplan: true,
      })
      return
    }

    if (
      currentTool.binding.catalogRevisionId !== pending.catalogRevisionId ||
      currentTool.binding.toolRevisionId !== pending.toolRevisionId
    ) {
      await rejectPendingRelayOperation(pending, {
        code: "tool_definition_changed",
        message: `Tool "${pending.visibleToolName}" changed after planning. Re-read the latest tool definition before retrying.`,
        retryable: true,
        requiresReplan: true,
        currentToolRevisionId: currentTool.binding.toolRevisionId,
      })
      return
    }

    const deliveryId = crypto.randomUUID()
    const deliverySeq = connected.nextDeliverySeq++
    pending.deliveryId = deliveryId
    pending.deliverySeq = deliverySeq
    pending.relaySessionRowId = connected.sessionRowId

    await executeSql(
      `INSERT INTO relay_operation_deliveries (
         operation_id, relay_session_id, delivery_seq, status, metadata
       )
       VALUES ($1, $2, $3, 'queued', $4)`,
      [
        pending.operationId,
        connected.sessionRowId,
        deliverySeq,
        JSON.stringify({ deliveryId }),
      ]
    )

    const payload = {
      exposureId: pending.exposureId,
      exposureStableKey: pending.exposureStableKey,
      runtimeSessionId: pending.runtimeSessionId,
      toolId: pending.toolId,
      toolRevisionId: pending.toolRevisionId,
      toolName: pending.visibleToolName,
      responseMode: pending.responseMode,
      inputHash: pending.inputHash,
      arguments: pending.args,
      authorization: pending.authorization,
      expiresInMs: pending.operationTimeoutMs,
    }

    try {
      connected.ws.send(
        JSON.stringify({
          type: "relay.operation.dispatch",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          sessionId: connected.sessionId,
          operationId: pending.operationId,
          deliveryId,
          payload,
        })
      )
    } catch {
      await markDeliveryStatus(pending.operationId, deliverySeq, "nacked")
      return
    }

    void executeSql(
      `UPDATE relay_operations SET status = 'dispatched', updated_at = NOW() WHERE id = $1`,
      [pending.operationId]
    ).catch(() => {})
    pending.operationStatus = "dispatched"
    if (pending.taskId) {
      void markToolCallTaskDispatched(
        pending.taskId,
        `Dispatched async ${pending.sourceToolName} to the relay client.`
      ).catch(() => {})
    }
    await executeSql(
      `UPDATE relay_operation_deliveries
       SET status = 'sent', sent_at = NOW(), updated_at = NOW()
       WHERE operation_id = $1 AND delivery_seq = $2`,
      [pending.operationId, deliverySeq]
    )

    resetPendingAckTimer(pending)
  } catch (error: any) {
    console.error(
      "[Relay Manager] dispatch pending operation error:",
      error?.message || error
    )
  }
}

function resetPendingAckTimer(pending: PendingRelayOperation) {
  if (pending.ackTimer) {
    clearTimeout(pending.ackTimer)
    pending.ackTimer = null
  }
  const deliverySeq = pending.deliverySeq
  if (deliverySeq === null) {
    return
  }

  pending.ackTimer = setTimeout(() => {
    const current = pendingRelayOperations.get(pending.operationId)
    if (
      !current ||
      current !== pending ||
      current.deliverySeq !== deliverySeq
    ) {
      return
    }

    current.ackTimer = null
    void markDeliveryStatus(current.operationId, deliverySeq, "timed_out")

    const connected = connectedRelays.get(current.deviceId)
    if (!connected || connected.ws.readyState !== 1) {
      return
    }

    void dispatchPendingRelayOperation(connected, current)
  }, RELAY_DELIVERY_ACK_TIMEOUT_MS)
}

async function rejectPendingRelayOperation(
  pending: PendingRelayOperation,
  error: RelayOperationError
) {
  if (pendingRelayOperations.get(pending.operationId) !== pending) {
    return
  }

  clearPendingRelayOperation(pending)
  pendingRelayOperations.delete(pending.operationId)
  await failOperation(
    pending.operationId,
    error.code,
    error.message,
    error.retryable,
    Boolean(error.requiresReplan),
    error.currentToolRevisionId
  )
  if (pending.responseMode === "async" && pending.taskId) {
    await failToolCallTask(pending.taskId, {
      summary: `Async ${pending.sourceToolName} failed before the relay could execute it.`,
      finalResultPayload: {
        content: textBlocks(
          `Async ${pending.sourceToolName} failed before the relay could execute it.`
        ),
        isError: true,
      },
      finalErrorPayload: {
        operationId: pending.operationId,
        ...error,
      },
    })
    return
  }
  pending.reject?.(buildRelayExecutionError(error))
}

function clearPendingRelayOperation(pending: PendingRelayOperation) {
  clearTimeout(pending.timeoutTimer)
  if (pending.ackTimer) {
    clearTimeout(pending.ackTimer)
    pending.ackTimer = null
  }
}

async function markRelayOperationCancelled(
  operationId: string,
  message: string
) {
  await executeSql(
    `UPDATE relay_operations
     SET status = 'cancelled',
         error_code = 'operation_cancelled',
         error_message = $2,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [operationId, message]
  ).catch(() => {})

  await executeSql(
    `UPDATE relay_operation_deliveries
     SET status = CASE
         WHEN status IN ('queued', 'sent', 'nacked') THEN 'cancelled'
         ELSE status
       END,
       updated_at = NOW()
     WHERE operation_id = $1`,
    [operationId]
  ).catch(() => {})

  await executeSql(
    `INSERT INTO relay_operation_results (operation_id, output_payload, output_preview, result_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (operation_id) DO UPDATE SET
       output_payload = EXCLUDED.output_payload,
       output_preview = EXCLUDED.output_preview,
       result_hash = EXCLUDED.result_hash,
       updated_at = NOW()`,
    [
      operationId,
      JSON.stringify({
        error: {
          code: "operation_cancelled",
          message,
          retryable: false,
        },
      }),
      message,
      hashValue({
        code: "operation_cancelled",
        message,
      }),
    ]
  ).catch(() => {})
}

function sendRelayOperationCancel(
  connected: ConnectedRelay,
  pending: PendingRelayOperation
) {
  if (connected.ws.readyState !== 1) {
    return false
  }

  try {
    connected.ws.send(
      JSON.stringify({
        type: "relay.operation.cancel",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        sessionId: connected.sessionId,
        operationId: pending.operationId,
        deliveryId: crypto.randomUUID(),
        reason:
          pending.cancelReason?.trim() ||
          `Cancellation requested for async ${pending.sourceToolName}.`,
      })
    )
    return true
  } catch {
    return false
  }
}

async function finalizePendingRelayCancellation(
  pending: PendingRelayOperation,
  reason: string
) {
  if (pendingRelayOperations.get(pending.operationId) === pending) {
    clearPendingRelayOperation(pending)
    pendingRelayOperations.delete(pending.operationId)
  }

  await markRelayOperationCancelled(pending.operationId, reason)

  if (!pending.taskId) {
    return
  }

  await cancelToolCallTask(pending.taskId, {
    summary: reason,
    finalResultPayload: {
      content: textBlocks(reason),
      isError: true,
    },
    finalErrorPayload: {
      code: "operation_cancelled",
      message: reason,
      operationId: pending.operationId,
    },
    metadata: {
      operationId: pending.operationId,
    },
  }).catch(() => {})
}

async function abortRelayRuntimeSessionOperations(
  runtimeSessionId: string,
  reason: string
) {
  const matches = [...pendingRelayOperations.values()].filter(
    (pending) => pending.runtimeSessionId === runtimeSessionId
  )

  for (const pending of matches) {
    pending.cancelRequested = true
    pending.cancelReason = reason

    if (pending.operationStatus === "created") {
      await finalizePendingRelayCancellation(pending, reason)
      continue
    }

    pending.operationStatus = "cancel_requested"
    await executeSql(
      `UPDATE relay_operations
       SET status = 'cancel_requested',
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('dispatched', 'received', 'started', 'cancel_requested')`,
      [pending.operationId]
    ).catch(() => {})

    const connected = connectedRelays.get(pending.deviceId)
    if (connected) {
      sendRelayOperationCancel(connected, pending)
    }
  }
}

async function enqueueRemoteControlTerminationWakeup(params: {
  sessionId: string
  actorId?: string | null
  workspaceId: string
  summary: string
  reasonText: string
  runtimeSessionId: string
  reason: string
}) {
  const sessionRows = await executeSql<{
    status: string
  }>(
    `SELECT status
     FROM sessions
     WHERE id = $1
     LIMIT 1`,
    [params.sessionId]
  )
  const session = sessionRows.rows[0]
  if (!session || session.status === "closed") {
    return
  }

  // A running session already observes the interrupt through `session_interrupts`
  // and aborts its current turn. Re-enqueueing an extra wakeup here makes the
  // same session immediately continue and can reopen a new CUA overlay after the
  // user explicitly terminated remote control.
  if (session.status === "idle" || session.status === "blocked") {
    await executeSql(
      `INSERT INTO session_wakeups (
         id,
         session_id,
         source_type,
         source_item_id,
         source_session_id,
         source_participant_type,
         source_participant_id,
         source_name,
         summary,
         reason_text,
         status,
         metadata
       )
       VALUES (
         $1,
         $2,
         'system_interrupt',
         NULL,
         NULL,
         'system',
         NULL,
         $3,
         $4,
         $5,
         'pending',
         $6::jsonb
       )`,
      [
        crypto.randomUUID(),
        params.sessionId,
        "Remote desktop control",
        params.summary,
        params.reasonText,
        JSON.stringify({
          runtimeSessionId: params.runtimeSessionId,
          reason: params.reason,
          source: "relay_cua_termination",
        }),
      ]
    ).catch(() => {})

    await executeSql(
      `UPDATE sessions
       SET status = 'queued',
           updated_at = NOW(),
           error_message = NULL
       WHERE id = $1`,
      [params.sessionId]
    ).catch(() => {})

    await sessionThinkingQueue
      .add("think", {
        sessionId: params.sessionId,
        actorId: params.actorId,
        workspaceId: params.workspaceId,
        trigger: "system_interrupt",
      })
      .catch(() => {})
  }
}

async function handleRelayCUATermination(
  connected: ConnectedRelay,
  msg: Record<string, unknown>
) {
  const runtimeSessionId =
    typeof msg.runtimeSessionId === "string" ? msg.runtimeSessionId.trim() : ""
  const reason =
    msg.reason === "boot_disabled" ? "boot_disabled" : "user_terminated"
  if (!runtimeSessionId) {
    return
  }

  const reasonText =
    reason === "boot_disabled"
      ? "User terminated remote desktop control and disabled further CUA control until the next reboot."
      : "User terminated the current remote desktop session."

  await abortRelayRuntimeSessionOperations(runtimeSessionId, reasonText)

  const operationRows = await executeSql<{
    requested_by_session_id: string | null
    requested_by_actor_id: string | null
    workspace_id: string
  }>(
    `SELECT requested_by_session_id, requested_by_actor_id, workspace_id
     FROM relay_operations
     WHERE runtime_session_id = $1
       AND device_id = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [runtimeSessionId, connected.deviceId]
  )
  const operation = operationRows.rows[0]
  if (!operation?.requested_by_session_id) {
    return
  }

  const interruptContent =
    reason === "boot_disabled"
      ? "用户终止了本次远程操作，并禁用了本次开机期间的后续远程控制。请先与用户确认设备状态，并确认任务是否继续。"
      : "用户终止了本次远程操作，请先与用户确认设备状态，并确认任务是否继续。"

  await executeSql(
    `INSERT INTO session_interrupts (
       id,
       target_session_id,
       type,
       content,
       from_session_id
     )
     VALUES ($1, $2, 'remote_control_terminated', $3, NULL)`,
    [crypto.randomUUID(), operation.requested_by_session_id, interruptContent]
  ).catch(() => {})

  await enqueueRemoteControlTerminationWakeup({
    sessionId: operation.requested_by_session_id,
    actorId: operation.requested_by_actor_id,
    workspaceId: operation.workspace_id,
    summary: "Remote desktop control was terminated by the user.",
    reasonText,
    runtimeSessionId,
    reason,
  })
}

function getRelayExposureCatalogLocal(
  deviceId: string,
  exposureId: string
): RelayExposureCatalog | null {
  const connected = connectedRelays.get(deviceId)
  if (!connected) return null

  const exposure = connected.exposures.get(exposureId)
  if (!exposure) return null

  return {
    deviceId: connected.deviceId,
    deviceDisplayName: connected.displayName,
    exposureId: exposure.exposureId,
    exposureStableKey: exposure.stableKey,
    exposureDisplayName: exposure.displayName,
    transport: exposure.transport,
    runtimeStatus: exposure.runtimeStatus,
    metadata: { ...exposure.metadata },
    tools: exposure.tools.map((tool) => ({
      binding: { ...tool.binding },
      visible: {
        stableKey: tool.visible.stableKey,
        name: tool.visible.name,
        description: tool.visible.description,
        inputSchema: tool.visible.inputSchema,
        metadata: {},
      },
      definitionHash: tool.definitionHash,
    })),
  }
}

export async function loadRelayExposureCatalogSnapshot(
  deviceId: string,
  exposureId: string
): Promise<RelayExposureCatalog | null> {
  const local = getRelayExposureCatalogLocal(deviceId, exposureId)
  if (local) {
    return local
  }

  const catalog = await loadExposureCatalog(exposureId)
  if (!catalog) {
    return null
  }
  return {
    deviceId: catalog.deviceId || deviceId,
    deviceDisplayName: catalog.deviceDisplayName || "",
    exposureId: catalog.exposureId,
    exposureStableKey: catalog.stableKey,
    exposureDisplayName: catalog.displayName,
    transport: catalog.transport,
    runtimeStatus: catalog.runtimeStatus,
    metadata: { ...catalog.metadata },
    tools: catalog.tools.map((tool) => ({
      binding: { ...tool.binding },
      visible: {
        stableKey: tool.visible.stableKey,
        name: tool.visible.name,
        description: tool.visible.description,
        inputSchema: tool.visible.inputSchema,
        metadata: {},
      },
      definitionHash: tool.definitionHash,
    })),
  }
}

export async function getConnectedRelaySessionId(
  deviceId: string
): Promise<string | null> {
  const connected = connectedRelays.get(deviceId)
  if (!connected || connected.ws.readyState !== 1) {
    return (await readRelayRoute(deviceId))?.sessionId || null
  }
  void publishRelayRoute(connected).catch(() => {})
  return connected.sessionId
}

function buildRuntimeSessionRequestKey(
  action: "open" | "close",
  runtimeSessionId: string
) {
  return `${action}:${runtimeSessionId}`
}

async function openRelayRuntimeSessionLocal(params: {
  deviceId: string
  exposureId: string
  exposureStableKey: string
}): Promise<string> {
  const connected = connectedRelays.get(params.deviceId)
  if (!connected || connected.ws.readyState !== 1) {
    throw buildRelayExecutionError({
      code: "mcp_unavailable",
      message: `Relay device ${params.deviceId} is not connected`,
      retryable: true,
    })
  }

  const exposure = connected.exposures.get(params.exposureId)
  if (!exposure || exposure.stableKey !== params.exposureStableKey) {
    throw buildRelayExecutionError({
      code: "mcp_unavailable",
      message: `Relay exposure ${params.exposureId} is not available`,
      retryable: true,
    })
  }

  const runtimeSessionId = crypto.randomUUID()
  await dispatchRelayRuntimeSessionRequest({
    action: "open",
    connected,
    runtimeSessionId,
    payload: {
      exposureId: params.exposureId,
      exposureStableKey: params.exposureStableKey,
    },
  })
  return runtimeSessionId
}

async function closeRelayRuntimeSessionLocal(params: {
  deviceId: string
  runtimeSessionId: string
}): Promise<void> {
  if (!params.runtimeSessionId) {
    return
  }

  const connected = connectedRelays.get(params.deviceId)
  if (!connected || connected.ws.readyState !== 1) {
    return
  }

  await dispatchRelayRuntimeSessionRequest({
    action: "close",
    connected,
    runtimeSessionId: params.runtimeSessionId,
  }).catch(() => {})
}

export async function openRelayRuntimeSession(params: {
  deviceId: string
  exposureId: string
  exposureStableKey: string
}): Promise<string> {
  const route = await resolveRelayRoute(params.deviceId)
  if (route?.nodeId && route.nodeId !== RELAY_RUNTIME_NODE_ID) {
    return sendRuntimeCommand<string>(route.nodeId, "relay.command", {
      command: "open_runtime_session",
      deviceId: params.deviceId,
      exposureId: params.exposureId,
      exposureStableKey: params.exposureStableKey,
    } satisfies RelayCommandPayload)
  }
  return openRelayRuntimeSessionLocal(params)
}

export async function closeRelayRuntimeSession(params: {
  deviceId: string
  runtimeSessionId: string
}): Promise<void> {
  const route = await resolveRelayRoute(params.deviceId)
  if (route?.nodeId && route.nodeId !== RELAY_RUNTIME_NODE_ID) {
    await sendRuntimeCommand<void>(route.nodeId, "relay.command", {
      command: "close_runtime_session",
      deviceId: params.deviceId,
      runtimeSessionId: params.runtimeSessionId,
    } satisfies RelayCommandPayload)
    return
  }
  await closeRelayRuntimeSessionLocal(params)
}

async function dispatchRelayRuntimeSessionRequest(params: {
  action: "open" | "close"
  connected: ConnectedRelay
  runtimeSessionId: string
  payload?: {
    exposureId: string
    exposureStableKey: string
  }
}) {
  const pendingKey = buildRuntimeSessionRequestKey(
    params.action,
    params.runtimeSessionId
  )
  if (pendingRelayRuntimeSessionRequests.has(pendingKey)) {
    return new Promise<void>((resolve, reject) => {
      const existing = pendingRelayRuntimeSessionRequests.get(pendingKey)
      if (!existing) {
        resolve()
        return
      }
      const poll = setInterval(() => {
        if (pendingRelayRuntimeSessionRequests.has(pendingKey)) {
          return
        }
        clearInterval(poll)
        resolve()
      }, 50)
      poll.unref?.()
      setTimeout(() => {
        clearInterval(poll)
        reject(
          buildRelayExecutionError({
            code: "delivery_timed_out",
            message: "Relay runtime session request timed out",
            retryable: true,
          })
        )
      }, RELAY_RUNTIME_SESSION_TIMEOUT_MS)
    })
  }

  return new Promise<void>((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      const pending = pendingRelayRuntimeSessionRequests.get(pendingKey)
      if (!pending) {
        return
      }
      pendingRelayRuntimeSessionRequests.delete(pendingKey)
      pending.reject(
        buildRelayExecutionError({
          code: "delivery_timed_out",
          message: "Relay runtime session request timed out",
          retryable: true,
        })
      )
    }, RELAY_RUNTIME_SESSION_TIMEOUT_MS)

    const pending: PendingRelayRuntimeSessionRequest = {
      action: params.action,
      runtimeSessionId: params.runtimeSessionId,
      deviceId: params.connected.deviceId,
      deliveryId: crypto.randomUUID(),
      timeoutTimer,
      resolve,
      reject,
    }
    pendingRelayRuntimeSessionRequests.set(pendingKey, pending)

    try {
      if (params.action === "open") {
        params.connected.ws.send(
          JSON.stringify({
            type: "relay.runtime_session.open",
            protocolVersion: RELAY_PROTOCOL_VERSION,
            sessionId: params.connected.sessionId,
            runtimeSessionId: params.runtimeSessionId,
            deliveryId: pending.deliveryId,
            payload: params.payload,
          })
        )
      } else {
        params.connected.ws.send(
          JSON.stringify({
            type: "relay.runtime_session.close",
            protocolVersion: RELAY_PROTOCOL_VERSION,
            sessionId: params.connected.sessionId,
            runtimeSessionId: params.runtimeSessionId,
            deliveryId: pending.deliveryId,
          })
        )
      }
    } catch (error: any) {
      clearTimeout(timeoutTimer)
      pendingRelayRuntimeSessionRequests.delete(pendingKey)
      reject(
        buildRelayExecutionError({
          code: "delivery_rejected",
          message:
            error?.message ||
            "Failed to dispatch relay runtime session request",
          retryable: true,
        })
      )
    }
  })
}

async function handleRelayCommand(payload: RelayCommandPayload) {
  switch (payload.command) {
    case "open_runtime_session":
      return openRelayRuntimeSessionLocal({
        deviceId: payload.deviceId,
        exposureId: payload.exposureId,
        exposureStableKey: payload.exposureStableKey,
      })
    case "close_runtime_session":
      await closeRelayRuntimeSessionLocal({
        deviceId: payload.deviceId,
        runtimeSessionId: payload.runtimeSessionId,
      })
      return null
    case "call_tool":
      return callRelayToolLocal(payload.params)
    case "enqueue_tool_task":
      return enqueueRelayToolTaskLocal(payload.params)
    default:
      throw new Error(
        `Unsupported relay command '${(payload as { command: string }).command}'`
      )
  }
}

export function disconnectRelay(relayId: string) {
  const connected = connectedRelays.get(relayId)
  if (!connected) return

  try {
    connected.ws.close()
  } catch {}
  cleanupRelay(relayId)
}

export function isRelayConnected(relayId: string): boolean {
  const connected = connectedRelays.get(relayId)
  return Boolean(connected && connected.ws.readyState === 1)
}

export async function initRelayManager() {
  if (!relayCommandHandlersRegistered) {
    registerRuntimeCommandHandler("relay.command", async (payload) =>
      handleRelayCommand(payload as RelayCommandPayload)
    )
    relayCommandHandlersRegistered = true
  }
  await executeSql(
    `UPDATE relay_device_sessions
     SET status = 'closed',
         ended_at = COALESCE(ended_at, NOW()),
         close_reason = COALESCE(close_reason, 'server_restart'),
         updated_at = NOW()
     WHERE status IN ('connecting', 'active', 'closing')`
  )
  await executeSql(
    `UPDATE relay_exposures
     SET runtime_status = 'offline',
         updated_at = NOW()
     WHERE runtime_status IN ('starting', 'healthy', 'degraded')`
  )
  await executeSql(
    `UPDATE relay_devices
     SET automation_lifecycle_grace_until = COALESCE(
           automation_lifecycle_grace_until,
           NOW() + (${RELAY_LIFECYCLE_OFFLINE_GRACE_MS} * INTERVAL '1 millisecond')
         ),
         updated_at = NOW()
     WHERE automation_lifecycle_state = 'online'`
  )
  if (relayLifecycleSweepTimer) {
    clearInterval(relayLifecycleSweepTimer)
  }
  relayLifecycleSweepTimer = setInterval(() => {
    void processDueRelayOfflineLifecycleEvents().catch((error: any) => {
      console.error(
        "[Relay Manager] Failed to process relay lifecycle grace windows:",
        error?.message || error
      )
    })
  }, RELAY_LIFECYCLE_SWEEP_INTERVAL_MS)
  relayLifecycleSweepTimer.unref?.()
  void processDueRelayOfflineLifecycleEvents().catch((error: any) => {
    console.error(
      "[Relay Manager] Failed to process relay lifecycle grace windows:",
      error?.message || error
    )
  })
  console.log("[Relay Manager] Initialized relay v2 runtime")
}

export async function shutdownAllRelays() {
  if (relayLifecycleSweepTimer) {
    clearInterval(relayLifecycleSweepTimer)
    relayLifecycleSweepTimer = null
  }

  for (const connected of connectedRelays.values()) {
    if (connected.heartbeatTimer) clearInterval(connected.heartbeatTimer)
    if (connected.pongTimer) clearTimeout(connected.pongTimer)
    if (connected.ws.readyState === 1) {
      try {
        connected.ws.send(
          JSON.stringify({
            type: "server_shutdown",
            message: "Synapse API server is shutting down",
            retryable: true,
          })
        )
      } catch {}
      try {
        connected.ws.close(1012, "service restart")
      } catch {}
    } else {
      try {
        connected.ws.close()
      } catch {}
    }
  }

  for (const pending of pendingRelayOperations.values()) {
    clearPendingRelayOperation(pending)
    if (pending.responseMode === "async" && pending.taskId) {
      void failToolCallTask(pending.taskId, {
        summary: `Async ${pending.sourceToolName} was interrupted because the server is shutting down.`,
        finalResultPayload: {
          content: textBlocks(
            `Async ${pending.sourceToolName} was interrupted because the server is shutting down.`
          ),
          isError: true,
        },
        finalErrorPayload: {
          code: "delivery_rejected",
          message: "Server shutting down",
          operationId: pending.operationId,
        },
      })
    } else {
      pending.reject?.(new Error("Server shutting down"))
    }
    void failOperation(
      pending.operationId,
      "delivery_rejected",
      "Server shutting down",
      true,
      false
    )
  }

  for (const pending of pendingRelayRuntimeSessionRequests.values()) {
    clearTimeout(pending.timeoutTimer)
    pending.reject(new Error("Server shutting down"))
  }

  const relaySessions = [...connectedRelays.values()].map((connected) => ({
    deviceId: connected.deviceId,
    sessionId: connected.sessionId,
  }))
  const deviceIds = [...connectedRelays.keys()]
  connectedRelays.clear()
  pendingRelayOperations.clear()
  pendingRelayRuntimeSessionRequests.clear()

  if (deviceIds.length > 0) {
    await Promise.allSettled(
      relaySessions.map(({ deviceId, sessionId }) =>
        clearRelayRoute(deviceId, sessionId)
      )
    )
    await executeSql(
      `UPDATE relay_devices
       SET last_seen_at = NOW(),
           automation_lifecycle_grace_until = COALESCE(
             automation_lifecycle_grace_until,
             NOW() + (${RELAY_LIFECYCLE_OFFLINE_GRACE_MS} * INTERVAL '1 millisecond')
           ),
           updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [deviceIds]
    ).catch(() => {})
    await executeSql(
      `UPDATE relay_exposures
       SET runtime_status = 'offline', updated_at = NOW()
       WHERE device_id = ANY($1::uuid[])`,
      [deviceIds]
    ).catch(() => {})
  }
}

async function authenticateRelayDevice(
  deviceId: unknown
): Promise<RelayAuthRow | null> {
  if (typeof deviceId !== "string" || deviceId.trim().length === 0) return null

  const result = await executeSql<RelayAuthRow>(
    `SELECT id, workspace_id, owner_workspace_member_id, title AS display_name, public_key, public_key_fingerprint, trust_status
     FROM relay_devices
     WHERE id = $1
     LIMIT 1`,
    [deviceId]
  )
  return result.rows[0] || null
}

type RelayLifecycleRow = {
  id: string
  workspace_id: string
  display_name: string
  automation_lifecycle_state: "online" | "offline" | null
  automation_lifecycle_grace_until: string | null
}

async function markRelayLifecycleConnected(params: {
  deviceId: string
  displayName: string
}) {
  return transaction(async (client) => {
    const result = await executeSqlOn<RelayLifecycleRow>(
      client,
      `SELECT id, workspace_id, title AS display_name, automation_lifecycle_state, automation_lifecycle_grace_until
       FROM relay_devices
       WHERE id = $1
       FOR UPDATE`,
      [params.deviceId]
    )
    const row = result.rows[0]
    if (!row) return null

    const shouldEmit = row.automation_lifecycle_state !== "online"
    await executeSqlOn(
      client,
      `UPDATE relay_devices
       SET last_seen_at = NOW(),
           last_connected_at = NOW(),
           automation_lifecycle_grace_until = NULL,
           automation_lifecycle_state = CASE WHEN $2 THEN 'online' ELSE automation_lifecycle_state END,
           automation_lifecycle_event_at = CASE WHEN $2 THEN NOW() ELSE automation_lifecycle_event_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [params.deviceId, shouldEmit]
    )

    return {
      shouldEmit,
      workspaceId: row.workspace_id,
      displayName: params.displayName || row.display_name,
    }
  })
}

async function markRelayLifecycleDisconnectPending(params: {
  deviceId: string
}) {
  return transaction(async (client) => {
    const result = await executeSqlOn<RelayLifecycleRow>(
      client,
      `SELECT id, workspace_id, title AS display_name, automation_lifecycle_state
       FROM relay_devices
       WHERE id = $1
       FOR UPDATE`,
      [params.deviceId]
    )
    const row = result.rows[0]
    if (!row) return null

    await executeSqlOn(
      client,
      `UPDATE relay_devices
       SET last_seen_at = NOW(),
           automation_lifecycle_grace_until = NOW() + ($2 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $1`,
      [params.deviceId, RELAY_LIFECYCLE_OFFLINE_GRACE_MS]
    )

    return {
      workspaceId: row.workspace_id,
      displayName: row.display_name,
    }
  })
}

async function flushRelayOfflineLifecycleEvent(deviceId: string) {
  if (connectedRelays.has(deviceId)) {
    await executeSql(
      `UPDATE relay_devices
       SET automation_lifecycle_grace_until = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [deviceId]
    ).catch(() => {})
    return null
  }

  return transaction(async (client) => {
    const result = await executeSqlOn<RelayLifecycleRow>(
      client,
      `SELECT id, workspace_id, display_name, automation_lifecycle_state, automation_lifecycle_grace_until
       FROM relay_devices
       WHERE id = $1
       FOR UPDATE`,
      [deviceId]
    )
    const row = result.rows[0]
    if (!row) return null
    if (connectedRelays.has(deviceId)) {
      await executeSqlOn(
        client,
        `UPDATE relay_devices
         SET automation_lifecycle_grace_until = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [deviceId]
      )
      return null
    }

    if (!row.automation_lifecycle_grace_until) {
      return null
    }
    if (new Date(row.automation_lifecycle_grace_until).getTime() > Date.now()) {
      return null
    }
    if (row.automation_lifecycle_state === "offline") {
      await executeSqlOn(
        client,
        `UPDATE relay_devices
         SET automation_lifecycle_grace_until = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [deviceId]
      )
      return null
    }

    await executeSqlOn(
      client,
      `UPDATE relay_devices
       SET automation_lifecycle_state = 'offline',
           automation_lifecycle_grace_until = NULL,
           automation_lifecycle_event_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [deviceId]
    )

    return {
      workspaceId: row.workspace_id,
      displayName: row.display_name,
    }
  })
}

async function processDueRelayOfflineLifecycleEvents() {
  const result = await executeSql<{ id: string }>(
    `SELECT id
     FROM relay_devices
     WHERE automation_lifecycle_grace_until IS NOT NULL
       AND automation_lifecycle_grace_until <= NOW()
     ORDER BY automation_lifecycle_grace_until ASC
     LIMIT 100`
  )

  for (const row of result.rows) {
    const flushed = await flushRelayOfflineLifecycleEvent(row.id)
    if (!flushed) continue

    void emitRelayLifecycleAutomationEvent({
      workspaceId: flushed.workspaceId,
      deviceId: row.id,
      displayName: flushed.displayName,
      sourceKey: relayDeviceOfflineEventDefinition.definitionKey,
      payload: {
        deviceId: row.id,
        displayName: flushed.displayName,
        status: "offline",
      },
    })
  }
}

async function emitRelayLifecycleAutomationEvent(params: {
  workspaceId: string
  deviceId: string
  displayName: string
  sourceKey: string
  payload: Record<string, unknown>
}) {
  try {
    const result = await ingestAutomationProviderEvent({
      workspaceId: params.workspaceId,
      providerKind: "relay",
      providerRef: params.deviceId,
      sourceKey: params.sourceKey,
      payload: params.payload,
      sourceSnapshot: {
        relayId: params.deviceId,
        relayDisplayName: params.displayName,
      },
      occurredAt: new Date().toISOString(),
    })
    if (!result || result.executions.length === 0) {
      return
    }
    await enqueueAutomationExecutionJobs(
      result.executions.map((execution) => execution.id)
    )
  } catch (error: any) {
    console.error(
      "[Relay Manager] Failed to emit automation relay lifecycle event:",
      error?.message || error
    )
  }
}

async function onRelayAuthenticated(connected: ConnectedRelay) {
  const lifecycle = await markRelayLifecycleConnected({
    deviceId: connected.deviceId,
    displayName: connected.displayName,
  })

  logEvent({
    workspaceId: connected.workspaceId,
    relayId: connected.deviceId,
    eventType: "relay.connected",
    eventData: { deviceId: connected.deviceId },
  })

  emitEvent({
    type: "relay.connected",
    workspaceId: connected.workspaceId,
    payload: { deviceId: connected.deviceId },
    timestamp: new Date().toISOString(),
  })

  if (lifecycle?.shouldEmit) {
    void emitRelayLifecycleAutomationEvent({
      workspaceId: lifecycle.workspaceId,
      deviceId: connected.deviceId,
      displayName: lifecycle.displayName,
      sourceKey: relayDeviceOnlineEventDefinition.definitionKey,
      payload: {
        deviceId: connected.deviceId,
        displayName: lifecycle.displayName,
        status: "online",
      },
    })
  }
}

function normalizeExposureRegistrations(
  msg: Record<string, unknown>
): RelayExposureRegistration[] {
  const rawExposures = Array.isArray(msg.exposures) ? msg.exposures : []

  return rawExposures
    .map((raw, index) => normalizeExposureRegistration(raw, index))
    .filter((item): item is RelayExposureRegistration => Boolean(item))
}

function normalizeExposureRegistration(
  raw: unknown,
  index: number
): RelayExposureRegistration | null {
  if (!isObject(raw)) return null

  const displayName =
    typeof raw.displayName === "string"
      ? raw.displayName.trim()
      : typeof raw.name === "string"
        ? raw.name.trim()
        : ""
  if (!displayName) return null

  const stableKey =
    typeof raw.stableKey === "string" && raw.stableKey.trim().length > 0
      ? raw.stableKey.trim()
      : `legacy:${displayName}`

  const toolsRaw = Array.isArray(raw.tools) ? raw.tools : []
  return {
    stableKey,
    syncSourceKey:
      typeof raw.syncSourceKey === "string" &&
      raw.syncSourceKey.trim().length > 0
        ? raw.syncSourceKey.trim()
        : null,
    displayName,
    transport: normalizeTransport(raw.transport),
    runtimeStatus: normalizeRuntimeStatus(raw.runtimeStatus),
    metadata: asObject(raw.metadata),
    tools: toolsRaw
      .map((tool, toolIndex) => normalizeToolRegistration(tool, toolIndex))
      .filter((tool): tool is RelayToolRegistration => Boolean(tool)),
  }
}

function normalizeSyncSourceRegistrations(
  msg: Record<string, unknown>
): RelaySyncSourceRegistration[] {
  const rawSyncSources = Array.isArray(msg.syncSources) ? msg.syncSources : []

  return rawSyncSources
    .map((raw) => normalizeSyncSourceRegistration(raw))
    .filter((item): item is RelaySyncSourceRegistration => Boolean(item))
}

function normalizeSyncSourceRegistration(
  raw: unknown
): RelaySyncSourceRegistration | null {
  if (!isObject(raw)) return null

  const sourceKey =
    typeof raw.sourceKey === "string" ? raw.sourceKey.trim() : ""
  if (!sourceKey) return null

  return {
    sourceKind: normalizeSyncSourceKind(raw.sourceKind),
    sourceKey,
    configPath:
      typeof raw.configPath === "string" && raw.configPath.trim().length > 0
        ? raw.configPath.trim()
        : null,
    syncMode: normalizeSyncMode(raw.syncMode),
    status: normalizeSyncSourceStatus(raw.status),
    lastSyncedAt:
      typeof raw.lastSyncedAt === "string" && raw.lastSyncedAt.trim().length > 0
        ? raw.lastSyncedAt
        : null,
    lastError:
      typeof raw.lastError === "string" && raw.lastError.trim().length > 0
        ? raw.lastError
        : null,
    metadata: asObject(raw.metadata),
  }
}

function normalizeToolRegistration(
  raw: unknown,
  index: number
): RelayToolRegistration | null {
  if (!isObject(raw)) return null

  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name) return null

  const inputSchema = isObject(raw.inputSchema)
    ? raw.inputSchema
    : isObject(raw.parameters)
      ? {
          type: "object",
          properties: asObject(raw.parameters.properties),
          required: Array.isArray(raw.parameters.required)
            ? raw.parameters.required
            : [],
        }
      : { type: "object", properties: {}, required: [] }

  return {
    stableKey:
      typeof raw.stableKey === "string" && raw.stableKey.trim().length > 0
        ? raw.stableKey.trim()
        : `legacy:${name}:${index}`,
    visible: {
      stableKey:
        typeof raw.stableKey === "string" && raw.stableKey.trim().length > 0
          ? raw.stableKey.trim()
          : `legacy:${name}:${index}`,
      name,
      description: typeof raw.description === "string" ? raw.description : "",
      inputSchema,
    },
    annotations: asObject(raw.annotations),
    metadata: asObject(raw.metadata),
  }
}

function normalizeTransport(
  value: unknown
): RelayExposureRegistration["transport"] {
  if (
    value === "builtin" ||
    value === "http" ||
    value === "sse" ||
    value === "custom"
  )
    return value
  return "stdio"
}

function normalizeRuntimeStatus(
  value: unknown
): RelayExposureRegistration["runtimeStatus"] {
  switch (value) {
    case "starting":
    case "healthy":
    case "degraded":
    case "failed":
    case "quarantined":
    case "offline":
      return value
    default:
      return "healthy"
  }
}

function normalizeSyncSourceKind(
  value: unknown
): RelaySyncSourceRegistration["sourceKind"] {
  switch (value) {
    case "claude_code":
    case "claude_desktop":
    case "codex":
    case "gemini":
    case "opencode":
    case "custom":
      return value
    default:
      return "manual"
  }
}

function normalizeSyncMode(
  value: unknown
): RelaySyncSourceRegistration["syncMode"] {
  switch (value) {
    case "snapshot":
    case "import_only":
    case "detached":
      return "snapshot"
    case "follow":
    case "observe":
    case "mirror":
    case "managed":
      return "follow"
    default:
      return "follow"
  }
}

function normalizeSyncSourceStatus(
  value: unknown
): RelaySyncSourceRegistration["status"] {
  switch (value) {
    case "idle":
    case "syncing":
    case "error":
    case "disabled":
      return value
    default:
      return "unknown"
  }
}

async function syncDeviceCatalog(
  connected: ConnectedRelay,
  syncSources: RelaySyncSourceRegistration[],
  exposures: RelayExposureRegistration[]
): Promise<string | null> {
  for (const exposure of exposures) {
    if (exposure.displayName.includes("__")) {
      return `Exposure name "${exposure.displayName}" must not contain "__"`
    }
    for (const tool of exposure.tools) {
      if (tool.visible.name.includes("__")) {
        return `Tool name "${tool.visible.name}" must not contain "__"`
      }
    }
  }

  const activeExposureIds = new Set<string>()
  const syncSourceIds = await syncRelaySyncSources(
    connected.deviceId,
    syncSources
  )

  for (const registration of exposures) {
    const exposureRow = await upsertExposure(
      connected.deviceId,
      registration,
      registration.syncSourceKey
        ? syncSourceIds.get(registration.syncSourceKey) || null
        : null
    )
    activeExposureIds.add(exposureRow.id)

    await syncExposureCatalog(exposureRow.id, connected.deviceId, registration)
    await touchRelayExposureAccessState({
      workspaceId: connected.workspaceId,
      deviceId: connected.deviceId,
      exposureId: exposureRow.id,
    })
    const runtimeCatalog = await loadExposureCatalog(exposureRow.id)
    if (runtimeCatalog && isRuntimeAvailable(registration.runtimeStatus)) {
      connected.exposures.set(exposureRow.id, runtimeCatalog)
    } else {
      connected.exposures.delete(exposureRow.id)
    }
  }

  await markMissingExposuresOffline(connected.deviceId, activeExposureIds)
  for (const exposureId of [...connected.exposures.keys()]) {
    if (!activeExposureIds.has(exposureId)) {
      connected.exposures.delete(exposureId)
    }
  }
  await incrementMcpVersion(connected.workspaceId)

  emitEvent({
    type: "relay.servers_updated",
    workspaceId: connected.workspaceId,
    payload: { deviceId: connected.deviceId, exposureCount: exposures.length },
    timestamp: new Date().toISOString(),
  })

  logEvent({
    workspaceId: connected.workspaceId,
    relayId: connected.deviceId,
    eventType: "relay.catalog_synced",
    eventData: {
      deviceId: connected.deviceId,
      syncSourceCount: syncSources.length,
      exposureCount: exposures.length,
      exposureNames: exposures.map((exposure) => exposure.displayName),
    },
  })

  return null
}

async function upsertExposure(
  deviceId: string,
  exposure: RelayExposureRegistration,
  syncSourceId: string | null
) {
  const result = await executeSql(
    `INSERT INTO relay_exposures (
       device_id, sync_source_id, stable_key, display_name, transport, runtime_status,
       last_seen_at, last_healthy_at, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), CASE WHEN $7 IN ('healthy', 'degraded') THEN NOW() ELSE NULL END, $8)
     ON CONFLICT (device_id, stable_key) DO UPDATE SET
       sync_source_id = EXCLUDED.sync_source_id,
       display_name = EXCLUDED.display_name,
       transport = EXCLUDED.transport,
       runtime_status = EXCLUDED.runtime_status,
       last_seen_at = NOW(),
       last_healthy_at = CASE
         WHEN EXCLUDED.runtime_status IN ('healthy', 'degraded') THEN NOW()
         ELSE relay_exposures.last_healthy_at
       END,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      deviceId,
      syncSourceId,
      exposure.stableKey,
      exposure.displayName,
      exposure.transport,
      exposure.runtimeStatus,
      exposure.runtimeStatus,
      JSON.stringify(exposure.metadata),
    ]
  )
  return result.rows[0]
}

async function syncRelaySyncSources(
  deviceId: string,
  syncSources: RelaySyncSourceRegistration[]
) {
  const bySourceKey = new Map<string, string>()

  for (const source of syncSources) {
    const lastSyncedAt =
      typeof source.lastSyncedAt === "string" &&
      source.lastSyncedAt.trim().length > 0
        ? source.lastSyncedAt.trim()
        : null
    const result = await executeSql(
      `INSERT INTO relay_sync_sources (
         device_id, source_kind, source_key, config_path, sync_mode, status,
         last_synced_at, last_error
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         COALESCE($7::timestamptz, NOW()),
         $8
       )
       ON CONFLICT (device_id, source_key) DO UPDATE SET
         source_kind = EXCLUDED.source_kind,
         config_path = EXCLUDED.config_path,
         sync_mode = EXCLUDED.sync_mode,
         status = EXCLUDED.status,
         last_synced_at = EXCLUDED.last_synced_at,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()
       RETURNING id`,
      [
        deviceId,
        source.sourceKind,
        source.sourceKey,
        source.configPath,
        source.syncMode,
        source.status,
        lastSyncedAt,
        source.lastError,
      ]
    )
    bySourceKey.set(source.sourceKey, result.rows[0].id as string)
  }

  const activeKeys = syncSources.map((source) => source.sourceKey)
  if (activeKeys.length > 0) {
    await executeSql(
      `DELETE FROM relay_sync_sources
       WHERE device_id = $1
         AND source_key != ALL($2)`,
      [deviceId, activeKeys]
    )
  } else {
    await executeSql(
      `DELETE FROM relay_sync_sources
       WHERE device_id = $1`,
      [deviceId]
    )
  }

  return bySourceKey
}

async function syncExposureCatalog(
  exposureId: string,
  deviceId: string,
  exposure: RelayExposureRegistration
) {
  const normalizedTools = [...exposure.tools].sort((left, right) =>
    left.stableKey.localeCompare(right.stableKey)
  )
  const schemaHash = hashValue(
    normalizedTools.map((tool) => ({
      stableKey: tool.stableKey,
      visible: tool.visible,
      annotations: tool.annotations,
    }))
  )

  const activeCatalogResult = await executeSql(
    `SELECT id, revision_seq, schema_hash
     FROM relay_catalog_revisions
     WHERE exposure_id = $1 AND status = 'active'
     ORDER BY revision_seq DESC
     LIMIT 1`,
    [exposureId]
  )
  const activeCatalog = activeCatalogResult.rows[0] || null

  let revisionSeq = activeCatalog ? Number(activeCatalog.revision_seq) : 0
  let catalogRevisionId = activeCatalog?.id as string | undefined

  if (!activeCatalog || activeCatalog.schema_hash !== schemaHash) {
    const nextSeq = revisionSeq + 1
    if (activeCatalog) {
      await executeSql(
        `UPDATE relay_catalog_revisions
         SET status = 'superseded', invalidated_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [activeCatalog.id]
      )
    }

    const catalogInsert = await executeSql(
      `INSERT INTO relay_catalog_revisions (exposure_id, revision_seq, schema_hash, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id`,
      [exposureId, nextSeq, schemaHash]
    )

    revisionSeq = nextSeq
    catalogRevisionId = catalogInsert.rows[0].id

    const existingTools = await executeSql(
      `SELECT id, stable_key
       FROM relay_tools
       WHERE exposure_id = $1`,
      [exposureId]
    )
    const existingToolIds = new Map(
      existingTools.rows.map((row) => [
        row.stable_key as string,
        row.id as string,
      ])
    )

    for (const tool of normalizedTools) {
      const toolResult = await executeSql(
        `INSERT INTO relay_tools (
           exposure_id, stable_key, current_name, status, first_seen_at, last_seen_at, metadata
         )
         VALUES ($1, $2, $3, 'active', NOW(), NOW(), $4)
         ON CONFLICT (exposure_id, stable_key) DO UPDATE SET
           current_name = EXCLUDED.current_name,
           status = 'active',
           last_seen_at = NOW(),
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id`,
        [
          exposureId,
          tool.stableKey,
          tool.visible.name,
          JSON.stringify(tool.metadata),
        ]
      )
      const toolId =
        toolResult.rows[0]?.id || existingToolIds.get(tool.stableKey)
      const toolRevisionResult = await executeSql(
        `INSERT INTO relay_tool_revisions (
           tool_id, catalog_revision_id, tool_name, description, input_schema, annotations, definition_hash
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          toolId,
          catalogRevisionId,
          tool.visible.name,
          tool.visible.description,
          JSON.stringify(tool.visible.inputSchema),
          JSON.stringify(tool.annotations),
          hashValue({
            visible: tool.visible,
            annotations: tool.annotations,
          }),
        ]
      )
      await executeSql(
        `UPDATE relay_tools
         SET latest_revision_id = $2,
             current_name = $3,
             status = 'active',
             last_seen_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [toolId, toolRevisionResult.rows[0].id, tool.visible.name]
      )
    }

    const activeStableKeys = normalizedTools.map((tool) => tool.stableKey)
    if (activeStableKeys.length > 0) {
      await executeSql(
        `UPDATE relay_tools
         SET status = 'removed', updated_at = NOW()
         WHERE exposure_id = $1
           AND stable_key != ALL($2)`,
        [exposureId, activeStableKeys]
      )
    } else {
      await executeSql(
        `UPDATE relay_tools
         SET status = 'removed', updated_at = NOW()
         WHERE exposure_id = $1`,
        [exposureId]
      )
    }

    await executeSql(
      `UPDATE relay_devices
       SET last_catalog_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [deviceId]
    )
  }

  return { catalogRevisionId, revisionSeq }
}

async function loadExposureCatalog(
  exposureId: string
): Promise<ConnectedRelayExposure | null> {
  const result = await executeSql(
    `SELECT
        d.id AS device_id,
        d.title AS device_display_name,
        e.id AS exposure_id,
        e.stable_key AS exposure_stable_key,
        e.display_name AS exposure_display_name,
        e.transport AS exposure_transport,
        e.runtime_status AS exposure_runtime_status,
        e.metadata AS exposure_metadata,
        t.id AS tool_id,
        t.stable_key AS tool_stable_key,
        tr.id AS tool_revision_id,
        tr.catalog_revision_id,
        tr.tool_name,
        tr.description,
        tr.input_schema,
        tr.annotations,
        tr.definition_hash
     FROM relay_exposures e
     JOIN relay_devices d
       ON d.id = e.device_id
     LEFT JOIN relay_tools t
       ON t.exposure_id = e.id
      AND t.status = 'active'
     LEFT JOIN relay_tool_revisions tr
       ON tr.id = t.latest_revision_id
     WHERE e.id = $1
     ORDER BY tr.tool_name ASC NULLS LAST`,
    [exposureId]
  )

  if (result.rows.length === 0) return null

  const first = result.rows[0]
  const tools: RelayCatalogToolSnapshot[] = result.rows
    .filter((row) => row.tool_id && row.tool_revision_id)
    .map((row) => ({
      binding: {
        exposureId: row.exposure_id,
        catalogRevisionId: row.catalog_revision_id,
        toolId: row.tool_id,
        toolRevisionId: row.tool_revision_id,
        stableKey: row.tool_stable_key,
      },
      visible: {
        stableKey: row.tool_stable_key,
        name: row.tool_name,
        description: row.description || "",
        inputSchema: asObject(row.input_schema),
        metadata: {},
      },
      definitionHash: row.definition_hash,
    }))

  return {
    deviceId: first.device_id,
    deviceDisplayName: first.device_display_name,
    exposureId: first.exposure_id,
    stableKey: first.exposure_stable_key,
    displayName: first.exposure_display_name,
    transport: first.exposure_transport,
    runtimeStatus: first.exposure_runtime_status,
    metadata: asObject(first.exposure_metadata),
    tools,
  }
}

async function markMissingExposuresOffline(
  deviceId: string,
  activeExposureIds: Set<string>
) {
  const ids = [...activeExposureIds]
  if (ids.length > 0) {
    await executeSql(
      `UPDATE relay_exposures
       SET runtime_status = 'offline',
           updated_at = NOW()
       WHERE device_id = $1
         AND id != ALL($2)`,
      [deviceId, ids]
    )
    return
  }

  await executeSql(
    `UPDATE relay_exposures
     SET runtime_status = 'offline',
         updated_at = NOW()
     WHERE device_id = $1`,
    [deviceId]
  )
}

type RelayTaskOperationRecord = {
  operation_id: string
  status: RelayOperationLifecycleStatus
  workspace_id: string
  conversation_id: string | null
  requested_by_session_id: string | null
  requested_by_workspace_member_id: string | null
  requested_by_actor_id: string | null
  task_id: string | null
  device_id: string
  device_display_name: string | null
  exposure_id: string
  exposure_stable_key: string | null
  exposure_display_name: string | null
  runtime_session_id: string | null
  visible_tool_name: string
  tool_id: string
  tool_revision_id: string
  catalog_revision_id: string
  input_payload: unknown
  authorization_payload: unknown
  input_hash: string
  operation_timeout_ms: number | null
  expires_at: string | null
  source_tool_name: string | null
  cancel_reason: string | null
}

async function loadAsyncRelayOperationRecord(operationId: string) {
  const result = await executeSql<RelayTaskOperationRecord>(
    `SELECT
       ro.id AS operation_id,
       ro.status,
       ro.workspace_id,
       ro.conversation_id,
       ro.requested_by_session_id,
       ro.requested_by_workspace_member_id,
       ro.requested_by_actor_id,
       ro.task_id,
       ro.device_id,
       device.title AS device_display_name,
       ro.exposure_id,
       exposure.stable_key AS exposure_stable_key,
       exposure.display_name AS exposure_display_name,
       ro.runtime_session_id,
       ro.visible_tool_name,
       ro.tool_id,
       ro.tool_revision_id,
       ro.catalog_revision_id,
       ro.input_payload,
       ro.authorization_payload,
       ro.input_hash,
       ro.operation_timeout_ms,
       ro.expires_at,
       task.source_tool_name,
       task.cancel_reason
     FROM relay_operations ro
     LEFT JOIN relay_devices device
       ON device.id = ro.device_id
     LEFT JOIN relay_exposures exposure
       ON exposure.id = ro.exposure_id
     LEFT JOIN tool_call_tasks task
       ON task.id = ro.task_id
     WHERE ro.id = $1
     LIMIT 1`,
    [operationId]
  )

  return result.rows[0] || null
}

async function loadRelayOperationByTaskId(taskId: string) {
  const result = await executeSql<RelayTaskOperationRecord>(
    `SELECT
       ro.id AS operation_id,
       ro.status,
       ro.workspace_id,
       ro.conversation_id,
       ro.requested_by_session_id,
       ro.requested_by_workspace_member_id,
       ro.requested_by_actor_id,
       ro.task_id,
       ro.device_id,
       device.title AS device_display_name,
       ro.exposure_id,
       exposure.stable_key AS exposure_stable_key,
       exposure.display_name AS exposure_display_name,
       ro.runtime_session_id,
       ro.visible_tool_name,
       ro.tool_id,
       ro.tool_revision_id,
       ro.catalog_revision_id,
       ro.input_payload,
       ro.authorization_payload,
       ro.input_hash,
       ro.operation_timeout_ms,
       ro.expires_at,
       task.source_tool_name,
       task.cancel_reason
     FROM relay_operations ro
     LEFT JOIN relay_devices device
       ON device.id = ro.device_id
     LEFT JOIN relay_exposures exposure
       ON exposure.id = ro.exposure_id
     LEFT JOIN tool_call_tasks task
       ON task.id = ro.task_id
     WHERE ro.task_id = $1
     ORDER BY ro.created_at DESC
     LIMIT 1`,
    [taskId]
  )

  return result.rows[0] || null
}

export async function cancelRelayToolTask(taskId: string, reason?: string) {
  const task = await getToolCallTask(taskId)
  if (!task) {
    throw new Error(`Tool-call task ${taskId} not found`)
  }
  if (task.executorKind !== "relay_mcp") {
    throw new Error(`Tool-call task ${taskId} is not a relay task`)
  }
  if (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  ) {
    return task
  }

  const operation = await loadRelayOperationByTaskId(taskId)
  if (!operation) {
    throw new Error(`Relay operation for task ${taskId} not found`)
  }

  const cancelMessage =
    reason?.trim() ||
    task.cancelReason?.trim() ||
    `Cancellation requested for async ${task.sourceToolName}.`

  if (operation.status === "cancelled") {
    return cancelToolCallTask(taskId, {
      summary: cancelMessage,
      finalResultPayload: {
        content: textBlocks(cancelMessage),
        isError: true,
      },
      finalErrorPayload: {
        code: "operation_cancelled",
        message: cancelMessage,
        operationId: operation.operation_id,
      },
      metadata: {
        operationId: operation.operation_id,
      },
    })
  }

  if (
    operation.status === "completed" ||
    operation.status === "failed" ||
    operation.status === "aborted" ||
    operation.status === "expired"
  ) {
    return getToolCallTask(taskId)
  }

  if (operation.status === "created") {
    const pending = pendingRelayOperations.get(operation.operation_id)
    if (pending) {
      pending.cancelRequested = true
      pending.cancelReason = cancelMessage
      pending.operationStatus = "created"
      await requestToolCallTaskCancel(taskId, cancelMessage)
      await finalizePendingRelayCancellation(pending, cancelMessage)
      return getToolCallTask(taskId)
    }

    await requestToolCallTaskCancel(taskId, cancelMessage)
    await markRelayOperationCancelled(operation.operation_id, cancelMessage)
    return cancelToolCallTask(taskId, {
      summary: cancelMessage,
      finalResultPayload: {
        content: textBlocks(cancelMessage),
        isError: true,
      },
      finalErrorPayload: {
        code: "operation_cancelled",
        message: cancelMessage,
        operationId: operation.operation_id,
      },
      metadata: {
        operationId: operation.operation_id,
      },
    })
  }

  await requestToolCallTaskCancel(taskId, cancelMessage)
  await executeSql(
    `UPDATE relay_operations
     SET status = 'cancel_requested',
         updated_at = NOW()
     WHERE id = $1
       AND status IN ('dispatched', 'received', 'started', 'cancel_requested')`,
    [operation.operation_id]
  )

  const pending = pendingRelayOperations.get(operation.operation_id)
  if (pending) {
    pending.cancelRequested = true
    pending.cancelReason = cancelMessage
    pending.operationStatus = "cancel_requested"

    const connected = connectedRelays.get(pending.deviceId)
    if (connected) {
      sendRelayOperationCancel(connected, pending)
    }
    return getToolCallTask(taskId)
  }

  const connected = connectedRelays.get(operation.device_id)
  if (connected?.ws.readyState === 1) {
    try {
      connected.ws.send(
        JSON.stringify({
          type: "relay.operation.cancel",
          protocolVersion: RELAY_PROTOCOL_VERSION,
          sessionId: connected.sessionId,
          operationId: operation.operation_id,
          deliveryId: crypto.randomUUID(),
          reason: cancelMessage,
        })
      )
    } catch {}
  }

  await markToolCallTaskCancelRequested(taskId, cancelMessage, {
    operationId: operation.operation_id,
  }).catch(() => {})

  return getToolCallTask(taskId)
}

async function appendOperationOutput(msg: Record<string, unknown>) {
  const operationId = msg.operationId as string
  const operation = await loadAsyncRelayOperationRecord(operationId)
  if (!operation?.task_id) {
    return
  }

  const seq = Number(msg.seq || 0)
  const stream =
    msg.stream === "stderr" || msg.stream === "system" ? msg.stream : "stdout"
  const text = typeof msg.text === "string" ? msg.text : ""
  if (!text.trim() || !Number.isFinite(seq) || seq <= 0) {
    return
  }

  await appendToolCallTaskOutput(operation.task_id, {
    seq,
    stream,
    text,
    createdAt:
      typeof msg.createdAt === "string"
        ? msg.createdAt
        : new Date().toISOString(),
    metadata: {
      operationId,
    },
  }).catch(() => {})
}

async function finalizeAsyncRelayOperation(
  operation: RelayTaskOperationRecord,
  msg: Record<string, unknown>
) {
  const taskId = operation.task_id
  if (!taskId) {
    return
  }

  const namespacedToolName =
    operation.source_tool_name || operation.visible_tool_name
  const isTransportError = msg.success === false || Boolean(msg.error)
  if (isTransportError) {
    const error = normalizeOperationError(msg.error)
    const summary = `Async ${namespacedToolName} failed before the relay returned a usable result.`
    await failToolCallTask(taskId, {
      summary,
      finalResultPayload: {
        content: textBlocks(summary),
        isError: true,
      },
      finalErrorPayload: {
        operationId: operation.operation_id,
        ...error,
      },
      metadata: {
        operationId: operation.operation_id,
      },
    })
    return
  }

  const normalizedResult = await normalizeMcpToolResult(
    msg.result,
    operation.workspace_id,
    {
      binaryMetadata:
        operation.runtime_session_id && operation.exposure_stable_key
          ? buildAsyncRelayBinaryMetadata({
              deviceId: operation.device_id,
              deviceDisplayName:
                operation.device_display_name || "Relay device",
              exposureId: operation.exposure_id,
              exposureStableKey: operation.exposure_stable_key,
              exposureDisplayName:
                operation.exposure_display_name || "Relay exposure",
              runtimeSessionId: operation.runtime_session_id,
              visibleToolName: operation.visible_tool_name,
              namespacedToolName,
            })
          : undefined,
    }
  )

  if (normalizedResult.isError) {
    const task = await getToolCallTask(taskId)
    const requestAuthorizationMode =
      readAsyncRelayRequestAuthorizationMode(task)
    const localDenial = classifyRelayLocalPermissionDenial(msg.result)

    if (task && requestAuthorizationMode === "background" && localDenial) {
      try {
        const created =
          await createAsyncRelayAuthorizationRequestFromLocalDenial({
            operation,
            task,
            relayResult: msg.result,
          })
        if (created) {
          const summary = `Async ${namespacedToolName} was denied by the relay client's local permissions. Synapse created a background authorization request and failed the original async task.`
          await failToolCallTask(taskId, {
            summary,
            finalResultPayload: {
              content: textBlocks(summary),
              structuredContent: {
                code: "relay_authorization_requested",
                requestMode: "background",
                interactionId: created.interaction.id,
                executed: false,
                relayToolName: operation.visible_tool_name,
                originalStructuredContent: localDenial.structuredContent,
              },
              isError: true,
            },
            finalErrorPayload: {
              operationId: operation.operation_id,
              relayResult: msg.result ?? {},
              interactionId: created.interaction.id,
            },
            metadata: {
              operationId: operation.operation_id,
              interactionId: created.interaction.id,
            },
          })
          return
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to create a relay authorization request."
        const summary = `Async ${namespacedToolName} was denied by the relay client's local permissions, and Synapse failed to create a background authorization request.`
        await failToolCallTask(taskId, {
          summary,
          finalResultPayload: {
            content: textBlocks(summary),
            structuredContent: {
              code: "relay_authorization_request_failed",
              requestMode: "background",
              executed: false,
              relayToolName: operation.visible_tool_name,
              originalStructuredContent: localDenial.structuredContent,
              requestError: message,
            },
            isError: true,
          },
          finalErrorPayload: {
            operationId: operation.operation_id,
            relayResult: msg.result ?? {},
            requestError: message,
          },
          metadata: {
            operationId: operation.operation_id,
          },
        })
        return
      }
    }

    await failToolCallTask(taskId, {
      summary: `Async ${namespacedToolName} completed with an error.`,
      messageBlocks: normalizedResult.content,
      finalResultPayload: {
        content: normalizedResult.content,
        structuredContent:
          normalizedResult.structuredContent &&
          typeof normalizedResult.structuredContent === "object"
            ? normalizedResult.structuredContent
            : undefined,
        metadata:
          normalizedResult.metadata &&
          typeof normalizedResult.metadata === "object"
            ? normalizedResult.metadata
            : undefined,
        isError: true,
      },
      finalErrorPayload: {
        operationId: operation.operation_id,
        relayResult: msg.result ?? {},
      },
      metadata: {
        operationId: operation.operation_id,
      },
    })
    return
  }

  await completeToolCallTask(taskId, {
    summary: `Async ${namespacedToolName} completed.`,
    messageBlocks: normalizedResult.content,
    finalResultPayload: {
      content: normalizedResult.content,
      structuredContent:
        normalizedResult.structuredContent &&
        typeof normalizedResult.structuredContent === "object"
          ? normalizedResult.structuredContent
          : undefined,
      metadata:
        normalizedResult.metadata &&
        typeof normalizedResult.metadata === "object"
          ? normalizedResult.metadata
          : undefined,
      rawResult:
        normalizedResult.rawResult &&
        typeof normalizedResult.rawResult === "object"
          ? normalizedResult.rawResult
          : undefined,
      isError: false,
    },
    metadata: {
      operationId: operation.operation_id,
      preview: extractText(normalizedResult.content).slice(0, 280),
    },
  })
}

async function resolveOperationResult(
  connected: ConnectedRelay,
  msg: Record<string, unknown>
) {
  const operationId = msg.operationId as string
  const pending = pendingRelayOperations.get(operationId)
  if (pending && pending.deviceId === connected.deviceId) {
    clearPendingRelayOperation(pending)
    pendingRelayOperations.delete(operationId)
  }

  const operation = await loadAsyncRelayOperationRecord(operationId)
  if (!operation || operation.device_id !== connected.deviceId) {
    return
  }

  const namespacedToolName =
    operation.source_tool_name || operation.visible_tool_name
  const cancellationMessage =
    operation.cancel_reason?.trim() ||
    `Async ${namespacedToolName} was cancelled.`

  if (operation.status === "cancel_requested") {
    await markRelayOperationCancelled(operationId, cancellationMessage)
    if (pending?.responseMode === "sync") {
      pending.reject?.(
        buildRelayExecutionError({
          code: "operation_cancelled" as RelayOperationError["code"],
          message: cancellationMessage,
          retryable: false,
        })
      )
    }
    if (operation.task_id) {
      await cancelToolCallTask(operation.task_id, {
        summary: cancellationMessage,
        finalResultPayload: {
          content: textBlocks(cancellationMessage),
          isError: true,
        },
        finalErrorPayload: {
          operationId,
          code: "operation_cancelled",
          message: cancellationMessage,
        },
        metadata: {
          operationId,
          lateResultIgnored: true,
        },
      })
    }
    return
  }

  const isError = msg.success === false || Boolean(msg.error)
  if (isError) {
    const error = normalizeOperationError(msg.error)
    if (String(error.code) === "operation_cancelled") {
      await markRelayOperationCancelled(operationId, error.message)
      if (pending?.responseMode === "sync") {
        pending.reject?.(buildRelayExecutionError(error))
      }
      if (operation.task_id) {
        await cancelToolCallTask(operation.task_id, {
          summary: `Async ${namespacedToolName} was cancelled.`,
          finalResultPayload: {
            content: textBlocks(`Async ${namespacedToolName} was cancelled.`),
            isError: true,
          },
          finalErrorPayload: {
            operationId,
            code: error.code,
            message: error.message,
          },
          metadata: {
            operationId,
          },
        })
      }
      return
    }

    await failOperation(
      operationId,
      error.code,
      error.message,
      error.retryable,
      Boolean(error.requiresReplan),
      error.currentToolRevisionId
    )
    if (pending?.responseMode === "sync") {
      pending.reject?.(buildRelayExecutionError(error))
    }
    await finalizeAsyncRelayOperation(operation, msg)
    return
  }

  await executeSql(
    `UPDATE relay_operations
     SET status = 'completed',
         completed_at = NOW(),
         result_hash = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [operationId, hashValue(msg.result)]
  )

  await executeSql(
    `INSERT INTO relay_operation_results (operation_id, output_payload, output_preview, result_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (operation_id) DO UPDATE SET
       output_payload = EXCLUDED.output_payload,
       output_preview = EXCLUDED.output_preview,
       result_hash = EXCLUDED.result_hash,
       updated_at = NOW()`,
    [
      operationId,
      JSON.stringify(msg.result ?? {}),
      previewValue(msg.result),
      hashValue(msg.result),
    ]
  )

  await executeSql(
    `UPDATE relay_operation_deliveries
     SET status = 'acked', acknowledged_at = NOW(), updated_at = NOW()
     WHERE operation_id = $1
       AND ($2::text IS NULL OR metadata->>'deliveryId' = $2)`,
    [operationId, typeof msg.deliveryId === "string" ? msg.deliveryId : null]
  )

  if (pending?.responseMode === "sync") {
    pending.resolve?.(msg.result)
  }
  await finalizeAsyncRelayOperation(operation, msg)
}

async function markOperationStatus(
  operationId: string,
  status: "received" | "started"
) {
  const result = await executeSql<{
    task_id: string | null
    visible_tool_name: string
  }>(
    `UPDATE relay_operations
     SET status = $2, updated_at = NOW()
     WHERE id = $1
       AND status NOT IN ('cancel_requested', 'completed', 'failed', 'cancelled', 'aborted', 'expired')
     RETURNING task_id, visible_tool_name`,
    [operationId, status]
  )

  const row = result.rows[0]
  if (!row?.task_id) {
    return
  }

  const pending = pendingRelayOperations.get(operationId)
  if (pending) {
    pending.operationStatus = status
  }

  if (status === "received") {
    await markToolCallTaskReceived(
      row.task_id,
      `Relay received async ${row.visible_tool_name}.`
    ).catch(() => {})
    return
  }

  await markToolCallTaskStarted(
    row.task_id,
    `Relay started executing async ${row.visible_tool_name}.`
  ).catch(() => {})
}

async function markDeliveryAcknowledged(
  operationId: string,
  deliveryId?: string
) {
  await executeSql(
    `UPDATE relay_operation_deliveries
     SET status = 'acked', acknowledged_at = NOW(), updated_at = NOW()
     WHERE operation_id = $1
       AND ($2::text IS NULL OR metadata->>'deliveryId' = $2)`,
    [operationId, deliveryId || null]
  )

  const pending = pendingRelayOperations.get(operationId)
  if (pending && (!deliveryId || pending.deliveryId === deliveryId)) {
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer)
      pending.ackTimer = null
    }
    pending.deliverySeq = null
    pending.deliveryId = null
    pending.relaySessionRowId = null
  }
}

async function markDeliveryStatus(
  operationId: string,
  deliverySeq: number,
  status: "queued" | "sent" | "acked" | "nacked" | "timed_out" | "cancelled"
) {
  await executeSql(
    `UPDATE relay_operation_deliveries
     SET status = $3,
         updated_at = NOW(),
         acknowledged_at = CASE WHEN $3 = 'acked' THEN NOW() ELSE acknowledged_at END
     WHERE operation_id = $1
       AND delivery_seq = $2`,
    [operationId, deliverySeq, status]
  ).catch(() => {})
}

async function redrivePendingRelayOperations(connected: ConnectedRelay) {
  const pendingForDevice = [...pendingRelayOperations.values()].filter(
    (pending) => pending.deviceId === connected.deviceId
  )

  for (const pending of pendingForDevice) {
    if (pending.deliverySeq !== null) {
      await markDeliveryStatus(
        pending.operationId,
        pending.deliverySeq,
        "nacked"
      )
      pending.deliverySeq = null
      pending.deliveryId = null
      pending.relaySessionRowId = null
    }
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer)
      pending.ackTimer = null
    }
    await dispatchPendingRelayOperation(connected, pending)
  }

  const expiredAsyncOperations = await executeSql<{
    operation_id: string
    task_id: string
    source_tool_name: string | null
  }>(
    `SELECT
       ro.id AS operation_id,
       ro.task_id,
       task.source_tool_name
     FROM relay_operations ro
     JOIN tool_call_tasks task
       ON task.id = ro.task_id
     WHERE ro.device_id = $1
       AND ro.task_id IS NOT NULL
       AND ro.status IN ('created', 'cancel_requested', 'dispatched', 'received', 'started')
       AND ro.expires_at IS NOT NULL
       AND ro.expires_at <= NOW()`,
    [connected.deviceId]
  )

  for (const row of expiredAsyncOperations.rows) {
    await executeSql(
      `UPDATE relay_operations
       SET status = 'expired',
           error_code = 'operation_expired',
           error_message = 'Relay operation expired before delivery',
           updated_at = NOW()
       WHERE id = $1`,
      [row.operation_id]
    ).catch(() => {})
    await failToolCallTask(row.task_id, {
      summary: `Async ${row.source_tool_name || "relay tool"} expired before the relay client could finish it.`,
      finalResultPayload: {
        content: textBlocks(
          `Async ${row.source_tool_name || "relay tool"} expired before the relay client could finish it.`
        ),
        isError: true,
      },
      finalErrorPayload: {
        code: "operation_expired",
        operationId: row.operation_id,
      },
    }).catch(() => {})
  }

  const persistedAsyncOperations = await executeSql<RelayTaskOperationRecord>(
    `SELECT
       ro.id AS operation_id,
       ro.status,
       ro.workspace_id,
       ro.conversation_id,
       ro.requested_by_session_id,
       ro.requested_by_workspace_member_id,
       ro.requested_by_actor_id,
       ro.task_id,
       ro.device_id,
       device.title AS device_display_name,
       ro.exposure_id,
       exposure.stable_key AS exposure_stable_key,
       exposure.display_name AS exposure_display_name,
       ro.runtime_session_id,
       ro.visible_tool_name,
       ro.tool_id,
       ro.tool_revision_id,
       ro.catalog_revision_id,
       ro.input_payload,
       ro.authorization_payload,
       ro.input_hash,
       ro.operation_timeout_ms,
       ro.expires_at,
       task.source_tool_name,
       task.cancel_reason
     FROM relay_operations ro
     JOIN tool_call_tasks task
       ON task.id = ro.task_id
     LEFT JOIN relay_devices device
       ON device.id = ro.device_id
     LEFT JOIN relay_exposures exposure
       ON exposure.id = ro.exposure_id
     WHERE ro.device_id = $1
       AND ro.task_id IS NOT NULL
       AND ro.status IN ('created', 'cancel_requested', 'dispatched', 'received', 'started')
       AND (ro.expires_at IS NULL OR ro.expires_at > NOW())`,
    [connected.deviceId]
  )

  for (const row of persistedAsyncOperations.rows) {
    if (pendingRelayOperations.has(row.operation_id)) {
      continue
    }

    const timeoutMs = row.expires_at
      ? Math.max(1_000, new Date(row.expires_at).getTime() - Date.now())
      : row.operation_timeout_ms || RELAY_OPERATION_TTL_MS
    const timeoutTimer = setTimeout(() => {
      const current = pendingRelayOperations.get(row.operation_id)
      if (!current) return

      if (current.cancelRequested) {
        void finalizePendingRelayCancellation(
          current,
          current.cancelReason?.trim() ||
            `Async ${current.sourceToolName} was cancelled.`
        )
        return
      }

      clearPendingRelayOperation(current)
      pendingRelayOperations.delete(row.operation_id)
      void failOperation(
        row.operation_id,
        "delivery_timed_out",
        `Relay operation timed out after ${current.operationTimeoutMs}ms`,
        true,
        false
      )
      if (current.taskId) {
        void failToolCallTask(current.taskId, {
          summary: `Async ${current.sourceToolName} timed out before the relay returned a result.`,
          finalResultPayload: {
            content: textBlocks(
              `Async ${current.sourceToolName} timed out before the relay returned a result.`
            ),
            isError: true,
          },
          finalErrorPayload: {
            code: "delivery_timed_out",
            operationId: row.operation_id,
          },
        }).catch(() => {})
      }
    }, timeoutMs)

    pendingRelayOperations.set(row.operation_id, {
      responseMode: "async",
      operationStatus: row.status,
      operationId: row.operation_id,
      deviceId: row.device_id,
      workspaceId: row.workspace_id,
      conversationId: row.conversation_id,
      sessionId: row.requested_by_session_id,
      actorId: row.requested_by_actor_id,
      workspaceMemberId: row.requested_by_workspace_member_id,
      exposureId: row.exposure_id,
      exposureStableKey: row.exposure_stable_key || "",
      runtimeSessionId: row.runtime_session_id || "",
      visibleToolName: row.visible_tool_name,
      sourceToolName: row.source_tool_name || row.visible_tool_name,
      toolId: row.tool_id,
      toolRevisionId: row.tool_revision_id,
      catalogRevisionId: row.catalog_revision_id,
      args: (row.input_payload as Record<string, unknown>) || {},
      authorization:
        (row.authorization_payload as RelayAuthorizationEnvelope | null) ||
        undefined,
      inputHash: row.input_hash,
      taskId: row.task_id,
      operationTimeoutMs: row.operation_timeout_ms || RELAY_OPERATION_TTL_MS,
      expiresAt: row.expires_at,
      timeoutTimer,
      ackTimer: null,
      relaySessionRowId: null,
      deliverySeq: null,
      deliveryId: null,
      cancelRequested: row.status === "cancel_requested",
      cancelReason: row.cancel_reason || null,
    })

    await dispatchPendingRelayOperation(
      connected,
      pendingRelayOperations.get(row.operation_id)!
    )
  }
}

async function resolveRuntimeSessionResult(
  connected: ConnectedRelay,
  msg: Record<string, unknown>
) {
  const runtimeSessionId = msg.runtimeSessionId as string
  const action = msg.action === "close" ? "close" : "open"
  const pendingKey = buildRuntimeSessionRequestKey(action, runtimeSessionId)
  const pending = pendingRelayRuntimeSessionRequests.get(pendingKey)
  if (!pending || pending.deviceId !== connected.deviceId) {
    return
  }

  clearTimeout(pending.timeoutTimer)
  pendingRelayRuntimeSessionRequests.delete(pendingKey)

  const isError = msg.success === false || Boolean(msg.error)
  if (isError) {
    pending.reject(buildRelayExecutionError(normalizeOperationError(msg.error)))
    return
  }

  pending.resolve()
}

async function failOperation(
  operationId: string,
  code: string,
  message: string,
  retryable: boolean,
  requiresReplan: boolean,
  currentToolRevisionId?: string
) {
  await executeSql(
    `UPDATE relay_operations
     SET status = 'failed',
         error_code = $2,
         error_message = $3,
         requires_replan = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [operationId, code, message, requiresReplan]
  ).catch(() => {})

  await executeSql(
    `UPDATE relay_operation_deliveries
     SET status = CASE
         WHEN status = 'queued' THEN 'cancelled'
         WHEN status = 'sent' THEN 'timed_out'
         ELSE status
       END,
       updated_at = NOW()
     WHERE operation_id = $1`,
    [operationId]
  ).catch(() => {})

  await executeSql(
    `INSERT INTO relay_operation_results (operation_id, output_payload, output_preview, result_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (operation_id) DO UPDATE SET
       output_payload = EXCLUDED.output_payload,
       output_preview = EXCLUDED.output_preview,
       result_hash = EXCLUDED.result_hash,
       updated_at = NOW()`,
    [
      operationId,
      JSON.stringify({
        error: {
          code,
          message,
          retryable,
          requiresReplan,
          currentToolRevisionId,
        },
      }),
      message,
      hashValue({
        code,
        message,
        retryable,
        requiresReplan,
        currentToolRevisionId,
      }),
    ]
  ).catch(() => {})
}

function cleanupRelay(deviceId: string) {
  const connected = connectedRelays.get(deviceId)
  if (!connected) return

  if (connected.heartbeatTimer) clearInterval(connected.heartbeatTimer)
  if (connected.pongTimer) clearTimeout(connected.pongTimer)

  connectedRelays.delete(deviceId)
  void clearRelayRoute(deviceId, connected.sessionId)

  for (const pending of pendingRelayOperations.values()) {
    if (pending.deviceId !== deviceId) continue
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer)
      pending.ackTimer = null
    }
    if (
      pending.relaySessionRowId === connected.sessionRowId &&
      pending.deliverySeq !== null
    ) {
      void markDeliveryStatus(
        pending.operationId,
        pending.deliverySeq,
        "nacked"
      )
      pending.deliverySeq = null
      pending.deliveryId = null
      pending.relaySessionRowId = null
    }
  }

  for (const [key, pending] of pendingRelayRuntimeSessionRequests.entries()) {
    if (pending.deviceId !== deviceId) continue
    clearTimeout(pending.timeoutTimer)
    pendingRelayRuntimeSessionRequests.delete(key)
    pending.reject(
      buildRelayExecutionError({
        code: "mcp_unavailable",
        message: `Relay device ${deviceId} disconnected`,
        retryable: true,
      })
    )
  }

  void executeSql(
    `UPDATE relay_device_sessions
     SET status = 'closed',
         ended_at = COALESCE(ended_at, NOW()),
         close_reason = COALESCE(close_reason, 'socket_closed'),
         updated_at = NOW()
     WHERE id = $1`,
    [connected.sessionRowId]
  ).catch(() => {})

  void markRelayLifecycleDisconnectPending({
    deviceId,
  }).catch(() => {})

  void executeSql(
    `UPDATE relay_exposures
     SET runtime_status = 'offline', updated_at = NOW()
     WHERE device_id = $1`,
    [deviceId]
  ).catch(() => {})

  void incrementMcpVersion(connected.workspaceId).catch(() => {})

  emitEvent({
    type: "relay.disconnected",
    workspaceId: connected.workspaceId,
    payload: { deviceId },
    timestamp: new Date().toISOString(),
  })

  logEvent({
    workspaceId: connected.workspaceId,
    relayId: deviceId,
    eventType: "relay.disconnected",
    eventData: { deviceId },
  })
}

function normalizeOperationError(raw: unknown): RelayOperationError {
  if (!isObject(raw)) {
    return {
      code: "tool_execution_failed",
      message: "Relay operation failed",
      retryable: true,
    }
  }

  const code = typeof raw.code === "string" ? raw.code : "tool_execution_failed"
  return {
    code: code as RelayOperationError["code"],
    message:
      typeof raw.message === "string" ? raw.message : "Relay operation failed",
    retryable: raw.retryable !== false,
    requiresReplan: Boolean(raw.requiresReplan),
    currentToolRevisionId:
      typeof raw.currentToolRevisionId === "string"
        ? raw.currentToolRevisionId
        : undefined,
  }
}

function buildRelayExecutionError(error: RelayOperationError) {
  return Object.assign(new Error(error.message), error)
}

function previewValue(value: unknown) {
  if (typeof value === "string") return value.slice(0, 500)
  try {
    return stableStringify(value).slice(0, 500)
  } catch {
    return ""
  }
}

function hashValue(value: unknown) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
}

function sendAuthError(
  socket: any,
  code: string,
  message: string,
  retryable: boolean
) {
  socket.send(
    JSON.stringify({
      type: "auth_error",
      code,
      message,
      retryable,
    })
  )
}

function verifyRelayAuthSignature(
  publicKeyPem: string,
  deviceId: string,
  challenge: string,
  nonce: string,
  signatureBase64: string
) {
  if (!signatureBase64) return false

  try {
    const payload = Buffer.from(
      `synapse-relay-auth:${deviceId}:${challenge}:${nonce}`
    )
    const signature = Buffer.from(signatureBase64, "base64")
    return crypto.verify(null, payload, publicKeyPem, signature)
  } catch {
    return false
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    )
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
  }
  return JSON.stringify(String(value))
}

function parseMessage(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(raw))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  return value
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isRuntimeAvailable(
  status: RelayExposureRegistration["runtimeStatus"]
) {
  return status === "healthy" || status === "degraded" || status === "starting"
}
