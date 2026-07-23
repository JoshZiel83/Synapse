#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import WebSocket from "ws"
// Type-only binding to the single source for the daemon↔API machine RPC
// contract. These are `import type` so they erase at build — the daemon takes
// NO runtime dependency on device-protocol (its published shrinkwrap stays
// unchanged); tsc statically checks every outbound snake_case body against the
// same schema the API parses inbound. The API is the runtime validator
// (separate trust domain).
import type {
  RemoteAgentMachineHeartbeatMessage,
  RemoteAgentMachineReadyMessage,
  RemoteAgentRuntimeCatalogEntryWire,
  RemoteAgentRuntimeCapabilityWire,
  RemoteAgentSessionMessage,
  RemoteAgentStatusMessage,
  RemoteAgentUserInputTaskBody,
  RemoteAgentPlanApprovalTaskBody,
  RemoteAgentFailDeliveriesBody,
} from "@synapse/device-protocol"
import { ClaudeDriver } from "./drivers/claude-driver.js"
import { CodexDriver } from "./drivers/codex-driver.js"
import { registerDriver, tryGetDriver } from "./drivers/registry.js"
import {
  activeWireTraceFields,
  detach,
  getTraceparent,
  runWithCarrier,
  runWithoutCarrier,
  type TraceCarrier,
} from "./trace-context.js"
import {
  buildFailDeliveriesReport,
  DeliveryCarrierMap,
} from "./delivery-carriers.js"
import { ConversationTurns } from "./conversation-turns.js"
import type {
  AgentSessionEvent,
  PermissionDecision,
  RuntimeCatalogEntry,
  RuntimeKind,
} from "./drivers/types.js"
import { RUNTIME_KIND } from "./drivers/types.js"
import {
  ConversationRuntime,
  type ConversationRuntimeCallbacks,
} from "./conversation-runtime.js"
import { buildResolvedPlanTaskFallbackPrompt } from "./resolved-task-fallback.js"
import {
  buildAnswerMap,
  buildResolvedUserInputPrompt,
  parseResolvedTaskPayload,
  type ResolvedTaskPayload,
} from "./resolved-task-payload.js"
import {
  RemoteAgentFailDeliveriesResponseSchema,
  RemoteAgentTaskCreateResponseSchema,
  requestJson,
} from "./api-client.js"
import {
  parseServerMessage,
  type AgentStartMessage,
  type DeliveriesCompletedMessage,
  type Delivery,
  type TaskResolvedMessage,
} from "./server-message-codec.js"

registerDriver(new ClaudeDriver())
registerDriver(new CodexDriver())

type DaemonConfig = {
  serverUrl: string
  apiKey: string
  heartbeatMs: number
  logLevel: LogLevel
  proxyUrl?: string
}

type LogLevel = "error" | "warn" | "info" | "debug"

type DaemonRuntimeCapabilities = {
  supportsRequestUserInput?: boolean
  supportsPlanMode?: boolean
  supportsPersistentSession?: boolean
  supportsCodexAppServer?: boolean
  supportsStructuredIo?: boolean
}

const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_RECONNECT_MS = 3_000
const MAX_PENDING_DELIVERY_IDS_PER_CONVERSATION = 500
const MACHINE_DIR_ROOT =
  process.env.SYNAPSE_REMOTE_AGENT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".synapse", "remote-agents")
const LOG_LEVEL_WEIGHTS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

function resolveLogLevel(value?: string): LogLevel {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === "error" ||
    normalized === "warn" ||
    normalized === "debug"
  ) {
    return normalized
  }
  return "info"
}

let activeLogLevel: LogLevel = resolveLogLevel(
  process.env.SYNAPSE_REMOTE_AGENT_LOG_LEVEL
)

function shouldLog(level: LogLevel) {
  return LOG_LEVEL_WEIGHTS[level] <= LOG_LEVEL_WEIGHTS[activeLogLevel]
}

function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>
) {
  if (!shouldLog(level)) return
  // Structured NDJSON to stderr (Alloy/Loki-parseable, consistent with the rest
  // of the system — the daemon's stderr is captured by Docker/Alloy in compose).
  // `service` identifies the daemon; `scope` is the per-agent tag
  // (e.g. remote-agent:<id>); the active turn's traceparent is echoed for
  // correlation. stdout is left clean by invariant (claude-driver passthrough).
  // Caller meta is spread FIRST so the fixed fields below always win — meta
  // can't clobber level/service/scope/msg/traceparent.
  const record: Record<string, unknown> = {
    ...(meta ?? {}),
    // datetime-ok: structured-log timestamp. The daemon intentionally keeps NO
    // device-protocol runtime dependency, so it cannot use the canonical helper.
    time: new Date().toISOString(),
    level,
    service: "remote-agent-daemon",
    scope,
    msg: message,
  }
  // The PER-TURN traceparent carried in the ALS (set from the api WS message /
  // delivery currently being handled), so each daemon log line joins the
  // specific request's trace in Loki/Tempo. Deliberately NO env fallback: the
  // spawn-env traceparent convention is retired repo-wide (no writer exists).
  const traceparent = getTraceparent()
  if (traceparent) record.traceparent = traceparent
  let line: string
  try {
    line = JSON.stringify(record)
  } catch {
    line = JSON.stringify({
      time: record.time,
      level,
      service: "remote-agent-daemon",
      scope,
      msg: message,
      metaError: "unserializable",
    })
  }
  process.stderr.write(`${line}\n`)
}

