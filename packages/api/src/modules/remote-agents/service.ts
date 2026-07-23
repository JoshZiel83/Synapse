import crypto, { createHash, randomBytes } from "node:crypto"
import type { FastifyInstance } from "fastify"
import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
} from "@opentelemetry/api"
import {
  REMOTE_AGENT_MACHINE_LIFECYCLE_STATE,
  REMOTE_AGENT_MACHINE_TRUST_STATUS,
  REMOTE_AGENT_RUNTIME_CATALOG_STATUS,
  REMOTE_AGENT_RUNTIME_STATE,
  type CapabilityAccessTarget,
  type RemoteAgentLifecycleState,
  type OneClickInstallCommands,
  type RemoteAgentMachineTrustStatus,
  type RemoteAgentRuntimeKind,
  type RemoteAgentRuntimeStateType,
  type WorkspaceResourceGrantPermission,
  type Timestamp,
} from "@synapse/shared"
import { config } from "../../config/index.js"
import { buildDaemonCommand as buildDaemonCommandImpl } from "./daemon-command.js"
import {
  buildDaemonInstallCommands,
  getRenderedInstallerArtifacts,
} from "../installer/install-command.js"
import type { Executor } from "../../infrastructure/database/kysely.js"
import {
  type RemoteAgentConversationRecord,
  type RemoteAgentRecord,
  type RemoteAgentRow,
} from "./presenter.js"
import {
  authorizeActionDefault,
  listAuthorizedResourceIdsDefault,
} from "../access/guards.js"
import { sendConversationMessageFromParticipant } from "../chat/item-write.js"
import { listVisibleConversationItemsForParticipant } from "../chat/conversation-item-read.js"
import {
  requireRemoteAgentConversationAccessOnDefaultDb,
  sendRemoteAgentConversationMessageUseCase,
  requireRemoteAgentConversationAccess,
} from "../chat/remote-agent-bridge.js"
import { getFileUrlById } from "../files/service.js"
import { requireWorkspaceMemberIdentity } from "../chat/workspace-identity.js"
import { activeTraceCarrier } from "../../infrastructure/observability/traceparent.js"
import { extractEnvelopeTraceContext } from "../../infrastructure/observability/envelope-trace.js"
import { linkUpstreamTraces } from "../../workers/job-tracing.js"
import {
  notifyRemoteAgentTaskResolvedUseCase,
  replayResolvedRemoteAgentTasksUseCase,
} from "./task-resolution-notifier.js"
import * as repo from "./repo.js"
import { beginTurnForConversation } from "./turn-carriers.js"
import {
  parseRemoteAgentMachineMessage,
  serializeRemoteAgentApiToDaemonMessage,
  type RemoteAgentApiToDaemonMessage,
  type RemoteAgentMachineMessage,
  type RemoteAgentRuntimeCatalogRecord,
} from "./wire.js"
import {
  normalizeRemoteAgentPlanChecklist,
  normalizeRemoteAgentUserInputQuestions,
} from "./task-request-payload.js"

type MachineConnection = {
  machineId: string
  workspaceId: string
  sessionId: string
  fencingToken: string
  socket: any
  ready: boolean
}

const machineConnections = new Map<string, MachineConnection>()
const deliveryInFlightByMachine = new Map<string, Map<string, number>>()
const DELIVERY_IN_FLIGHT_TTL_MS = 5_000

const tracer = trace.getTracer("synapse-remote-agents")

/**
 * Run one work-triggering daemon→api machine message (`ready` /
 * `runtime:catalog` / `agent:session` / `agent:status` — never heartbeat)
 * inside ONE SERVER span, remote-parented on the message's envelope
 * `{traceparent, tracestate}` fields (extract-or-ROOT — never the span-free
 * `config:{otel:false}` upgrade context). This is what gives
 * `activeTraceCarrier()` a real value on the daemon-WS-triggered
 * `agent:start` sends (startBoundRemoteAgents / sendAgentStartPrefix) — the
 * §4.C "dead stamping" fix. Ended in `finally`; a throw records + rethrows to
 * the socket handler's existing error path.
 *
 * Exported for the unit matrix in machine-message-span.test.ts (production
 * callers are the four dispatch sites in this file's socket handler only).
 */
export async function runMachineMessageSpan<T>(
  machineId: string,
  message: Extract<
    RemoteAgentMachineMessage,
    { type: "ready" | "runtime:catalog" | "agent:session" | "agent:status" }
  >,
  fn: () => Promise<T>
): Promise<T> {
  const attributes: Attributes = {
    "synapse.ws.surface": "remote-agents",
    "synapse.ws.frame_type": message.type,
    "synapse.machine.id": machineId,
  }
  if ("remoteAgentId" in message && message.remoteAgentId) {
    attributes["synapse.remote_agent.id"] = message.remoteAgentId
  }
  return tracer.startActiveSpan(
    `ws.${message.type}`,
    { kind: SpanKind.SERVER, attributes },
    extractEnvelopeTraceContext(message),
    async (span) => {
      try {
        return await fn()
      } catch (err) {
        span.recordException(err as Error)
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        })
        throw err
      } finally {
        span.end()
      }
    }
  )
}

function hashMachineApiKey(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex")
}

function buildDaemonCommand(apiKey: string) {
  return buildDaemonCommandImpl({
    serverUrl: config.app.baseUrl,
    apiKey,
    npmRegistryUrl: config.remoteAgent.npmRegistryUrl,
  })
}

// One-click bootstrap commands for a host with no Node yet. null when no
// private registry is configured (bootstrap can't fetch @synapse/* without it).
function buildDaemonOneClick(apiKey: string): OneClickInstallCommands | null {
  const artifacts = getRenderedInstallerArtifacts({
    serverUrl: config.app.baseUrl,
    privateRegistry: config.remoteAgent.npmRegistryUrl,
  })
  if (!artifacts) return null
  return buildDaemonInstallCommands({
    serverUrl: config.app.baseUrl,
    apiKey,
    shaSh: artifacts.shaSh,
    shaPs1: artifacts.shaPs1,
  })
}

function safeSend(
  connection: MachineConnection,
  payload: RemoteAgentApiToDaemonMessage
) {
  if (!connection.ready || connection.socket.readyState !== 1) {
    return false
  }
  try {
    connection.socket.send(serializeRemoteAgentApiToDaemonMessage(payload))
    return true
  } catch {
    return false
  }
}

