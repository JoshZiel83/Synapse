#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import WebSocket from "ws"
import { ClaudeDriver } from "./drivers/claude-driver.js"
import { CodexDriver } from "./drivers/codex-driver.js"
import { registerDriver, tryGetDriver } from "./drivers/registry.js"
import type {
  AgentSessionEvent,
  PermissionDecision,
  RuntimeCatalogEntry,
  RuntimeKind,
} from "./drivers/types.js"
import {
  ConversationRuntime,
  readBridgeState,
  type ConversationRuntimeCallbacks,
} from "./conversation-runtime.js"

registerDriver(new ClaudeDriver())
registerDriver(new CodexDriver())

type DaemonConfig = {
  serverUrl: string
  apiKey: string
  heartbeatMs: number
  logLevel: LogLevel
  proxyEnabled: boolean
  proxyUrl?: string
}

type AgentStartMessage = {
  type: "agent:start"
  remoteAgentId: string
  conversationId?: string
  runtimeKind: RuntimeKind
  runtimePath?: string | null
  localRootPath?: string | null
  sessionId?: string | null
  fencingToken?: string
  serverUrl?: string
}

type Delivery = {
  remoteAgentId: string
  deliveryId: string
  conversationId: string
  itemId: string
}

type DeliveryMessage = {
  type: "agent:deliver"
  deliveries: Delivery[]
}

type InteractionResolvedMessage = {
  type: "agent:interaction:resolved"
  remoteAgentId: string
  interactionId: string
  interaction: Record<string, unknown>
}

type ConnectedMessage = {
  type: "connected"
  machineId: string
  sessionId: string
  fencingToken?: string
}

type LogLevel = "error" | "warn" | "info" | "debug"

const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_RECONNECT_MS = 3_000
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

function formatLogMeta(meta?: Record<string, unknown>) {
  if (!meta || Object.keys(meta).length === 0) return ""
  try {
    return ` ${JSON.stringify(meta)}`
  } catch {
    return ""
  }
}