function maskSecret(value: string) {
  if (value.length <= 10) return value
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

// activeWireTraceFields (the machine-message `{traceparent, tracestate?}`
// stamping for ready / runtime:catalog / agent:session / agent:status — never
// heartbeat) lives in trace-context.ts, unit-tested there.

/** A WS frame's `{traceparent, tracestate?}` fields as a carrier, if traced. */
function frameCarrier(frame: {
  traceparent?: string
  tracestate?: string
}): TraceCarrier | undefined {
  if (!frame.traceparent) return undefined
  return frame.tracestate
    ? { traceparent: frame.traceparent, tracestate: frame.tracestate }
    : { traceparent: frame.traceparent }
}

function parseArgs(argv: string[]): DaemonConfig {
  const args = new Map<string, string>()
  let debug = false
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current?.startsWith("--")) continue
    if (current === "--debug") {
      debug = true
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) continue
    args.set(current.slice(2), next)
    index += 1
  }

  const serverUrl = args.get("server-url")?.trim() || ""
  const apiKey = args.get("api-key")?.trim() || ""
  const heartbeatMs = Math.max(
    5_000,
    Number.parseInt(args.get("heartbeat-ms") || "", 10) || DEFAULT_HEARTBEAT_MS
  )
  const logLevel: LogLevel = debug
    ? "debug"
    : resolveLogLevel(
        args.get("log-level") || process.env.SYNAPSE_REMOTE_AGENT_LOG_LEVEL
      )
  // Proxy is opt-in: pass --proxy-url (or set SYNAPSE_AGENT_PROXY_URL) to
  // inject proxy env vars into the claude / codex child processes. Without it
  // the child runs with the daemon's own outbound network. No default — a
  // daemon not on a tunnel host would dead-route every claude / codex API call
  // if we shipped one.
  const proxyUrl = args.get("proxy-url") || process.env.SYNAPSE_AGENT_PROXY_URL

  if (!serverUrl) throw new Error("--server-url is required")
  if (!apiKey) throw new Error("--api-key is required")

  return {
    serverUrl,
    apiKey,
    heartbeatMs,
    logLevel,
    proxyUrl: proxyUrl?.trim() || undefined,
  }
}

function ensureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true })
}