function pruneInFlightDeliveryMap(machineId: string, now = Date.now()) {
  const current = deliveryInFlightByMachine.get(machineId)
  if (!current) {
    return new Map<string, number>()
  }
  for (const [deliveryId, expiresAt] of current) {
    if (expiresAt <= now) {
      current.delete(deliveryId)
    }
  }
  if (current.size === 0) {
    deliveryInFlightByMachine.delete(machineId)
    return new Map<string, number>()
  }
  return current
}

function markInFlightDeliveries(
  machineId: string,
  deliveryIds: string[],
  now = Date.now()
) {
  if (deliveryIds.length === 0) {
    return
  }
  const current = pruneInFlightDeliveryMap(machineId, now)
  for (const deliveryId of deliveryIds) {
    current.set(deliveryId, now + DELIVERY_IN_FLIGHT_TTL_MS)
  }
  if (current.size > 0) {
    deliveryInFlightByMachine.set(machineId, current)
  }
}

function clearInFlightDeliveries(machineId: string, deliveryIds: string[]) {
  if (deliveryIds.length === 0) {
    return
  }
  const current = deliveryInFlightByMachine.get(machineId)
  if (!current) {
    return
  }
  for (const deliveryId of deliveryIds) {
    current.delete(deliveryId)
  }
  if (current.size === 0) {
    deliveryInFlightByMachine.delete(machineId)
  }
}

async function getTaskSummaryLazy(taskId: string) {
  const { getTaskSummary } = await import("../tasks/service.js")
  return getTaskSummary(taskId)
}

function hasMachineConnection(machineId: string) {
  return machineConnections.has(machineId)
}

function sendToMachine(
  machineId: string,
  message: RemoteAgentApiToDaemonMessage
) {
  const connection = machineConnections.get(machineId)
  if (!connection) {
    return false
  }
  return safeSend(connection, message)
}

async function loadMachineByApiKey(apiKey: string) {
  return repo.loadMachineByApiKeyRepo(hashMachineApiKey(apiKey))
}

async function loadBoundRemoteAgentsForMachine(machineId: string) {
  return repo.loadBoundRemoteAgentsForMachineRepo(machineId)
}

async function updateConversationRuntimeStatus(
  params: {
    remoteAgentId: string
    conversationId: string
    runtimeKind?: RemoteAgentRuntimeKind | null
    state: RemoteAgentRuntimeStateType
    statusText?: string | null
    sessionId?: string | null
    taskId?: string | null
    lastError?: string | null
  },
  queryable?: Executor
) {
  await repo.updateConversationRuntimeStatusRepo(params, queryable)
}

async function loadAgentStartTargetsForMachine(machineId: string) {
  return repo.loadAgentStartTargetsForMachineRepo(machineId)
}

async function setMachineLifecycleState(
  machineId: string,
  state: RemoteAgentLifecycleState,
  queryable?: Executor
) {
  await repo.setMachineLifecycleStateRepo(machineId, state, queryable)
}

async function upsertRuntimeCatalog(
  machineId: string,
  entries: RemoteAgentRuntimeCatalogRecord[],
  queryable?: Executor
) {
  await repo.upsertRuntimeCatalogRepo(machineId, entries, queryable)
}

async function startBoundRemoteAgents(machineId: string) {
  const connection = machineConnections.get(machineId)
  if (!connection || !connection.ready) {
    return
  }

  const bindings = await loadBoundRemoteAgentsForMachine(machineId)
  if (bindings.length === 0) {
    return
  }
  const bindingByAgentId = new Map(
    bindings.map((row) => [row.remoteAgentId, row])
  )

  const targets = await loadAgentStartTargetsForMachine(machineId)

  // Live path: both carrier fields via the canonical mint. Non-null only when
  // an active span exists — for the daemon-`ready`-triggered call that is the
  // per-message SERVER span opened by handleRemoteAgentDaemonConnection.
  const startCarrier = activeTraceCarrier()
  for (const target of targets) {
    const binding = bindingByAgentId.get(target.remoteAgentId)
    if (!binding) continue
    safeSend(connection, {
      type: "agent:start",
      remoteAgentId: target.remoteAgentId,
      conversationId: target.conversationId,
      runtimeKind: binding.runtimeKind,
      runtimePath: binding.runtimePath,
      localRootPath: binding.localRootPath,
      sessionId: target.runtimeSessionId,
      fencingToken: connection.fencingToken,
      serverUrl: config.app.baseUrl,
      traceparent: startCarrier?.traceparent,
      tracestate: startCarrier?.tracestate,
    })
  }

  await notifyPendingRemoteAgentDeliveries({
    machineId,
    remoteAgentIds: bindings.map((binding) => binding.remoteAgentId),
  })
  await replayResolvedRemoteAgentTasks({
    machineId,
    remoteAgentIds: bindings.map((binding) => binding.remoteAgentId),
  })
}

async function replayResolvedRemoteAgentTasks(params: {
  machineId: string
  remoteAgentIds: string[]
}) {
  await replayResolvedRemoteAgentTasksUseCase(params, {
    hasMachineConnection,
    loadReplayResolvedTaskTargets: ({ machineId, remoteAgentIds }) =>
      repo.loadReplayResolvedTaskTargetsRepo(machineId, remoteAgentIds),
    getTaskSummary: getTaskSummaryLazy,
    sendToMachine,
  })
}

async function updateRemoteAgentRuntimeStatus(
  machineId: string,
  message: Extract<RemoteAgentMachineMessage, { type: "agent:status" }>,
  queryable?: Executor
) {
  const runStatus = ((): "running" | "completed" | "failed" | "cancelled" => {
    switch (message.state) {
      case REMOTE_AGENT_RUNTIME_STATE.OFFLINE:
        return "cancelled"
      case REMOTE_AGENT_RUNTIME_STATE.ERROR:
        return "failed"
      case REMOTE_AGENT_RUNTIME_STATE.IDLE:
        return "completed"
      default:
        return "running"
    }
  })()
  const runId =
    message.runKey && message.runKey.trim()
      ? await repo.ensureRemoteAgentRunRepo({
          remoteAgentId: message.remoteAgentId,
          conversationId: message.conversationId ?? null,
          runKey: message.runKey,
          status: runStatus,
          statusText: message.statusText,
          lastError: message.lastError ?? null,
          executor: queryable,
        })
      : null

  if (message.conversationId) {
    const bindingRuntimeKind = await repo.loadBindingRuntimeKindRepo(
      message.remoteAgentId,
      machineId,
      queryable
    )
    await updateConversationRuntimeStatus(
      {
        remoteAgentId: message.remoteAgentId,
        conversationId: message.conversationId,
        runtimeKind: bindingRuntimeKind ?? null,
        state: message.state,
        statusText: message.statusText,
        sessionId: message.sessionId ?? null,
        taskId: message.taskId ?? null,
        lastError: message.lastError ?? null,
      },
      queryable
    )
  } else if (message.state === REMOTE_AGENT_RUNTIME_STATE.OFFLINE) {
    // Agent-wide stop (daemon sent state=offline without a conversationId,
    // typically from stopAll() during agent:stop handling). Propagate
    // offline to every per-conversation context so the binding aggregation
    // below resolves to offline instead of resurrecting whichever
    // running/idle state the contexts last reported. Without this,
    // "online stop" looks the same as "ignore the stop" on the UI.
    //
    // Disconnect tear-down is handled separately by the machine
    // finalizer (setMachineLifecycleState + the offline UPDATE down at
    // line ~2829), which still drives bindings to offline directly. This
    // branch covers the in-process stop where the daemon stays connected.
    await repo.offlineContextsForAgentWideStopRepo(
      {
        remoteAgentId: message.remoteAgentId,
        statusText: message.statusText ?? null,
      },
      queryable
    )
  }

  await repo.aggregateBindingFromContextsRepo(
    {
      remoteAgentId: message.remoteAgentId,
      machineId,
      capabilities: message.capabilities,
    },
    queryable
  )

  if (runId && message.taskId) {
    await repo.setRemoteAgentRunTaskIdRepo(runId, message.taskId, queryable)
  }

  await emitRemoteAgentRuntimeUpdated(message.remoteAgentId, queryable)
}