function log(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>
) {
  if (!shouldLog(level)) return
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${formatLogMeta(meta)}\n`
  process.stderr.write(line)
}

function maskSecret(value: string) {
  if (value.length <= 10) return value
  return `${value.slice(0, 8)}…${value.slice(-6)}`
}

function parseArgs(argv: string[]): DaemonConfig {
  const args = new Map<string, string>()
  let debug = false
  let proxyDisabled = false
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (!current?.startsWith("--")) continue
    if (current === "--debug") {
      debug = true
      continue
    }
    if (current === "--no-proxy") {
      proxyDisabled = true
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
  const proxyUrl = args.get("proxy-url") || process.env.SYNAPSE_AGENT_PROXY_URL

  if (!serverUrl) throw new Error("--server-url is required")
  if (!apiKey) throw new Error("--api-key is required")

  return {
    serverUrl,
    apiKey,
    heartbeatMs,
    logLevel,
    proxyEnabled: !proxyDisabled,
    proxyUrl: proxyUrl?.trim() || undefined,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    "The runtime's built-in request_user_input tool is wired to Synapse and will render an interaction card for the user when you call it.",
    "If the user explicitly asks you to use require user input, or asks for a multiple-choice clarification, use that built-in tool instead of replying that you cannot show a prompt.",
    "Call mcp__synapse__check_messages first.",
    "Then use mcp__synapse__read_history for the relevant conversation(s), reply with mcp__synapse__send_message when action is needed, and stop when finished.",
    "If there is nothing actionable, stop without sending any message.",
  ].join(" ")
}

function buildPlanApprovedPrompt(note?: string) {
  return [
    "The user approved your plan in Synapse.",
    note ? `Note from the user: ${note}` : "",
    "Continue with the approved work. Check messages first if needed, then proceed.",
  ]
    .filter(Boolean)
    .join(" ")
}

function buildPlanRevisionPrompt(note?: string) {
  return [
    "The user asked you to revise your plan in Synapse.",
    note ? `Feedback: ${note}` : "",
    "Review the conversation history, update your plan, and request approval again when ready.",
  ]
    .filter(Boolean)
    .join(" ")
}

function buildResolvedUserInputPrompt(interaction: Record<string, any>) {
  const title =
    typeof interaction.userInput?.title === "string"
      ? interaction.userInput.title.trim()
      : "User input"
  const questions = Array.isArray(interaction.userInput?.questions)
    ? interaction.userInput.questions
    : []
  const answerLines = questions
    .map((question: Record<string, any>) => {
      const prompt =
        typeof question.prompt === "string" && question.prompt.trim()
          ? question.prompt.trim()
          : typeof question.title === "string" && question.title.trim()
            ? question.title.trim()
            : typeof question.id === "string"
              ? question.id
              : "Question"
      const labels = Array.isArray(question.answer?.selectedOptionLabels)
        ? question.answer.selectedOptionLabels.filter(
            (value: unknown): value is string =>
              typeof value === "string" && value.trim().length > 0
          )
        : []
      const selected = labels.length > 0 ? labels.join(", ") : undefined
      const text =
        typeof question.answer?.text === "string" && question.answer.text.trim()
          ? question.answer.text.trim()
          : undefined
      const otherText =
        typeof question.answer?.otherText === "string" &&
        question.answer.otherText.trim()
          ? question.answer.otherText.trim()
          : undefined
      const value = [selected, text, otherText].filter(Boolean).join(" | ")
      return value ? `- ${prompt}: ${value}` : null
    })
    .filter((line: string | null): line is string => Boolean(line))
  return [
    `The Synapse user answered your input request: ${title}.`,
    answerLines.length > 0
      ? answerLines.join("\n")
      : "Review the latest conversation state for the submitted answers.",
    "Continue the task using those answers.",
  ].join("\n")
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
    entry.runtimeKind === "claude_code" ? "Claude Code" : "Codex CLI"
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

async function requestJson<T>(
  serverUrl: string,
  machineKey: string,
  pathname: string,
  init?: RequestInit
): Promise<T> {
  const url = new URL(pathname, serverUrl)
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${machineKey}`)
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "")
    throw new Error(
      `Remote-agent request failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText}` : ""}`
    )
  }
  return (await response.json()) as T
}

type LatestPlanDraft = {
  title: string
  summary?: string
  planMarkdown: string
  checklist?: Array<{ id?: string; text: string; done?: boolean }>
}

type PendingInteractionRecord = {
  interactionId: string
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
          this.send({ type: "heartbeat" })
        }, this.config.heartbeatMs)
      })

      ws.once("error", (error) => {
        log("error", "daemon", "WebSocket error", { error: error.message })
        cleanup()
        reject(error)
      })

      ws.on("message", async (raw) => {
        let message: any
        try {
          message = JSON.parse(String(raw))
        } catch {
          return
        }

        if (message?.type === "connected") {
          const connected = message as ConnectedMessage
          this.machineId = connected.machineId
          const runtimeCatalog = [
            (tryGetDriver("claude_code") ?? new ClaudeDriver()).detect(),
            (tryGetDriver("codex") ?? new CodexDriver()).detect(),
          ]
          log("info", "daemon", "Server accepted machine session", {
            machineId: connected.machineId,
            sessionId: connected.sessionId,
          })
          log("info", "daemon", "Runtime catalog detected", { runtimeCatalog })
          this.send({ type: "ready", runtimeCatalog })
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
          const start = message as AgentStartMessage
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
          return
        }

        if (
          message?.type === "agent:stop" &&
          typeof message.remoteAgentId === "string"
        ) {
          const agent = this.agents.get(message.remoteAgentId)
          if (agent) await agent.stopAll("server stop")
          return
        }

        if (message?.type === "agent:deliver") {
          const deliver = message as DeliveryMessage
          const byAgent = new Map<string, Delivery[]>()
          for (const delivery of deliver.deliveries ?? []) {
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

        if (message?.type === "agent:interaction:resolved") {
          const resolved = message as InteractionResolvedMessage
          const agent = this.agents.get(resolved.remoteAgentId)
          if (agent) await agent.resolveInteraction(resolved)
          return
        }
      })

      ws.once("close", () => {
        log("warn", "daemon", "WebSocket closed")
        cleanup()
        for (const agent of this.agents.values()) {
          void agent.stopAll("daemon disconnected")
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
  private runtimeKind: RuntimeKind = "claude_code"
  private runtimePath?: string
  private localRootPath?: string
  private stateDirectory = ""
  private readonly runtimes = new Map<string, ConversationRuntime>()
  private readonly pendingInteractions = new Map<
    string,
    PendingInteractionRecord
  >()
  private readonly latestPlanByConversation = new Map<string, LatestPlanDraft>()
  // Deliveries we've routed into a conversation runtime but haven't yet been
  // observed completing (via the chat-bridge complete-deliveries path) or
  // failing. On runtime crash / stop, we POST these back to the server's
  // fail-deliveries endpoint so the backoff worker can reschedule.
  private readonly pendingDeliveryIds = new Map<string, Set<string>>()

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
  }

  private drainPendingDeliveries(conversationId: string): string[] {
    const set = this.pendingDeliveryIds.get(conversationId)
    if (!set || set.size === 0) return []
    const ids = [...set]
    this.pendingDeliveryIds.delete(conversationId)
    return ids
  }

  private async reportDeliveryFailure(
    deliveryIds: string[],
    reason: string,
    conversationId?: string
  ) {
    if (deliveryIds.length === 0) return
    if (conversationId) {
      const set = this.pendingDeliveryIds.get(conversationId)
      if (set) {
        for (const id of deliveryIds) set.delete(id)
        if (set.size === 0) this.pendingDeliveryIds.delete(conversationId)
      }
    }
    try {
      await requestJson(
        this.params.config.serverUrl,
        this.params.config.apiKey,
        `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/fail-deliveries`,
        {
          method: "POST",
          body: JSON.stringify({ deliveryIds, reason: reason.slice(0, 2000) }),
        }
      )
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
        proxyEnabled: this.params.config.proxyEnabled,
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
      const deliveryIds = items.map((item) => item.deliveryId)
      this.trackPendingDeliveries(conversationId, deliveryIds)
      const hasRuntime = this.runtimes.has(conversationId)
      try {
        await this.ensureRuntimeForConversation({
          conversationId,
          // A fresh runtime starts with the bootstrap prompt, which already
          // instructs the agent to check_messages; piling another wake prompt
          // on top would duplicate the turn. An existing runtime needs the
          // wake nudge to notice new work.
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
        await this.reportDeliveryFailure(deliveryIds, message)
        continue
      }
      log(
        "debug",
        `remote-agent:${this.params.remoteAgentId}`,
        "Routed deliveries to conversation runtime",
        { conversationId, count: items.length }
      )
    }
  }

  async resolveInteraction(message: InteractionResolvedMessage) {
    const interaction = message.interaction || {}
    const pending = this.pendingInteractions.get(message.interactionId)
    if (!pending) {
      log(
        "warn",
        `remote-agent:${this.params.remoteAgentId}`,
        "Resolved interaction has no matching pending request; falling back to synthetic prompt",
        { interactionId: message.interactionId }
      )
      const conversationId =
        typeof (interaction as any).conversationId === "string"
          ? (interaction as any).conversationId
          : undefined
      if (!conversationId) return
      await this.applyResolvedInteractionFallback(
        conversationId,
        interaction as Record<string, any>
      )
      return
    }
    this.pendingInteractions.delete(message.interactionId)
    const runtime = this.runtimes.get(pending.conversationId)
    if (!runtime) {
      await this.applyResolvedInteractionFallback(
        pending.conversationId,
        interaction as Record<string, any>
      )
      return
    }

    if (pending.kind === "user_input") {
      const decision: PermissionDecision = {
        behavior: "allow",
        updatedInput: {
          ...(pending.originalInput ?? {}),
          answers: buildAnswerMap(interaction as Record<string, any>),
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
        await this.applyResolvedInteractionFallback(
          pending.conversationId,
          interaction as Record<string, any>
        )
      }
      return
    }

    // plan_approval
    const status =
      typeof (interaction as any).status === "string"
        ? (interaction as any).status
        : null
    const note =
      typeof (interaction as any).resolutionNote === "string"
        ? (interaction as any).resolutionNote
        : undefined
    const decision: PermissionDecision =
      status === "approved"
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
      await this.applyResolvedInteractionFallback(
        pending.conversationId,
        interaction as Record<string, any>
      )
    }
  }

  private async applyResolvedInteractionFallback(
    conversationId: string,
    interaction: Record<string, any>
  ) {
    const kind = typeof interaction.kind === "string" ? interaction.kind : null
    const status =
      typeof interaction.status === "string" ? interaction.status : null
    const note =
      typeof interaction.resolutionNote === "string"
        ? interaction.resolutionNote
        : undefined
    if (kind === "user_input" && status === "answered") {
      await this.ensureRuntimeForConversation({
        conversationId,
        wake: true,
        syntheticPrompt: buildResolvedUserInputPrompt(interaction),
      })
      return
    }
    if (
      kind === "plan_approval" &&
      (status === "approved" || status === "rejected")
    ) {
      const prompt =
        status === "approved"
          ? buildPlanApprovedPrompt(note)
          : buildPlanRevisionPrompt(note)
      await this.ensureRuntimeForConversation({
        conversationId,
        wake: true,
        syntheticPrompt: prompt,
      })
    }
  }

  async stopAll(reason: string) {
    for (const [conversationId, runtime] of this.runtimes) {
      try {
        await runtime.close(reason)
      } catch {}
      this.runtimes.delete(conversationId)
      const ids = this.drainPendingDeliveries(conversationId)
      if (ids.length > 0) {
        void this.reportDeliveryFailure(ids, reason, conversationId)
      }
    }
    this.publishStatus({
      conversationId: null,
      state: "offline",
      statusText: reason,
    })
  }

  private buildRuntimeCallbacks(): ConversationRuntimeCallbacks {
    return {
      onSessionStarted: (conversationId, sessionId) => {
        this.params.daemon.send({
          type: "agent:session",
          remoteAgentId: this.params.remoteAgentId,
          conversationId,
          sessionId,
        })
        this.publishStatus({
          conversationId,
          state: "running",
          statusText: "Session connected",
          sessionId,
        })
      },
      onAssistantMessage: (_conversationId, _text) => {
        // Assistant output is delivered to Synapse via the chat-bridge MCP send_message tool.
        // We don't republish it through WS to keep the control plane focused on lifecycle.
      },
      onTurnCompleted: (conversationId) => {
        this.publishStatus({
          conversationId,
          state: "idle",
          statusText: "Idle",
        })
      },
      onError: (conversationId, message) => {
        this.publishStatus({
          conversationId,
          state: "error",
          statusText: message,
          lastError: message,
        })
        const ids = this.drainPendingDeliveries(conversationId)
        if (ids.length > 0) {
          void this.reportDeliveryFailure(ids, message, conversationId)
        }
      },
      onUserInputRequested: async (conversationId, event) => {
        try {
          const runKey = `remote-agent:${this.params.remoteAgentId}:user-input:${randomUUID()}`
          const result = await requestJson<{
            interaction: { id: string }
          }>(
            this.params.config.serverUrl,
            this.params.config.apiKey,
            `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/interactions/user-input`,
            {
              method: "POST",
              body: JSON.stringify({
                conversationId,
                runKey,
                title: event.title,
                questions: event.questions,
              }),
            }
          )
          this.pendingInteractions.set(result.interaction.id, {
            interactionId: result.interaction.id,
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
            interactionId: result.interaction.id,
            runKey,
          })
        } catch (error) {
          this.publishStatus({
            conversationId,
            state: "error",
            statusText: error instanceof Error ? error.message : String(error),
            lastError: error instanceof Error ? error.message : String(error),
          })
        }
      },
      onPlanApprovalRequested: async (conversationId, event) => {
        try {
          const runKey = `remote-agent:${this.params.remoteAgentId}:plan:${randomUUID()}`
          const result = await requestJson<{
            interaction: { id: string }
          }>(
            this.params.config.serverUrl,
            this.params.config.apiKey,
            `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/interactions/plan-approval`,
            {
              method: "POST",
              body: JSON.stringify({
                conversationId,
                runKey,
                title: event.title,
                summary: event.summary,
                planMarkdown: event.planMarkdown,
                checklist: event.checklist,
              }),
            }
          )
          this.pendingInteractions.set(result.interaction.id, {
            interactionId: result.interaction.id,
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
            interactionId: result.interaction.id,
            runKey,
          })
        } catch (error) {
          this.publishStatus({
            conversationId,
            state: "error",
            statusText: error instanceof Error ? error.message : String(error),
            lastError: error instanceof Error ? error.message : String(error),
          })
        }
      },
      onPlanUpdated: (conversationId, event) => {
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
      },
      onClosed: (conversationId) => {
        this.runtimes.delete(conversationId)
      },
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
    interactionId?: string
    runKey?: string
    lastError?: string
  }) {
    const conversationId = params.conversationId ?? undefined
    const bridgeLast = conversationId
      ? readBridgeState(
          path.join(
            this.stateDirectory,
            "conversations",
            conversationId,
            "bridge-state.json"
          )
        ).lastConversationId
      : undefined
    this.params.daemon.send({
      type: "agent:status",
      remoteAgentId: this.params.remoteAgentId,
      state: params.state,
      statusText: params.statusText,
      conversationId: conversationId ?? bridgeLast ?? null,
      interactionId: params.interactionId ?? null,
      sessionId: params.sessionId ?? null,
      lastError: params.lastError ?? null,
      runKey: params.runKey ?? null,
      capabilities: this.runtimeCapabilities(),
    })
  }

  private runtimeCapabilities() {
    if (this.runtimeKind === "claude_code") {
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

function buildAnswerMap(interaction: Record<string, any>) {
  const answers: Record<string, string> = {}
  const questions = Array.isArray(interaction.userInput?.questions)
    ? interaction.userInput.questions
    : []
  for (const question of questions) {
    const prompt =
      typeof question?.prompt === "string" ? question.prompt : undefined
    if (!prompt) continue
    const answer = question?.answer
    const parts = [
      ...(Array.isArray(answer?.selectedOptionLabels)
        ? answer.selectedOptionLabels.map((value: unknown) => String(value))
        : []),
      typeof answer?.otherText === "string" ? answer.otherText : undefined,
      typeof answer?.text === "string" ? answer.text : undefined,
    ].filter((value): value is string => Boolean(value))
    if (parts.length > 0) {
      answers[prompt] = parts.join(", ")
    }
  }
  return answers
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