function toWsUrl(serverUrl: string) {
  const url = new URL("/ws/remote-agents", serverUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

function buildWakePrompt() {
  return [
    "You have unread Synapse messages.",
    "The runtime's built-in request_user_input tool is wired to Synapse and will render a task card for the user when you call it.",
    "If the user explicitly asks you to use require user input, or asks for a multiple-choice clarification, use that built-in tool instead of replying that you cannot show a prompt.",
    "Call mcp__synapse__check_messages first.",
    "Then use mcp__synapse__read_history for the relevant conversation(s), reply with mcp__synapse__send_message when action is needed, and stop when finished.",
    "If there is nothing actionable, stop without sending any message.",
  ].join(" ")
}

function buildBootstrapPrompt(params: {
  remoteAgentId: string
  runtimeKind: RuntimeKind
  conversationId: string
  workingDirectory: string
}) {
  return [
    `You are a Synapse RemoteAgent running as runtime ${params.runtimeKind}.`,
    `Remote agent id: ${params.remoteAgentId}.`,
    `Conversation id: ${params.conversationId}.`,
    `Primary working directory: ${params.workingDirectory}.`,
    "",
    "Use the MCP tools under the `synapse` server to communicate with Synapse:",
    "- mcp__synapse__check_messages",
    "- mcp__synapse__list_conversations",
    "- mcp__synapse__read_history",
    "- mcp__synapse__send_message",
    "- mcp__synapse__search_messages",
    "",
    "Rules:",
    "- Do not use shell, curl, or custom network requests to talk to Synapse; only use the MCP chat tools.",
    "- This runtime is scoped to a single conversation; do not address messages to other conversations.",
    "- Always call mcp__synapse__check_messages after a wake-up before deciding what to do.",
    "- Read enough history before replying so your response is grounded in the conversation.",
    "- If you need structured clarification or confirmation from the user, use the runtime's built-in user-input tool instead of asking in plain chat when that tool is available.",
    "- If there is no actionable work, stop without sending a message.",
    "",
    buildWakePrompt(),
  ].join("\n")
}

function describeRuntimeCatalogIssue(entry: RuntimeCatalogEntry) {
  const runtimeLabel =
    entry.runtimeKind === RUNTIME_KIND.CLAUDE_CODE ? "Claude Code" : "Codex CLI"
  switch (entry.status) {
    case "missing_binary":
      return `${runtimeLabel} is not installed or not on PATH for this machine`
    case "broken_path":
      return `${runtimeLabel} executable path is invalid`
    case "unsupported_platform":
      return `${runtimeLabel} is not supported on this platform`
    case "runtime_error":
      return entry.lastError?.trim() || `${runtimeLabel} runtime check failed`
    default:
      return `${runtimeLabel} is not available`
  }
}

function runtimeCatalogEntryToWire(
  entry: RuntimeCatalogEntry
): RemoteAgentRuntimeCatalogEntryWire {
  return {
    runtime_kind: entry.runtimeKind,
    executable_path: entry.executablePath,
    status: entry.status,
    version: entry.version,
    metadata: entry.metadata,
    last_error: entry.lastError,
  }
}

function runtimeCapabilitiesToWire(
  capabilities: DaemonRuntimeCapabilities
): RemoteAgentRuntimeCapabilityWire {
  return {
    supports_request_user_input: capabilities.supportsRequestUserInput,
    supports_plan_mode: capabilities.supportsPlanMode,
    supports_persistent_session: capabilities.supportsPersistentSession,
    supports_codex_app_server: capabilities.supportsCodexAppServer,
    supports_structured_io: capabilities.supportsStructuredIo,
  }
}

type LatestPlanDraft = {
  title: string
  summary?: string
  planMarkdown: string
  checklist?: Array<{ id?: string; text: string; done?: boolean }>
}

type PendingTaskRecord = {
  taskId: string
  kind: "user_input" | "plan_approval"
  remoteAgentId: string
  conversationId: string
  requestId: string
  toolName?: string
  originalInput?: Record<string, unknown>
}

class DaemonSupervisor {
  private ws: WebSocket | null = null
  private readonly agents = new Map<string, ManagedRemoteAgent>()
  private machineId: string | null = null

  constructor(private readonly config: DaemonConfig) {}

  async run() {
    log("info", "daemon", "Starting remote-agent daemon", {
      serverUrl: this.config.serverUrl,
      apiKey: maskSecret(this.config.apiKey),
      heartbeatMs: this.config.heartbeatMs,
      logLevel: activeLogLevel,
    })
    for (;;) {
      try {
        await this.connectOnce()
      } catch (error) {
        log("error", "daemon", "WebSocket loop failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      log("warn", "daemon", "Disconnected from server, retrying", {
        retryInMs: DEFAULT_RECONNECT_MS,
      })
      await sleep(DEFAULT_RECONNECT_MS)
    }
  }

  send(payload: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(payload))
    return true
  }

  get config_() {
    return this.config
  }

  get machineId_() {
    return this.machineId
  }

  private async connectOnce() {
    const wsUrl = toWsUrl(this.config.serverUrl)
    wsUrl.searchParams.set("key", this.config.apiKey)
    log("info", "daemon", "Connecting to server", {
      url: wsUrl
        .toString()
        .replace(this.config.apiKey, maskSecret(this.config.apiKey)),
    })

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      let heartbeatTimer: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
        this.ws = null
      }

      ws.once("open", () => {
        log("info", "daemon", "WebSocket connected")
        heartbeatTimer = setInterval(() => {
          this.send({
            type: "heartbeat",
          } satisfies RemoteAgentMachineHeartbeatMessage)
        }, this.config.heartbeatMs)
      })

      ws.once("error", (error) => {
        log("error", "daemon", "WebSocket error", { error: error.message })
        cleanup()
        reject(error)
      })

      ws.on("message", async (raw) => {
        const message = parseServerMessage(raw)
        if (!message) {
          return
        }

        if (message?.type === "connected") {
          this.machineId = message.machineId
          const runtimeCatalog = [
            (
              tryGetDriver(RUNTIME_KIND.CLAUDE_CODE) ?? new ClaudeDriver()
            ).detect(),
            (tryGetDriver(RUNTIME_KIND.CODEX) ?? new CodexDriver()).detect(),
          ]
          log("info", "daemon", "Server accepted machine session", {
            machineId: message.machineId,
            sessionId: message.sessionId,
          })
          log("info", "daemon", "Runtime catalog detected", { runtimeCatalog })
          this.send({
            type: "ready",
            runtime_catalog: runtimeCatalog.map(runtimeCatalogEntryToWire),
            ...activeWireTraceFields(),
          } satisfies RemoteAgentMachineReadyMessage)
          return
        }

        if (message?.type === "auth_error") {
          log("error", "daemon", "Server rejected machine session", {
            message: message.message,
          })
          try {
            ws.close(1008, message.message)
          } catch {}
          return
        }

        if (message?.type === "fenced") {
          log("warn", "daemon", "Server fenced this connection", {
            reason: message.reason,
          })
          try {
            ws.close(4001, "fenced")
          } catch {}
          return
        }

        if (message?.type === "pong") {
          log("debug", "daemon", "Received heartbeat pong")
          return
        }

        if (message?.type === "agent:start") {
          const start = message
          await runWithCarrier(frameCarrier(start), async () => {
            log(
              "info",
              `remote-agent:${start.remoteAgentId}`,
              "Received agent:start",
              {
                runtimeKind: start.runtimeKind,
                conversationId: start.conversationId,
                sessionId: start.sessionId ?? undefined,
              }
            )
            const agent = this.getOrCreateAgent(start.remoteAgentId)
            await agent.configure(start)
            if (start.conversationId) {
              // The turn this start drives is scoped to the start frame's
              // carrier (a non-delivery driver), so the agent's lifecycle
              // callbacks re-enter this trace via ConversationTurns.scoped.
              agent.noteTurnDriver(start.conversationId, frameCarrier(start))
              // Server only sends agent:start for pairs with pending work, so
              // bootstrapping the runtime here is enough — its initial prompt
              // tells the agent to call check_messages immediately, and the
              // subsequent agent:deliver (queued right after agent:start by
              // startBoundRemoteAgents) is a no-op while a wake is in flight.
              await agent.ensureRuntimeForConversation({
                conversationId: start.conversationId,
                resumeSessionId: start.sessionId ?? undefined,
                wake: false,
              })
            }
          })
          return
        }

        if (message?.type === "agent:stop") {
          const agent = this.agents.get(message.remoteAgentId)
          if (agent) await agent.stopAll("server stop")
          return
        }

        if (message?.type === "agent:deliver") {
          const byAgent = new Map<string, Delivery[]>()
          for (const delivery of message.deliveries ?? []) {
            const list = byAgent.get(delivery.remoteAgentId) ?? []
            list.push(delivery)
            byAgent.set(delivery.remoteAgentId, list)
          }
          for (const [remoteAgentId, deliveries] of byAgent) {
            const agent = this.getOrCreateAgent(remoteAgentId)
            await agent.enqueueDeliveries(deliveries)
          }
          return
        }

        if (message?.type === "agent:task:resolved") {
          const agent = this.agents.get(message.remoteAgentId)
          if (agent) {
            await runWithCarrier(frameCarrier(message), () =>
              agent.resolveTask(message)
            )
          }
          return
        }

        if (message?.type === "agent:deliveries:completed") {
          const completed = message
          const agent = this.agents.get(completed.remoteAgentId)
          if (agent) {
            // The api owns completion (observed reverse-MCP side); this frame
            // reclaims ONLY the daemon's functional pending-delivery set. It must
            // NOT touch the per-turn observability snapshot — completion fires
            // MID-TURN and the running turn's links must survive (ruling R2).
            runWithCarrier(frameCarrier(completed), () =>
              agent.reclaimCompletedDeliveries(completed)
            )
          }
        }
      })

      ws.once("close", () => {
        log("warn", "daemon", "WebSocket closed")
        cleanup()
        for (const agent of this.agents.values()) {
          // Context-free: ws-close is not a turn scope, and stopAll's onClosed
          // callbacks re-enter each conversation's own turn carrier.
          detach(() => agent.stopAll("daemon disconnected"))
        }
        resolve()
      })
    })
  }

  private getOrCreateAgent(remoteAgentId: string) {
    let agent = this.agents.get(remoteAgentId)
    if (!agent) {
      agent = new ManagedRemoteAgent({
        remoteAgentId,
        daemon: this,
        config: this.config,
        getMachineId: () => this.machineId,
      })
      this.agents.set(remoteAgentId, agent)
    }
    return agent
  }
}