async function loadPendingRemoteAgentDeliveries(params: {
  machineId?: string
  conversationId?: string
  remoteAgentIds?: string[]
}) {
  return repo.loadPendingRemoteAgentDeliveriesRepo(params)
}

async function sendAgentStartPrefix(
  connection: MachineConnection,
  pendingForSend: Array<{ remoteAgentId: string; conversationId: string }>,
  machineId: string
) {
  const pairs = new Map<
    string,
    { remoteAgentId: string; conversationId: string }
  >()
  for (const delivery of pendingForSend) {
    const key = `${delivery.remoteAgentId}:${delivery.conversationId}`
    if (!pairs.has(key)) {
      pairs.set(key, {
        remoteAgentId: delivery.remoteAgentId,
        conversationId: delivery.conversationId,
      })
    }
  }
  if (pairs.size === 0) return
  const remoteAgentIds = [
    ...new Set([...pairs.values()].map((pair) => pair.remoteAgentId)),
  ]
  const conversationIds = [
    ...new Set([...pairs.values()].map((pair) => pair.conversationId)),
  ]
  const { bindings, sessions } = await repo.loadAgentStartPrefixDataRepo({
    machineId,
    remoteAgentIds,
    conversationIds,
  })
  const bindingByAgent = new Map(
    bindings.map((row) => [row.remoteAgentId, row])
  )
  const sessionByPair = new Map(
    sessions.map((row) => [
      `${row.remoteAgentId}:${row.conversationId}`,
      row.runtimeSessionId,
    ])
  )
  // Live path: both carrier fields via the canonical mint (see
  // startBoundRemoteAgents).
  const prefixCarrier = activeTraceCarrier()
  for (const pair of pairs.values()) {
    const binding = bindingByAgent.get(pair.remoteAgentId)
    if (!binding) continue
    safeSend(connection, {
      type: "agent:start",
      remoteAgentId: pair.remoteAgentId,
      conversationId: pair.conversationId,
      runtimeKind: binding.runtimeKind,
      runtimePath: binding.runtimePath,
      localRootPath: binding.localRootPath,
      sessionId:
        sessionByPair.get(`${pair.remoteAgentId}:${pair.conversationId}`) ??
        null,
      fencingToken: connection.fencingToken,
      serverUrl: config.app.baseUrl,
      traceparent: prefixCarrier?.traceparent,
      tracestate: prefixCarrier?.tracestate,
    })
  }
}

async function notifyPendingRemoteAgentDeliveries(params: {
  machineId?: string
  conversationId?: string
  remoteAgentIds?: string[]
}) {
  const result = await loadPendingRemoteAgentDeliveries(params)
  const grouped = new Map<
    string,
    Array<{
      remoteAgentId: string
      deliveryId: string
      conversationId: string
      itemId: string
      traceparent?: string
    }>
  >()

  for (const row of result.rows) {
    const current = grouped.get(row.machineId) ?? []
    current.push({
      remoteAgentId: row.remoteAgentId,
      deliveryId: row.deliveryId,
      conversationId: row.conversationId,
      itemId: row.itemId,
      // Per-delivery originating trace, persisted at enqueue → correct even on
      // the reconnect-replay / retry-worker legs that have no active span here.
      traceparent: row.originTraceparent ?? undefined,
    })
    grouped.set(row.machineId, current)
  }

  for (const [machineId, deliveries] of grouped) {
    const connection = machineConnections.get(machineId)
    if (!connection) continue
    const now = Date.now()
    const inFlight = pruneInFlightDeliveryMap(machineId, now)
    const pendingForSend = deliveries.filter(
      (delivery) => !inFlight.has(delivery.deliveryId)
    )
    if (pendingForSend.length === 0) {
      continue
    }
    // Prefix each batch with agent:start frames so the daemon ALWAYS knows
    // which driver to spawn for an unfamiliar (agent, conversation). Without
    // this the daemon's ManagedRemoteAgent falls back to its default
    // runtimeKind ("claude_code") when agent:deliver arrives for an agent
    // it has never seen — that silently routes Codex agents through the
    // Claude driver. configure() + ensureRuntimeForConversation are
    // idempotent, so re-sending the prefix on every batch is cheap and
    // robust.
    await sendAgentStartPrefix(connection, pendingForSend, machineId)
    const sent = safeSend(connection, {
      type: "agent:deliver",
      deliveries: pendingForSend,
    })
    if (sent) {
      markInFlightDeliveries(
        machineId,
        pendingForSend.map((delivery) => delivery.deliveryId),
        now
      )
      // Open the reverse-MCP turn epoch on any live session of each dispatched
      // (agent, conversation): a tools/call in the woken turn links THIS wake's
      // delivery origins, not prior turns' (F3 reverse-MCP half). No-op when no
      // reverse-MCP session is connected — its first tools/call `extend`s from
      // the live delivery rows anyway.
      const wakeByConversation = new Map<
        string,
        {
          remoteAgentId: string
          conversationId: string
          traceparents: Array<string | undefined>
        }
      >()
      for (const delivery of pendingForSend) {
        const key = `${delivery.remoteAgentId}:${delivery.conversationId}`
        let slice = wakeByConversation.get(key)
        if (!slice) {
          slice = {
            remoteAgentId: delivery.remoteAgentId,
            conversationId: delivery.conversationId,
            traceparents: [],
          }
          wakeByConversation.set(key, slice)
        }
        slice.traceparents.push(delivery.traceparent)
      }
      for (const slice of wakeByConversation.values()) {
        beginTurnForConversation(
          slice.remoteAgentId,
          slice.conversationId,
          slice.traceparents
        )
      }
    } else {
      await scheduleDeliveryRetry(
        machineId,
        pendingForSend.map((delivery) => delivery.deliveryId),
        "WebSocket push failed"
      )
    }
  }
}

async function scheduleDeliveryRetry(
  machineId: string | null,
  deliveryIds: string[],
  reason: string,
  queryable?: Executor
) {
  if (deliveryIds.length === 0) return
  if (machineId) {
    clearInFlightDeliveries(machineId, deliveryIds)
  }
  await repo.scheduleDeliveryRetryRepo(deliveryIds, reason, queryable)
}

export async function failRemoteAgentDeliveries(params: {
  remoteAgentId: string
  machineKey: string
  /** Per-delivery failure entries, each with ITS OWN originating carrier. */
  deliveries: Array<{
    deliveryId: string
    traceparent?: string
    tracestate?: string
  }>
  reason?: string
}) {
  const machine = await authenticateMachineForRemoteAgent(params)
  // Fan-in join (§4.C): this POST's request span is either parented under the
  // single origin trace (the daemon sent a traceparent header) or a fresh
  // root (mixed origins / untraced) — either way, LINK every upstream
  // delivery-origin trace onto it. Dedupe by trace id (a multi-delivery batch
  // from one request repeats the same origin); linkUpstreamTraces skips the
  // self-link in the single-origin parented case and unsampled origins.
  const activeSpan = trace.getActiveSpan()
  if (activeSpan) {
    activeSpan.setAttributes({
      "synapse.remote_agent.id": params.remoteAgentId,
      "synapse.machine.id": machine.machineId,
      "synapse.deliveries.count": params.deliveries.length,
    })
  }
  const uniqueTraceparents = new Map<string, string>()
  for (const delivery of params.deliveries) {
    if (!delivery.traceparent) continue
    const traceId = delivery.traceparent.slice(3, 35)
    if (!uniqueTraceparents.has(traceId)) {
      uniqueTraceparents.set(traceId, delivery.traceparent)
    }
  }
  linkUpstreamTraces(uniqueTraceparents.values(), "remote_agent_delivery")

  const uniqueIds = [
    ...new Set(
      params.deliveries.map((delivery) => delivery.deliveryId).filter(Boolean)
    ),
  ]
  if (uniqueIds.length === 0) {
    return { rescheduled: 0 }
  }
  const ownedIds = await repo.listOwnedPendingDeliveryIdsRepo(
    params.remoteAgentId,
    uniqueIds
  )
  if (ownedIds.length === 0) {
    return { rescheduled: 0 }
  }
  await scheduleDeliveryRetry(
    machine.machineId,
    ownedIds,
    params.reason?.trim() || "Daemon reported failure"
  )
  return { rescheduled: ownedIds.length }
}

export async function runDueRemoteAgentDeliveryRetries() {
  const dueRows = await repo.loadDueRemoteAgentDeliveryRetriesRepo()
  if (dueRows.length === 0) {
    return { rechecked: 0 }
  }

  const byMachine = new Map<string, string[]>()
  for (const row of dueRows) {
    if (!row.machineId) continue
    const list = byMachine.get(row.machineId) ?? []
    list.push(row.remoteAgentId)
    byMachine.set(row.machineId, list)
  }

  for (const [machineId, remoteAgentIds] of byMachine) {
    await notifyPendingRemoteAgentDeliveries({
      machineId,
      remoteAgentIds: [...new Set(remoteAgentIds)],
    })
  }

  return { rechecked: dueRows.length }
}

function parseMachineKeyFromRequest(request: {
  headers: Record<string, unknown>
}) {
  const authorization =
    typeof request.headers.authorization === "string"
      ? request.headers.authorization.trim()
      : ""
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim()
  }

  const header =
    typeof request.headers["x-synapse-machine-key"] === "string"
      ? request.headers["x-synapse-machine-key"].trim()
      : ""
  return header || ""
}

export async function authenticateMachineForRemoteAgent(params: {
  remoteAgentId: string
  machineKey: string
}) {
  if (!params.machineKey) {
    throw new Error("Machine key is required")
  }
  const machine = await loadMachineByApiKey(params.machineKey)
  if (
    !machine ||
    machine.trustStatus !== REMOTE_AGENT_MACHINE_TRUST_STATUS.ACTIVE
  ) {
    throw new Error("Machine authentication failed")
  }

  const binding = await repo.authenticateBindingRepo(
    params.remoteAgentId,
    machine.id
  )
  if (!binding) {
    throw new Error("Remote agent is not bound to this machine")
  }

  return {
    machineId: machine.id,
    workspaceId: binding.workspaceId,
    localRootPath: binding.localRootPath ?? undefined,
  }
}

async function ensureRemoteAgentRun(params: {
  remoteAgentId: string
  conversationId?: string | null
  runKey: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  statusText?: string | null
  lastError?: string | null
  queryable?: Executor
}) {
  return repo.ensureRemoteAgentRunRepo({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    runKey: params.runKey,
    status: params.status,
    statusText: params.statusText,
    lastError: params.lastError,
    executor: params.queryable,
  })
}

export async function loadRemoteAgentRuntimeSnapshot(
  remoteAgentId: string,
  options: {
    /**
     * When provided, the returned snapshot is scoped to this conversation:
     * runtime_state / status_text / last_error / session_id / active task
     * come from the (remote_agent_id, conversation_id) context row, not
     * the binding row or the "most representative context" LATERAL pick.
     *
     * Without this scoping the chat page would render conversation A's
     * runtime view using whichever context happened to win the LATERAL's
     * priority ordering (running > idle > error > offline, then most
     * recent activity), so a parallel conversation B that was running
     * would shadow A's true state and vice versa. Core execution is
     * already isolated per-conversation (one CC/Codex session each), but
     * the user-visible state read path was still binding/global.
     */
    conversationId?: string | null
    queryable?: Executor
  } = {}
) {
  return repo.loadRemoteAgentRuntimeSnapshotRepo(remoteAgentId, {
    conversationId: options.conversationId,
    executor: options.queryable,
  })
}