class ManagedRemoteAgent {
  private runtimeKind: RuntimeKind = RUNTIME_KIND.CLAUDE_CODE
  private runtimePath?: string
  private localRootPath?: string
  private stateDirectory = ""
  private readonly runtimes = new Map<string, ConversationRuntime>()
  private readonly pendingTasks = new Map<string, PendingTaskRecord>()
  private readonly latestPlanByConversation = new Map<string, LatestPlanDraft>()
  // FUNCTIONAL crash-retry state: deliveries we've routed into a conversation
  // runtime but haven't yet reclaimed. Reclaimed by the api's
  // `agent:deliveries:completed` frame on success (forgetDeliveries) and drained
  // to the server's fail-deliveries endpoint on runtime crash / stop so the
  // backoff worker can reschedule. Capped per conversation (oldest-evicted).
  // This is SEPARATE from the observability turn snapshot below (ruling R2): a
  // completed delivery leaves this set but its carrier stays linkable until the
  // turn's epoch closes.
  private readonly pendingDeliveryIds = new Map<string, Set<string>>()
  // Per-DELIVERY W3C trace carriers (from the api's agent:deliver items). One
  // batch fans in deliveries from MANY requests, each with its own trace. Every
  // traced delivery keeps its own carrier here; the turn snapshot (`turns`)
  // references these by id. Reclaimed ONLY by the FIFO cap (a pure backstop) —
  // neither completion nor fail-back deletes carriers, so a mid-turn completion
  // cannot strip the running turn's origin links. stopAll clears it so nothing
  // leaks across reconnects.
  private readonly deliveryCarriers = new DeliveryCarrierMap()
  // OBSERVABILITY turn state: the deliveries + driver frame that raised the
  // current turn, per conversation. `originCarriers`/`scope` describe THIS turn
  // (not the whole conversation's history — the F3 collapse), and every
  // lifecycle callback re-enters the turn's carrier via `turns.scoped`. A turn
  // ends on turn_completed/close (`turns.end`), NOT on delivery completion.
  private readonly turns = new ConversationTurns(this.deliveryCarriers)

  constructor(
    private readonly params: {
      remoteAgentId: string
      daemon: DaemonSupervisor
      config: DaemonConfig
      getMachineId: () => string | null
    }
  ) {}