async function emitRemoteAgentRuntimeUpdated(
  remoteAgentId: string,
  queryable?: Executor
) {
  const snapshot = await loadRemoteAgentRuntimeSnapshot(remoteAgentId, {
    queryable,
  })
  if (!snapshot) {
    return null
  }
  const recipients = await repo.loadRuntimeUpdateRecipientsRepo(
    remoteAgentId,
    queryable
  )
  for (const recipient of recipients) {
    await repo.appendRuntimeUpdatedSyncEventRepo(
      {
        workspaceId: recipient.workspaceId,
        workspaceMemberId: recipient.workspaceMemberId,
        remoteAgentId,
        snapshot,
      },
      queryable
    )
  }
  return snapshot
}

async function toRemoteAgentRecord(
  row: RemoteAgentRow
): Promise<RemoteAgentRecord> {
  return repo.toRemoteAgentRecordRepo(row)
}

export async function listRemoteAgents(params: {
  workspaceId: string
  userId: string
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const visibleIds = await listAuthorizedResourceIdsDefault({
    subject: {
      type: "workspace_member",
      id: identity.workspaceMemberId,
    },
    action: "remote_agent.view",
  })
  if (visibleIds.length === 0) {
    return { remoteAgents: [] }
  }
  const rows = await repo.listRemoteAgentRowsRepo(
    params.workspaceId,
    visibleIds
  )
  return {
    remoteAgents: await Promise.all(rows.map(toRemoteAgentRecord)),
  }
}

export async function getRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const allowed = await authorizeActionDefault({
    subject: {
      type: "workspace_member",
      id: identity.workspaceMemberId,
    },
    action: "remote_agent.view",
    resourceId: params.remoteAgentId,
  })
  if (!allowed) {
    throw new Error("Not allowed to view this remote agent")
  }
  const row = await repo.getRemoteAgentRowRepo(
    params.workspaceId,
    params.remoteAgentId
  )
  if (!row) {
    throw new Error("Remote agent not found")
  }
  return {
    remoteAgent: await toRemoteAgentRecord(row),
  }
}

export async function createRemoteAgent(params: {
  workspaceId: string
  userId: string
  displayName: string
  title: string
  description?: string
  runtimeKind: RemoteAgentRuntimeKind
  avatarFileId?: string
  avatarEmoji?: string
  isPublicShared?: boolean
  metadata?: Record<string, unknown>
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceResourceGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const remoteAgentId = crypto.randomUUID()
  const insertedRow = await repo.createRemoteAgentTx({
    remoteAgentId,
    workspaceId: params.workspaceId,
    displayName: params.displayName.trim(),
    ownerWorkspaceMemberId: identity.workspaceMemberId,
    title: params.title.trim(),
    description: params.description?.trim() || null,
    runtimeKind: params.runtimeKind,
    avatarFileId: params.avatarFileId ?? null,
    avatarEmoji: params.avatarEmoji ?? null,
    isPublicShared: params.isPublicShared === true,
    metadata: params.metadata ?? {},
    grants: params.grants ?? [],
  })
  return {
    remoteAgent: await toRemoteAgentRecord({
      ...insertedRow,
      workspaceId: params.workspaceId,
      displayName: params.displayName.trim(),
      ownerWorkspaceMemberId: identity.workspaceMemberId,
      isActive: true,
    }),
  }
}

export async function updateRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  displayName?: string
  title?: string
  description?: string | null
  avatarFileId?: string | null
  avatarEmoji?: string | null
  isPublicShared?: boolean
  isActive?: boolean
  metadata?: Record<string, unknown>
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const existing = await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })

  const nextMetadata = {
    ...(existing.remoteAgent.metadata ?? {}),
    ...(params.metadata ?? {}),
  }

  await repo.updateRemoteAgentRowRepo({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    title: params.title?.trim() || existing.remoteAgent.title,
    description:
      params.description === undefined
        ? (existing.remoteAgent.description ?? null)
        : params.description,
    avatarFileId:
      params.avatarFileId === undefined
        ? (existing.remoteAgent.avatarFileId ?? null)
        : params.avatarFileId,
    avatarEmoji:
      params.avatarEmoji === undefined
        ? (existing.remoteAgent.avatarEmoji ?? null)
        : params.avatarEmoji,
    isPublicShared:
      params.isPublicShared ?? existing.remoteAgent.isPublicShared,
    metadata: nextMetadata,
  })
  await repo.updateWorkspaceResourceRootDefault({
    id: params.remoteAgentId,
    displayName: params.displayName?.trim() || existing.remoteAgent.displayName,
    status:
      (params.isActive ?? existing.remoteAgent.isActive)
        ? "active"
        : "disabled",
  })
  return getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
}

export async function deleteRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  // Root lifecycle lives on workspace_resources. The detail row stays until purge.
  await repo.updateWorkspaceResourceRootDefault({
    id: params.remoteAgentId,
    status: "archived",
    deletedAt: new Date(),
  })
  return { deleted: true }
}

export async function createRemoteAgentMachinePairingSession(params: {
  workspaceId: string
  userId: string
  title?: string
  description?: string
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  const apiKey = `sk_machine_${randomBytes(24).toString("hex")}`
  const machine = await repo.createMachinePairingRepo({
    workspaceId: params.workspaceId,
    title: params.title?.trim() || "Remote Agent Machine",
    description: params.description?.trim() || null,
    apiKeyHash: hashMachineApiKey(apiKey),
    createdByWorkspaceMemberId: identity.workspaceMemberId,
  })

  return {
    machine,
    apiKey,
    daemonCommand: buildDaemonCommand(apiKey),
    oneClickCommands: buildDaemonOneClick(apiKey),
  }
}

export async function listRemoteAgentMachines(params: {
  workspaceId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const machines = await repo.listRemoteAgentMachinesRepo(params.workspaceId)
  return {
    machines,
  }
}

export async function getRemoteAgentMachine(params: {
  workspaceId: string
  machineId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const { machine, runtimeCatalog, bindings } =
    await repo.getRemoteAgentMachineDetailRepo({
      workspaceId: params.workspaceId,
      machineId: params.machineId,
    })

  if (!machine) {
    throw new Error("Machine not found")
  }

  return {
    machine,
    runtimeCatalog,
    bindings,
  }
}

export async function bindRemoteAgent(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  machineId: string
  runtimeKind: RemoteAgentRuntimeKind
  runtimePath?: string
  localRootPath?: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  const existing = await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
  if (!existing.remoteAgent.isActive) {
    throw new Error("Remote agent is inactive")
  }
  if (existing.remoteAgent.runtimeKind !== params.runtimeKind) {
    throw new Error("Binding runtime kind must match remote agent runtime kind")
  }

  const machineRow = await repo.loadMachineIdForBindCheckRepo({
    workspaceId: params.workspaceId,
    machineId: params.machineId,
  })
  if (!machineRow) {
    throw new Error("Machine not found")
  }

  const catalogEntry = await repo.loadRuntimeCatalogEntryForBindRepo({
    machineId: params.machineId,
    runtimeKind: params.runtimeKind,
  })

  if (!params.runtimePath) {
    if (!catalogEntry) {
      throw new Error("Machine has not reported runtime availability yet")
    }
    if (catalogEntry.status !== REMOTE_AGENT_RUNTIME_CATALOG_STATUS.AVAILABLE) {
      const detail = catalogEntry.lastError?.trim()
        ? `: ${catalogEntry.lastError.trim()}`
        : ""
      throw new Error(
        `Runtime ${params.runtimeKind} is not available on this machine (${catalogEntry.status})${detail}`
      )
    }
  }

  const effectiveRuntimePath =
    params.runtimePath ?? catalogEntry?.executablePath ?? null

  await repo.upsertBindingRepo({
    remoteAgentId: params.remoteAgentId,
    machineId: params.machineId,
    runtimeKind: params.runtimeKind,
    runtimePath: effectiveRuntimePath,
    localRootPath: params.localRootPath ?? null,
  })

  await startBoundRemoteAgents(params.machineId)
  return getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
}

export async function listRemoteAgentGroupTaskGrants(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
}) {
  await requireWorkspaceMemberIdentity(params.workspaceId, params.userId)
  await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
  const rows = await repo.listGroupTaskGrantsRepo(params.remoteAgentId)
  return {
    grants: rows.map((row) => ({
      ...row,
      avatarUrl: row.userAvatarFileId
        ? getFileUrlById(row.userAvatarFileId)
        : undefined,
    })),
  }
}

export async function updateRemoteAgentGroupTaskGrants(params: {
  workspaceId: string
  remoteAgentId: string
  userId: string
  workspaceMemberIds: string[]
}) {
  const identity = await requireWorkspaceMemberIdentity(
    params.workspaceId,
    params.userId
  )
  await getRemoteAgent({
    workspaceId: params.workspaceId,
    remoteAgentId: params.remoteAgentId,
    userId: params.userId,
  })
  const nextIds = [...new Set(params.workspaceMemberIds.filter(Boolean))]
  if (nextIds.length > 0) {
    const validIds = await repo.loadValidWorkspaceMemberIdsRepo(
      params.workspaceId,
      nextIds
    )
    if (validIds.length !== nextIds.length) {
      throw new Error("Some workspace members are invalid")
    }
  }

  await repo.replaceGroupTaskGrantsTx({
    remoteAgentId: params.remoteAgentId,
    createdByWorkspaceMemberId: identity.workspaceMemberId,
    workspaceMemberIds: nextIds,
  })

  return listRemoteAgentGroupTaskGrants(params)
}

/**
 * LINK the current request span (the daemon's task-create POST) to every
 * delivery-origin trace that fed the turn raising the task (§4.C). The daemon
 * already deduped by trace id (≤20); the request span itself is parented under
 * the single origin when the daemon sent a traceparent header.
 */
function linkTaskOriginCarriers(
  originCarriers: Array<{ traceparent: string; tracestate?: string }> = []
) {
  if (originCarriers.length === 0) return
  linkUpstreamTraces(
    originCarriers.map((carrier) => carrier.traceparent),
    "delivery_origin"
  )
}

export async function createRemoteAgentUserInputTask(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  runKey: string
  title: string
  instructions?: string
  questions: unknown[]
  expiresAt?: Timestamp
  originCarriers?: Array<{ traceparent: string; tracestate?: string }>
}) {
  const access = await authenticateMachineForRemoteAgent(params)
  linkTaskOriginCarriers(params.originCarriers)
  const conversationAccess =
    await requireRemoteAgentConversationAccessOnDefaultDb(
      params.conversationId,
      params.remoteAgentId
    )
  const runId = await ensureRemoteAgentRun({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    runKey: params.runKey,
    status: "running",
    statusText: "Waiting for user input",
  })
  const { createRemoteAgentUserInputTaskRequest } =
    await import("../tasks/service.js")
  const task = await createRemoteAgentUserInputTaskRequest({
    workspaceId: access.workspaceId,
    conversationId: params.conversationId,
    remoteAgentRunId: runId,
    requesterParticipantId: conversationAccess.participant.id,
    title: params.title,
    instructions: params.instructions,
    questions: normalizeRemoteAgentUserInputQuestions(params.questions),
    expiresAt: params.expiresAt,
  })
  await updateRemoteAgentRuntimeStatus(access.machineId, {
    type: "agent:status",
    remoteAgentId: params.remoteAgentId,
    state: REMOTE_AGENT_RUNTIME_STATE.WAITING_USER_INPUT,
    statusText: params.title,
    conversationId: params.conversationId,
    taskId: task.id,
    runKey: params.runKey,
  })
  return { task }
}

export async function createRemoteAgentPlanApprovalTask(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  runKey: string
  title: string
  summary?: string
  planMarkdown: string
  checklist?: unknown[]
  collaborationMode?: string
  collaborationState?: Record<string, unknown>
  expiresAt?: Timestamp
  originCarriers?: Array<{ traceparent: string; tracestate?: string }>
}) {
  const access = await authenticateMachineForRemoteAgent(params)
  linkTaskOriginCarriers(params.originCarriers)
  const conversationAccess =
    await requireRemoteAgentConversationAccessOnDefaultDb(
      params.conversationId,
      params.remoteAgentId
    )
  const runId = await ensureRemoteAgentRun({
    remoteAgentId: params.remoteAgentId,
    conversationId: params.conversationId,
    runKey: params.runKey,
    status: "running",
    statusText: "Waiting for plan approval",
  })
  const { createRemoteAgentPlanApprovalTaskRequest } =
    await import("../tasks/service.js")
  const task = await createRemoteAgentPlanApprovalTaskRequest({
    workspaceId: access.workspaceId,
    conversationId: params.conversationId,
    remoteAgentRunId: runId,
    requesterParticipantId: conversationAccess.participant.id,
    title: params.title,
    summary: params.summary,
    planMarkdown: params.planMarkdown,
    checklist: normalizeRemoteAgentPlanChecklist(params.checklist),
    collaborationMode: params.collaborationMode,
    collaborationState: params.collaborationState,
    expiresAt: params.expiresAt,
  })
  await updateRemoteAgentRuntimeStatus(access.machineId, {
    type: "agent:status",
    remoteAgentId: params.remoteAgentId,
    state: REMOTE_AGENT_RUNTIME_STATE.WAITING_PLAN_APPROVAL,
    statusText: params.title,
    conversationId: params.conversationId,
    taskId: task.id,
    runKey: params.runKey,
  })
  return { task }
}