  private trackPendingDeliveries(
    conversationId: string,
    deliveryIds: string[]
  ) {
    if (deliveryIds.length === 0) return
    let set = this.pendingDeliveryIds.get(conversationId)
    if (!set) {
      set = new Set<string>()
      this.pendingDeliveryIds.set(conversationId, set)
    }
    for (const id of deliveryIds) set.add(id)
    // Bound the per-conversation set (oldest first — Set preserves insertion
    // order). An evicted id can no longer be failed-back on crash; the api's
    // retry worker re-notifies it, so this is loss-of-eagerness only.
    while (set.size > MAX_PENDING_DELIVERY_IDS_PER_CONVERSATION) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
      this.deliveryCarriers.delete(oldest)
    }
  }

  private drainPendingDeliveries(conversationId: string): string[] {
    const set = this.pendingDeliveryIds.get(conversationId)
    if (!set || set.size === 0) return []
    const ids = [...set]
    this.pendingDeliveryIds.delete(conversationId)
    return ids
  }

  /**
   * Record the driver frame that raised a non-delivery turn (agent:start with a
   * conversation / agent:task:resolved), so the turn's lifecycle callbacks link
   * that trace. Public because the driver frames are handled in the supervisor.
   */
  noteTurnDriver(conversationId: string, carrier: TraceCarrier | undefined) {
    this.turns.noteDriver(conversationId, carrier)
  }

  /**
   * Drop delivery ids from the FUNCTIONAL pending set ONLY. The single
   * ownership-exit point for the crash-retry set — used by the completion frame
   * and by fail-back. It deliberately does NOT touch the per-delivery carriers
   * or the turn snapshot (ruling R2): the carrier map is a FIFO backstop and the
   * turn snapshot lives until its epoch closes, so a completion/failure mid-turn
   * cannot strip the running turn's origin links.
   */
  private forgetDeliveries(conversationId: string, deliveryIds: string[]) {
    const set = this.pendingDeliveryIds.get(conversationId)
    if (!set) return
    for (const id of deliveryIds) set.delete(id)
    if (set.size === 0) this.pendingDeliveryIds.delete(conversationId)
  }

  /** Reclaim deliveries the api observed completing (pending set only). */
  reclaimCompletedDeliveries(message: DeliveriesCompletedMessage) {
    this.forgetDeliveries(message.conversationId, message.deliveryIds)
    log(
      "debug",
      `remote-agent:${this.params.remoteAgentId}`,
      "Reclaimed completed deliveries",
      {
        conversationId: message.conversationId,
        count: message.deliveryIds.length,
      }
    )
  }

  private async reportDeliveryFailure(
    deliveryIds: string[],
    reason: string,
    conversationId?: string
  ) {
    if (deliveryIds.length === 0) return
    // Reclaim the FUNCTIONAL pending set ONLY (ruling R2). The turn snapshot and
    // the per-delivery carriers are untouched — the failed delivery's own
    // carrier still rides the fail-deliveries body below, and the running turn's
    // origin links survive until the turn's epoch closes.
    if (conversationId) this.forgetDeliveries(conversationId, deliveryIds)
    // Every failed delivery carries ITS OWN originating carrier in the body (the
    // api LINKs each one), and the POST itself re-enters a carrier only when ALL
    // of them share one distinct trace (single-origin ⇒ parented; mixed ⇒ fresh
    // api-side root with per-delivery links) — `buildFailDeliveriesReport` is
    // the pure, unit-tested assembly (delivery-carriers.test.ts drives the C3a
    // repro). Double-report is prevented by the pending-set removal above (the
    // id is gone before the first await), not by deleting carriers.
    const { deliveries, scope } = buildFailDeliveriesReport(
      this.deliveryCarriers,
      deliveryIds
    )
    // Single-origin scope ⇒ the POST is parented under that one trace. An
    // undefined scope (mixed origins / untraced) MASKS any ambient carrier so
    // the POST carries NO traceparent header and the api creates a fresh root
    // with per-delivery links to ALL origins.
    const post = () =>
      requestJson(
        this.params.config.serverUrl,
        this.params.config.apiKey,
        `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/fail-deliveries`,
        {
          method: "POST",
          body: JSON.stringify({
            deliveries,
            reason: reason.slice(0, 2000),
          } satisfies RemoteAgentFailDeliveriesBody),
        },
        RemoteAgentFailDeliveriesResponseSchema
      )
    try {
      await (scope ? runWithCarrier(scope, post) : runWithoutCarrier(post))
    } catch (error) {
      log(
        "warn",
        `remote-agent:${this.params.remoteAgentId}`,
        "Failed to report delivery failure to server (will retry on next worker tick)",
        {
          deliveryIds,
          error: error instanceof Error ? error.message : String(error),
        }
      )
    }
  }

  async configure(message: AgentStartMessage) {
    this.runtimeKind = message.runtimeKind
    this.runtimePath = message.runtimePath ?? undefined
    this.localRootPath = message.localRootPath ?? undefined

    const machineId = this.params.getMachineId()
    if (!machineId) throw new Error("Machine id is not ready")

    this.stateDirectory = path.join(
      MACHINE_DIR_ROOT,
      machineId,
      this.params.remoteAgentId
    )
    ensureDirectory(this.stateDirectory)
    ensureDirectory(path.join(this.stateDirectory, "notes"))
    if (!existsSync(path.join(this.stateDirectory, "MEMORY.md"))) {
      writeFileSync(path.join(this.stateDirectory, "MEMORY.md"), "", "utf8")
    }
  }

  async ensureRuntimeForConversation(params: {
    conversationId: string
    resumeSessionId?: string
    wake?: boolean
    syntheticPrompt?: string
  }) {
    const driver = tryGetDriver(this.runtimeKind)
    if (!driver) {
      const reason = `No driver registered for ${this.runtimeKind}`
      this.publishStatus({
        conversationId: params.conversationId,
        state: "error",
        statusText: reason,
        lastError: reason,
      })
      throw new Error(reason)
    }
    const detected = driver.detect()
    const runtimePath = this.runtimePath?.trim() || detected.executablePath
    if (detected.status !== "available" || !runtimePath) {
      const reason = describeRuntimeCatalogIssue(detected)
      this.publishStatus({
        conversationId: params.conversationId,
        state: "error",
        statusText: reason,
        lastError: reason,
      })
      throw new Error(reason)
    }

    let runtime = this.runtimes.get(params.conversationId)
    const initialPrompt =
      params.syntheticPrompt ??
      buildBootstrapPrompt({
        remoteAgentId: this.params.remoteAgentId,
        runtimeKind: this.runtimeKind,
        conversationId: params.conversationId,
        workingDirectory: this.localRootPath ?? "",
      })
    if (!runtime) {
      runtime = new ConversationRuntime({
        remoteAgentId: this.params.remoteAgentId,
        conversationId: params.conversationId,
        runtimeKind: this.runtimeKind,
        runtimePath,
        rootDirectory: this.stateDirectory,
        localRootPath: this.localRootPath,
        serverUrl: this.params.config.serverUrl,
        machineKey: this.params.config.apiKey,
        proxyUrl: this.params.config.proxyUrl,
        resumeSessionId: params.resumeSessionId,
        initialPrompt,
        callbacks: this.buildRuntimeCallbacks(),
      })
      this.runtimes.set(params.conversationId, runtime)
    }
    await runtime.ensureStarted()
    if (params.wake) {
      await runtime.sendPrompt(params.syntheticPrompt ?? buildWakePrompt())
    }
    this.publishStatus({
      conversationId: params.conversationId,
      state: "running",
      statusText: "Processing messages",
    })
  }

  async enqueueDeliveries(deliveries: Delivery[]) {
    const byConversation = new Map<string, Delivery[]>()
    for (const delivery of deliveries) {
      const list = byConversation.get(delivery.conversationId) ?? []
      list.push(delivery)
      byConversation.set(delivery.conversationId, list)
    }
    for (const [conversationId, items] of byConversation) {
      // Remember EVERY traced delivery's own carrier (see the deliveryCarriers
      // doc) — within-batch contexts are preserved per delivery, not collapsed
      // into a last-writer-wins conversation slot. The routing work below runs
      // inside a carrier scope only when this conversation's slice of the
      // batch has ONE distinct origin trace; a mixed-origin slice runs
      // untraced (its failure report still carries every per-delivery
      // carrier).
      for (const item of items) {
        this.deliveryCarriers.set(item.deliveryId, frameCarrier(item))
      }
      const deliveryIds = items.map((item) => item.deliveryId)
      // The deliveries routed into this conversation ARE the current turn's
      // origins — the callbacks below read them via `turns` (not the whole
      // conversation's pending set, the F3 collapse).
      this.turns.noteDeliveries(conversationId, deliveryIds)
      const scope = this.deliveryCarriers.scopeFor(deliveryIds)
      await runWithCarrier(scope, async () => {
        this.trackPendingDeliveries(conversationId, deliveryIds)
        const hasRuntime = this.runtimes.has(conversationId)
        try {
          await this.ensureRuntimeForConversation({
            conversationId,
            // A fresh runtime starts with the bootstrap prompt, which already
            // instructs the agent to check_messages; piling another wake
            // prompt on top would duplicate the turn. An existing runtime
            // needs the wake nudge to notice new work.
            wake: hasRuntime,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(
            "error",
            `remote-agent:${this.params.remoteAgentId}`,
            "Routing deliveries to conversation runtime failed; reporting back to server",
            { conversationId, count: items.length, error: message }
          )
          await this.reportDeliveryFailure(deliveryIds, message, conversationId)
          return
        }
        log(
          "debug",
          `remote-agent:${this.params.remoteAgentId}`,
          "Routed deliveries to conversation runtime",
          { conversationId, count: items.length }
        )
      })
    }
  }

  async resolveTask(message: TaskResolvedMessage) {
    const task = parseResolvedTaskPayload(message.task)
    const pending = this.pendingTasks.get(message.taskId)
    // The task-resolver frame drives this turn (a non-delivery driver), so its
    // carrier scopes the conversation's continuation callbacks.
    const drivenConversationId = pending?.conversationId ?? task.conversationId
    if (drivenConversationId) {
      this.turns.noteDriver(drivenConversationId, frameCarrier(message))
    }
    if (!pending) {
      log(
        "warn",
        `remote-agent:${this.params.remoteAgentId}`,
        "Resolved task has no matching pending request; falling back to synthetic prompt",
        { taskId: message.taskId }
      )
      const conversationId = task.conversationId
      if (!conversationId) return
      await this.applyResolvedTaskFallback(conversationId, task)
      return
    }
    this.pendingTasks.delete(message.taskId)
    const runtime = this.runtimes.get(pending.conversationId)
    if (!runtime) {
      await this.applyResolvedTaskFallback(pending.conversationId, task)
      return
    }

    if (pending.kind === "user_input") {
      const decision: PermissionDecision = {
        behavior: "allow",
        updatedInput: {
          ...(pending.originalInput ?? {}),
          answers: buildAnswerMap(task),
        },
      }
      try {
        await runtime.respondPermission(pending.requestId, decision)
        this.publishStatus({
          conversationId: pending.conversationId,
          state: "running",
          statusText: "Continuing after user input",
        })
      } catch (error) {
        await this.applyResolvedTaskFallback(pending.conversationId, task)
      }
      return
    }

    // plan_approval
    const outcome = task.outcome ?? null
    const note = task.resolutionNote
    const decision: PermissionDecision =
      outcome === "approved"
        ? { behavior: "allow", updatedInput: pending.originalInput ?? {} }
        : {
            behavior: "deny",
            message: note || "The user asked you to revise the proposed plan.",
          }
    try {
      await runtime.respondPermission(pending.requestId, decision)
      this.latestPlanByConversation.delete(pending.conversationId)
      this.publishStatus({
        conversationId: pending.conversationId,
        state: "running",
        statusText: "Plan decision applied",
      })
    } catch (error) {
      this.latestPlanByConversation.delete(pending.conversationId)
      await this.applyResolvedTaskFallback(pending.conversationId, task)
    }
  }

  private async applyResolvedTaskFallback(
    conversationId: string,
    task: ResolvedTaskPayload
  ) {
    if (task.kind === "user_input" && task.lifecycleStatus === "completed") {
      await this.ensureRuntimeForConversation({
        conversationId,
        wake: true,
        syntheticPrompt: buildResolvedUserInputPrompt(task),
      })
      return
    }
    const planPrompt = buildResolvedPlanTaskFallbackPrompt(task)
    if (planPrompt) {
      await this.ensureRuntimeForConversation({
        conversationId,
        wake: true,
        syntheticPrompt: planPrompt,
      })
    }
  }

  async stopAll(reason: string) {
    // Snapshot the runtime keys — runtime.close() fires onClosed, which drains
    // + fail-reports the conversation's pending deliveries, ends the turn, and
    // deletes the runtime from the map (so deleting during iteration is avoided).
    for (const [conversationId, runtime] of [...this.runtimes]) {
      try {
        await runtime.close(reason)
      } catch {}
      this.runtimes.delete(conversationId)
    }
    // All runtimes are gone → drop every stashed carrier so the map cannot
    // grow across reconnects or leak a stale trace into a future turn.
    this.deliveryCarriers.clear()
    this.publishStatus({
      conversationId: null,
      state: "offline",
      statusText: reason,
    })
  }

  private buildRuntimeCallbacks(): ConversationRuntimeCallbacks {
    // Every callback fires from the CONTEXT-FREE detached drainEvents loop (F4),
    // so `this.turns.scoped` re-enters THIS callback's own per-turn carrier over
    // its WHOLE body (send/publishStatus/POST/log) — single-origin turn ⇒ that
    // trace, mixed/absent ⇒ masked (never inherited). Wrapping the whole body
    // (not just the POST) is what fixes publishStatus + activeWireTraceFields +
    // log together; a HOF cannot be half-applied inside a long body.
    return {
      onSessionStarted: this.turns.scoped(
        (conversationId: string, sessionId: string) => {
          this.params.daemon.send({
            type: "agent:session",
            remote_agent_id: this.params.remoteAgentId,
            conversation_id: conversationId,
            session_id: sessionId,
            ...activeWireTraceFields(),
          } satisfies RemoteAgentSessionMessage)
          // A fresh session means we're starting clean — any error from the
          // previous lifecycle is stale by definition. Use the empty-string
          // sentinel so the server clears last_error instead of preserving
          // (the COALESCE path) or leaving it alone.
          this.publishStatus({
            conversationId,
            state: "running",
            statusText: "Session connected",
            sessionId,
            lastError: "",
          })
        }
      ),
      onAssistantMessage: this.turns.scoped(
        (_conversationId: string, _text: string) => {
          // Assistant output is delivered to Synapse via the reverse-MCP
          // send_message tool (registered on the per-conversation McpServer).
          // We don't republish it through WS to keep the control plane focused
          // on lifecycle.
        }
      ),
      onTurnCompleted: this.turns.scoped(
        (conversationId: string, info: { hadError: boolean }) => {
          // Turn ended cleanly: clear last_error so the UI doesn't show a
          // stale alarm. Turn ended with an error: leave it alone (the
          // corresponding onError already wrote the message; we don't want
          // turn_completed to clobber it). The wire convention is:
          //   lastError: ""     -> server clears
          //   lastError: null   -> server preserves (COALESCE)
          //   lastError: "msg"  -> server sets
          this.publishStatus({
            conversationId,
            state: "idle",
            statusText: "Idle",
            lastError: info.hadError ? null : "",
          })
          // The turn's epoch closes here — its observability snapshot is dropped
          // (NOT on delivery completion; ruling R2). A later turn re-notes fresh.
          this.turns.end(conversationId)
        }
      ),
      onError: this.turns.scoped((conversationId: string, message: string) => {
        this.publishStatus({
          conversationId,
          state: "error",
          statusText: message,
          lastError: message,
        })
        const ids = this.drainPendingDeliveries(conversationId)
        if (ids.length > 0) {
          // Context-free fire-and-forget; reportDeliveryFailure re-establishes
          // its own single-origin/masked scope for the POST.
          detach(() => this.reportDeliveryFailure(ids, message, conversationId))
        }
      }),
      onUserInputRequested: this.turns.scoped(
        async (
          conversationId: string,
          event: Extract<AgentSessionEvent, { kind: "user_input_requested" }>
        ): Promise<void> => {
          try {
            const runKey = `remote-agent:${this.params.remoteAgentId}:user-input:${randomUUID()}`
            // The turn's origin carriers (deduped by trace id, ≤20) so the api can
            // LINK the task to each originating trace; the POST itself rides the
            // turn scope this callback already runs in (single-origin ⇒ parented;
            // mixed/absent ⇒ untraced fresh root with per-origin links).
            const originCarriers = this.turns.originCarriers(conversationId)
            const result = await requestJson(
              this.params.config.serverUrl,
              this.params.config.apiKey,
              `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/tasks/user-input`,
              {
                method: "POST",
                body: JSON.stringify({
                  conversation_id: conversationId,
                  run_key: runKey,
                  title: event.title,
                  questions: event.questions,
                  ...(originCarriers.length > 0
                    ? { origin_carriers: originCarriers }
                    : {}),
                } satisfies RemoteAgentUserInputTaskBody),
              },
              RemoteAgentTaskCreateResponseSchema
            )
            this.pendingTasks.set(result.task.id, {
              taskId: result.task.id,
              kind: "user_input",
              remoteAgentId: this.params.remoteAgentId,
              conversationId,
              requestId: event.requestId,
              toolName: event.toolName,
              originalInput: event.originalInput,
            })
            this.publishStatus({
              conversationId,
              state: "waiting_user_input",
              statusText: "Waiting for user input",
              taskId: result.task.id,
              runKey,
            })
          } catch (error) {
            this.publishStatus({
              conversationId,
              state: "error",
              statusText:
                error instanceof Error ? error.message : String(error),
              lastError: error instanceof Error ? error.message : String(error),
            })
          }
        }
      ),
      onPlanApprovalRequested: this.turns.scoped(
        async (
          conversationId: string,
          event: Extract<AgentSessionEvent, { kind: "plan_approval_requested" }>
        ): Promise<void> => {
          try {
            const runKey = `remote-agent:${this.params.remoteAgentId}:plan:${randomUUID()}`
            // Turn origin carriers + turn scope (see onUserInputRequested).
            const originCarriers = this.turns.originCarriers(conversationId)
            const result = await requestJson(
              this.params.config.serverUrl,
              this.params.config.apiKey,
              `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/tasks/plan-approval`,
              {
                method: "POST",
                body: JSON.stringify({
                  conversation_id: conversationId,
                  run_key: runKey,
                  title: event.title,
                  summary: event.summary,
                  plan_markdown: event.planMarkdown,
                  checklist: event.checklist,
                  ...(originCarriers.length > 0
                    ? { origin_carriers: originCarriers }
                    : {}),
                } satisfies RemoteAgentPlanApprovalTaskBody),
              },
              RemoteAgentTaskCreateResponseSchema
            )
            this.pendingTasks.set(result.task.id, {
              taskId: result.task.id,
              kind: "plan_approval",
              remoteAgentId: this.params.remoteAgentId,
              conversationId,
              requestId: event.requestId,
              toolName: event.toolName,
              originalInput: event.originalInput,
            })
            this.publishStatus({
              conversationId,
              state: "waiting_plan_approval",
              statusText: "Waiting for plan approval",
              taskId: result.task.id,
              runKey,
            })
          } catch (error) {
            this.publishStatus({
              conversationId,
              state: "error",
              statusText:
                error instanceof Error ? error.message : String(error),
              lastError: error instanceof Error ? error.message : String(error),
            })
          }
        }
      ),
      onPlanUpdated: this.turns.scoped(
        (
          conversationId: string,
          event: Extract<AgentSessionEvent, { kind: "plan_updated" }>
        ) => {
          this.latestPlanByConversation.set(conversationId, {
            title: "Plan",
            summary: event.explanation,
            planMarkdown: event.plan
              .map(
                (step) =>
                  `- [${step.status === "completed" ? "x" : " "}] ${step.step}`
              )
              .join("\n"),
            checklist: event.plan.map((step, index) => ({
              id: `plan-${index + 1}`,
              text: step.step,
              done: step.status === "completed",
            })),
          })
          this.publishStatus({
            conversationId,
            state: "plan_drafting",
            statusText: "Drafting a plan",
          })
        }
      ),
      onClosed: this.turns.scoped((conversationId: string, reason: string) => {
        this.runtimes.delete(conversationId)
        // Fix F3 extra-finding (a): a runtime close must drain + fail-report the
        // conversation's still-pending deliveries so the retry worker reschedules
        // (they were never leaked), then close the turn's epoch.
        const ids = this.drainPendingDeliveries(conversationId)
        if (ids.length > 0) {
          detach(() => this.reportDeliveryFailure(ids, reason, conversationId))
        }
        this.turns.end(conversationId)
      }),
    }
  }

  private publishStatus(params: {
    conversationId: string | null
    state:
      | "offline"
      | "idle"
      | "running"
      | "waiting_user_input"
      | "plan_drafting"
      | "waiting_plan_approval"
      | "error"
    statusText?: string
    sessionId?: string
    taskId?: string
    runKey?: string
    /**
     * Server interprets:
     *   "" (empty string)  -> clear last_error in DB
     *   non-empty string   -> set last_error
     *   undefined / null   -> COALESCE (preserve existing)
     */
    lastError?: string | null
  }) {
    const conversationId = params.conversationId ?? undefined
    this.params.daemon.send({
      type: "agent:status",
      remote_agent_id: this.params.remoteAgentId,
      state: params.state,
      status_text: params.statusText,
      conversation_id: conversationId ?? null,
      task_id: params.taskId ?? null,
      session_id: params.sessionId ?? null,
      last_error: params.lastError ?? null,
      run_key: params.runKey ?? null,
      capabilities: runtimeCapabilitiesToWire(this.runtimeCapabilities()),
      ...activeWireTraceFields(),
    } satisfies RemoteAgentStatusMessage)
  }

  private runtimeCapabilities(): DaemonRuntimeCapabilities {
    if (this.runtimeKind === RUNTIME_KIND.CLAUDE_CODE) {
      return {
        supportsRequestUserInput: true,
        supportsPlanMode: true,
        supportsPersistentSession: true,
        supportsStructuredIo: true,
      }
    }
    return {
      supportsRequestUserInput: true,
      supportsPlanMode: true,
      supportsPersistentSession: false,
      supportsCodexAppServer: true,
    }
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  activeLogLevel = config.logLevel
  ensureDirectory(MACHINE_DIR_ROOT)
  // Per-conversation runtimes spawn subprocesses (claude / codex) whose stdin
  // can disconnect mid-stream when the child exits (e.g. claude --print
  // terminates after a single turn or the codex app-server hits an internal
  // error). The SDKs surface those failures as EPIPE on the underlying socket,
  // which Node bubbles up as an uncaught exception by default and would tear
  // down the entire daemon, dropping every other conversation runtime that was
  // healthy. Catch them at process-scope so a single bad session degrades to a
  // logged error instead.
  process.on("uncaughtException", (error) => {
    const isEpipe =
      (error as NodeJS.ErrnoException)?.code === "EPIPE" ||
      /EPIPE|write after end/i.test(
        error instanceof Error ? error.message : String(error)
      )
    log(isEpipe ? "warn" : "error", "daemon", "uncaught exception", {
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException)?.code,
      ...(isEpipe
        ? {}
        : { stack: error instanceof Error ? error.stack : undefined }),
    })
  })
  process.on("unhandledRejection", (reason) => {
    log("error", "daemon", "unhandled rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
    })
  })
  const supervisor = new DaemonSupervisor(config)
  await supervisor.run()
}

main().catch((error) => {
  log("error", "daemon", "Daemon crashed", {
    error:
      error instanceof Error ? error.stack || error.message : String(error),
  })
  process.exit(1)
})