export async function createRemoteAgentDeliveriesForItem(params: {
  workspaceId?: string
  conversationId: string
  itemId: string
  authorParticipantId?: string
  queryable?: Executor
}) {
  const participants = await repo.loadDeliveryTargetParticipantsRepo(
    {
      conversationId: params.conversationId,
      authorParticipantId: params.authorParticipantId ?? null,
      itemId: params.itemId,
    },
    params.queryable
  )

  for (const participant of participants) {
    await repo.insertDeliveryForParticipantRepo(
      {
        remoteAgentId: participant.remoteAgentId,
        conversationId: params.conversationId,
        itemId: params.itemId,
      },
      params.queryable
    )
  }
}

export async function notifyRemoteAgentDeliveriesForConversation(
  conversationId: string
) {
  await notifyPendingRemoteAgentDeliveries({
    conversationId,
  })
}

export async function listRemoteAgentConversations(params: {
  remoteAgentId: string
  machineKey: string
}) {
  await authenticateMachineForRemoteAgent(params)
  const rows = await repo.listRemoteAgentConversationsRepo(params.remoteAgentId)
  return {
    conversations: rows as RemoteAgentConversationRecord[],
  }
}

export async function checkRemoteAgentMessages(params: {
  remoteAgentId: string
  machineKey: string
  conversationId?: string
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const deliveries = await repo.checkRemoteAgentMessagesRepo({
    remoteAgentId: params.remoteAgentId,
    limit: Math.min(Math.max(params.limit ?? 100, 1), 500),
    conversationId: params.conversationId,
  })

  return {
    deliveries,
  }
}

export async function completeRemoteAgentDeliveries(params: {
  remoteAgentId: string
  machineKey: string
  deliveryIds: string[]
}) {
  const machine = await authenticateMachineForRemoteAgent(params)
  const uniqueIds = [...new Set(params.deliveryIds.filter(Boolean))]
  if (uniqueIds.length === 0) {
    return { completed: 0 }
  }

  const rows = await repo.loadDeliveriesToCompleteRepo({
    remoteAgentId: params.remoteAgentId,
    uniqueIds,
  })

  await repo.markDeliveriesCompletedRepo({
    remoteAgentId: params.remoteAgentId,
    uniqueIds,
  })
  clearInFlightDeliveries(
    machine.machineId,
    rows.map((row) => row.id)
  )

  // Signal the daemon to reclaim its FUNCTIONAL pending-delivery set for these
  // completions. This is F3's root fix: completion is observed ONLY api-side
  // (reverse-MCP check_messages / read_history), so without this frame the
  // daemon never releases a succeeded delivery and its origin_carriers collapse
  // to the whole conversation's history. Grouped by conversation; the carrier is
  // the reverse-MCP request that observed completion. A daemon-offline send is a
  // harmless no-op (sendToMachine returns false) — the retry worker re-notifies
  // and the daemon's FIFO carrier backstop bounds staleness. The daemon must NOT
  // clear its per-turn carrier snapshot on receipt (ruling R2): completion fires
  // mid-turn and the running turn's links survive until its epoch closes.
  const completedByConversation = new Map<string, string[]>()
  for (const row of rows) {
    const ids = completedByConversation.get(row.conversationId) ?? []
    ids.push(row.id)
    completedByConversation.set(row.conversationId, ids)
  }
  const completionCarrier = activeTraceCarrier()
  for (const [conversationId, deliveryIds] of completedByConversation) {
    sendToMachine(machine.machineId, {
      type: "agent:deliveries:completed",
      remoteAgentId: params.remoteAgentId,
      conversationId,
      deliveryIds,
      traceparent: completionCarrier?.traceparent,
      tracestate: completionCarrier?.tracestate,
    })
  }

  const byConversation = new Map<string, { sequence: number; itemId: string }>()
  for (const row of rows) {
    const sequence = Number(row.sequence)
    const existing = byConversation.get(row.conversationId)
    if (!existing || sequence > existing.sequence) {
      byConversation.set(row.conversationId, {
        sequence,
        itemId: row.itemId,
      })
    }
  }

  for (const [conversationId, state] of byConversation) {
    await repo.upsertConversationViewReadStateRepo({
      remoteAgentId: params.remoteAgentId,
      conversationId,
      itemId: state.itemId,
      sequence: state.sequence,
    })
  }

  return {
    completed: rows.length,
  }
}

export async function getRemoteAgentConversationHistory(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  afterSequence?: number
  beforeSequence?: number
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const access = await requireRemoteAgentConversationAccessOnDefaultDb(
    params.conversationId,
    params.remoteAgentId
  )

  const items = await listVisibleConversationItemsForParticipant({
    conversationId: params.conversationId,
    participantId: access.participant.id,
    afterSequence: params.afterSequence,
    beforeSequence: params.beforeSequence,
    limit: params.limit,
  })

  return {
    items,
  }
}

export async function sendRemoteAgentConversationMessage(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  clientMessageId?: string
  contentBlocks: any[]
  replyToItemId?: string
  metadata?: Record<string, unknown>
}) {
  await authenticateMachineForRemoteAgent(params)
  const item = await sendRemoteAgentConversationMessageUseCase(
    {
      remoteAgentId: params.remoteAgentId,
      conversationId: params.conversationId,
      clientMessageId: params.clientMessageId ?? crypto.randomUUID(),
      contentBlocks: params.contentBlocks,
      replyToItemId: params.replyToItemId,
      metadata: params.metadata,
    },
    {
      withTransaction: repo.withRemoteAgentTransaction,
      requireRemoteAgentConversationAccess,
      loadConversationHostWorkspaceId: repo.loadConversationHostWorkspaceIdRepo,
      sendConversationMessageFromParticipant,
    }
  )

  await notifyRemoteAgentDeliveriesForConversation(params.conversationId)

  return {
    item,
  }
}

export async function searchRemoteAgentMessages(params: {
  remoteAgentId: string
  machineKey: string
  conversationId: string
  query: string
  limit?: number
}) {
  await authenticateMachineForRemoteAgent(params)
  const access = await requireRemoteAgentConversationAccessOnDefaultDb(
    params.conversationId,
    params.remoteAgentId
  )

  const rows = await repo.searchRemoteAgentMessagesRepo({
    conversationId: params.conversationId,
    queryLike: `%${params.query.trim()}%`,
    participantId: access.participant.id,
    limit: Math.min(Math.max(params.limit ?? 20, 1), 100),
  })

  return {
    matches: rows.map((row) => ({
      itemId: row.id,
      sequence: Number(row.sequence),
    })),
  }
}

export async function notifyRemoteAgentTaskResolved(taskId: string) {
  return notifyRemoteAgentTaskResolvedUseCase(taskId, {
    getTaskSummary: getTaskSummaryLazy,
    loadActiveBindingMachineId: repo.loadActiveBindingMachineIdRepo,
    sendToMachine,
  })
}

function closeMachineConnection(
  connection: MachineConnection,
  code = 1008,
  reason = "closing"
) {
  try {
    if (
      connection.socket.readyState === 0 ||
      connection.socket.readyState === 1
    ) {
      connection.socket.close(code, reason)
    }
  } catch {}
}

async function finalizeMachineSession(
  connection: MachineConnection,
  closeReason?: string
) {
  const tracked = machineConnections.get(connection.machineId)
  if (tracked && tracked.fencingToken === connection.fencingToken) {
    machineConnections.delete(connection.machineId)
    deliveryInFlightByMachine.delete(connection.machineId)
  }
  await repo.closeMachineSessionRepo({
    sessionId: connection.sessionId,
    closeReason: closeReason ?? null,
  })
  if (!tracked || tracked.fencingToken !== connection.fencingToken) {
    return
  }
  await setMachineLifecycleState(
    connection.machineId,
    REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.OFFLINE
  )
  const bindings = await loadBoundRemoteAgentsForMachine(connection.machineId)
  for (const binding of bindings) {
    await repo.offlineBindingsForMachineRepo({
      remoteAgentId: binding.remoteAgentId,
      statusText: closeReason ?? "Daemon disconnected",
    })
    await emitRemoteAgentRuntimeUpdated(binding.remoteAgentId)
  }
}

export async function handleRemoteAgentDaemonConnection(
  socket: any,
  req: any,
  _app: FastifyInstance
) {
  const requestUrl = new URL(req.url, config.app.baseUrl)
  const apiKey = requestUrl.searchParams.get("key")?.trim() || ""
  const machine = await loadMachineByApiKey(apiKey)
  if (
    !machine ||
    machine.trustStatus !== REMOTE_AGENT_MACHINE_TRUST_STATUS.ACTIVE
  ) {
    try {
      socket.send(
        serializeRemoteAgentApiToDaemonMessage({
          type: "auth_error",
          message: "Invalid machine key",
        })
      )
    } catch {}
    try {
      socket.close(1008, "invalid machine key")
    } catch {}
    return
  }

  const existing = machineConnections.get(machine.id)
  if (existing) {
    try {
      existing.socket.send(
        serializeRemoteAgentApiToDaemonMessage({
          type: "fenced",
          reason: "superseded by newer daemon connection",
        })
      )
    } catch {}
    try {
      existing.socket.close(4001, "superseded")
    } catch {}
    machineConnections.delete(machine.id)
    await repo.closeSupersededMachineSessionRepo(existing.sessionId)
  }

  await repo.closeExistingMachineSessionsRepo(machine.id)

  const session = await repo.insertMachineSessionRepo({
    machineId: machine.id,
    remoteAddr: req.socket?.remoteAddress ?? null,
  })
  const sessionId = session.id
  const fencingToken = session.fencingToken

  const connection: MachineConnection = {
    machineId: machine.id,
    workspaceId: machine.workspaceId,
    sessionId,
    fencingToken,
    socket,
    ready: false,
  }
  machineConnections.set(machine.id, connection)
  await setMachineLifecycleState(
    machine.id,
    REMOTE_AGENT_MACHINE_LIFECYCLE_STATE.ONLINE
  )

  try {
    socket.send(
      serializeRemoteAgentApiToDaemonMessage({
        type: "connected",
        machineId: machine.id,
        sessionId,
        fencingToken,
      })
    )
  } catch {}

  socket.on("message", async (raw: any) => {
    const message = parseRemoteAgentMachineMessage(raw)
    if (!message) {
      return
    }

    // Fencing guard: once a newer daemon connects with the same machine key,
    // the older socket is closed via 4001, but in-flight messages from the
    // older connection can still arrive between "close initiated" and
    // "close completed". Drop them so they never write to DB or trigger
    // outbound traffic; only the current active connection (whose fencing
    // token matches the one we minted) gets to mutate state.
    const active = machineConnections.get(machine.id)
    if (!active || active.fencingToken !== fencingToken) {
      return
    }

    if (message?.type === "heartbeat") {
      await repo.heartbeatMachineSessionRepo(sessionId)
      try {
        socket.send(serializeRemoteAgentApiToDaemonMessage({ type: "pong" }))
      } catch {}
      return
    }

    if (message?.type === "ready") {
      await runMachineMessageSpan(machine.id, message, async () => {
        connection.ready = true
        await repo.markMachineSessionActiveRepo(sessionId)
        await upsertRuntimeCatalog(machine.id, message.runtimeCatalog)
        await startBoundRemoteAgents(machine.id)
      })
      return
    }

    if (message?.type === "runtime:catalog") {
      await runMachineMessageSpan(machine.id, message, async () => {
        await upsertRuntimeCatalog(machine.id, message.runtimeCatalog)
      })
      return
    }

    if (message?.type === "agent:session") {
      await runMachineMessageSpan(machine.id, message, async () => {
        const bindingRuntimeKind = await repo.loadBindingRuntimeKindRepo(
          message.remoteAgentId,
          machine.id
        )
        await updateConversationRuntimeStatus({
          remoteAgentId: message.remoteAgentId,
          conversationId: message.conversationId,
          runtimeKind: bindingRuntimeKind ?? null,
          state:
            typeof message.state === "string"
              ? (message.state as RemoteAgentRuntimeStateType)
              : REMOTE_AGENT_RUNTIME_STATE.RUNNING,
          sessionId:
            typeof message.sessionId === "string" ? message.sessionId : null,
        })
        await emitRemoteAgentRuntimeUpdated(message.remoteAgentId)
      })
      return
    }

    if (message?.type === "agent:status") {
      await runMachineMessageSpan(machine.id, message, async () => {
        await updateRemoteAgentRuntimeStatus(machine.id, message)
      })
    }
  })

  socket.on("close", async (_code: number, reason: Buffer) => {
    await finalizeMachineSession(
      connection,
      reason?.toString("utf8") || undefined
    )
  })

  socket.on("error", async (error: Error) => {
    await finalizeMachineSession(connection, error.message)
    closeMachineConnection(connection, 1011, error.message || "machine error")
  })
}

export function getMachineKeyFromHeaders(request: {
  headers: Record<string, unknown>
}) {
  return parseMachineKeyFromRequest(request)
}
