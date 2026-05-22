#!/usr/bin/env node

import {
  spawn,
  execFileSync,
  execSync,
  type ChildProcess,
} from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

type RuntimeKind = "claude_code" | "codex"

type RuntimeCatalogEntry = {
  runtimeKind: RuntimeKind
  executablePath?: string
  status:
    | "available"
    | "missing_binary"
    | "broken_path"
    | "unsupported_platform"
    | "runtime_error"
  version?: string
  metadata?: Record<string, unknown>
  lastError?: string
}

type DaemonConfig = {
  serverUrl: string
  apiKey: string
  heartbeatMs: number
  logLevel: LogLevel
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

type DeliveryMessage = {
  type: "agent:deliver"
  deliveries: Delivery[]
}

type InteractionResolvedMessage = {
  type: "agent:interaction:resolved"
  remoteAgentId: string
  interactionId: string
  interaction: Record<string, any>
}

type ConnectedMessage = {
  type: "connected"
  machineId: string
  sessionId: string
}

type Delivery = {
  remoteAgentId: string
  deliveryId: string
  conversationId: string
  itemId: string
}

type DriverEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "turn_end" }
  | { kind: "error"; message: string }
  | { kind: "control_request"; requestId: string; request: Record<string, any> }
  | {
      kind: "codex_server_request"
      requestId: string | number
      method: string
      params: Record<string, any>
    }
  | {
      kind: "plan_updated"
      explanation?: string
      plan: Array<{ step: string; status: string }>
    }

type SpawnContext = {
  prompt: string
  remoteAgentId: string
  serverUrl: string
  machineKey: string
  runtimePath?: string
  workingDirectory: string
  chatBridgePath: string
  bridgeStatePath: string
  sessionId?: string
}

type DriverLaunch = {
  process: ChildProcess
}

type LogLevel = "error" | "warn" | "info" | "debug"

interface RuntimeDriver {
  readonly runtimeKind: RuntimeKind
  readonly supportsPersistentSession: boolean
  spawn(context: SpawnContext): DriverLaunch
  parseOutputLine(line: string): DriverEvent[]
  encodeWakeMessage?(text: string, sessionId?: string): string | null
  destroy?(): void
}

type SessionState = {
  sessionId?: string
  pendingInteraction?: PendingInteraction
  latestPlanDraft?: LatestPlanDraft | null
  lastConversationId?: string
}

const DEFAULT_HEARTBEAT_MS = 30_000
const DEFAULT_RECONNECT_MS = 3_000
const MACHINE_DIR_ROOT = path.join(os.homedir(), ".synapse", "remote-agents")
const CHAT_BRIDGE_PATH = fileURLToPath(
  new URL("./chat-bridge.js", import.meta.url)
)
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

let activeLogLevel = resolveLogLevel(process.env.SYNAPSE_REMOTE_AGENT_LOG_LEVEL)

function shouldLog(level: LogLevel) {
  return LOG_LEVEL_WEIGHTS[level] <= LOG_LEVEL_WEIGHTS[activeLogLevel]
}

function formatLogMeta(meta?: Record<string, unknown>) {
  if (!meta || Object.keys(meta).length === 0) {
    return ""
  }
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
  if (!shouldLog(level)) {
    return
  }
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${formatLogMeta(meta)}\n`
  process.stderr.write(line)
}

function maskSecret(value: string) {
  if (value.length <= 10) {
    return value
  }
  return `${value.slice(0, 8)}…${value.slice(-6)}`
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
  const logLevel = debug
    ? "debug"
    : resolveLogLevel(
        args.get("log-level") || process.env.SYNAPSE_REMOTE_AGENT_LOG_LEVEL
      )

  if (!serverUrl) {
    throw new Error("--server-url is required")
  }
  if (!apiKey) {
    throw new Error("--api-key is required")
  }

  return {
    serverUrl,
    apiKey,
    heartbeatMs,
    logLevel,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ensureDirectory(directory: string) {
  mkdirSync(directory, { recursive: true })
}

function readSessionState(filePath: string): SessionState {
  try {
    if (!existsSync(filePath)) {
      return {}
    }
    const raw = readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as SessionState
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeSessionState(filePath: string, state: SessionState) {
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8")
}

function trimFirstLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
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
    "Call check_messages first.",
    "Then use read_history for the relevant conversation(s), reply with send_message when action is needed, and stop when finished.",
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
  workingDirectory: string
  stateDirectory: string
}) {
  return [
    `You are a Synapse RemoteAgent running as runtime ${params.runtimeKind}.`,
    `Remote agent id: ${params.remoteAgentId}.`,
    `Primary working directory: ${params.workingDirectory}.`,
    `Persistent session directory: ${params.stateDirectory}.`,
    "",
    "Use the MCP chat tools to communicate with Synapse:",
    "- check_messages",
    "- list_conversations",
    "- read_history",
    "- send_message",
    "- search_messages",
    "",
    "Rules:",
    "- Do not use shell, curl, or custom network requests to talk to Synapse; only use the MCP chat tools.",
    "- This agent can participate in multiple conversations at once.",
    "- Always call check_messages after a wake-up before deciding what to do.",
    "- Read enough history before replying so your response is grounded in the conversation.",
    "- If you need structured clarification or confirmation from the user, use the runtime's built-in user-input tool instead of asking in plain chat when that tool is available.",
    "- If there is no actionable work, stop without sending a message.",
    "",
    buildWakePrompt(),
  ].join("\n")
}

function splitLines(buffer: string) {
  const parts = buffer.split(/\r?\n/)
  const remainder = parts.pop() ?? ""
  return {
    lines: parts,
    remainder,
  }
}

function previewLine(value: string, maxLength = 280) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength)}...`
}

function safeJsonParse<T = any>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function buildInternalUrl(serverUrl: string, pathname: string) {
  return new URL(pathname, serverUrl)
}

async function requestJson<T>(
  serverUrl: string,
  machineKey: string,
  pathname: string,
  init?: RequestInit
): Promise<T> {
  const url = buildInternalUrl(serverUrl, pathname)
  const headers = new Headers(init?.headers)
  headers.set("authorization", `Bearer ${machineKey}`)
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  const response = await fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "")
    throw new Error(
      `Remote-agent request failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText}` : ""}`
    )
  }
  return (await response.json()) as T
}

function readBridgeState(filePath: string): {
  lastConversationId?: string
  lastToolName?: string
  updatedAt?: string
} {
  if (!filePath || !existsSync(filePath)) {
    return {}
  }
  const parsed = safeJsonParse<Record<string, any>>(
    readFileSync(filePath, "utf8")
  )
  if (!parsed || typeof parsed !== "object") {
    return {}
  }
  return {
    lastConversationId:
      typeof parsed.lastConversationId === "string"
        ? parsed.lastConversationId
        : undefined,
    lastToolName:
      typeof parsed.lastToolName === "string" ? parsed.lastToolName : undefined,
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
  }
}

function writeJsonLine(processRef: ChildProcess | null, payload: unknown) {
  if (!processRef?.stdin?.writable) {
    return false
  }
  processRef.stdin.write(`${JSON.stringify(payload)}\n`)
  return true
}

function stringifyRequestId(requestId: string | number) {
  return String(requestId)
}

function which(binary: string) {
  try {
    const command = process.platform === "win32" ? "where" : "which"
    const output = execSync(`${command} ${binary}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

function detectVersion(command: string, args: string[] = []) {
  try {
    const output = execFileSync(command, [...args, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    })
    return trimFirstLine(output)
  } catch {
    return undefined
  }
}

function detectClaudeRuntime(): RuntimeCatalogEntry {
  const explicit = process.env.SYNAPSE_CLAUDE_PATH?.trim()
  const executablePath = explicit || which("claude")
  if (!executablePath) {
    return {
      runtimeKind: "claude_code",
      status: "missing_binary",
    }
  }
  const version = detectVersion(executablePath)
  return {
    runtimeKind: "claude_code",
    executablePath,
    status: "available",
    version,
  }
}

function resolveWindowsCodexEntry() {
  const explicit = process.env.SYNAPSE_CODEX_PATH?.trim()
  if (explicit) {
    return explicit
  }

  try {
    const globalRoot = execSync("npm root -g", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const candidate = path.join(
      globalRoot,
      "@openai",
      "codex",
      "bin",
      "codex.js"
    )
    if (existsSync(candidate)) {
      return candidate
    }
  } catch {}

  const codexPath = which("codex")
  if (!codexPath) {
    return undefined
  }
  const fromCmdDir = path.join(
    path.dirname(codexPath),
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  )
  if (existsSync(fromCmdDir)) {
    return fromCmdDir
  }
  return codexPath
}

function detectCodexRuntime(): RuntimeCatalogEntry {
  const executablePath =
    process.platform === "win32"
      ? resolveWindowsCodexEntry()
      : process.env.SYNAPSE_CODEX_PATH?.trim() || which("codex")

  if (!executablePath) {
    return {
      runtimeKind: "codex",
      status: "missing_binary",
    }
  }

  const version =
    process.platform === "win32" && executablePath.endsWith(".js")
      ? detectVersion(process.execPath, [executablePath])
      : detectVersion(executablePath)

  return {
    runtimeKind: "codex",
    executablePath,
    status: "available",
    version,
  }
}

function detectRuntime(runtimeKind: RuntimeKind): RuntimeCatalogEntry {
  return runtimeKind === "claude_code"
    ? detectClaudeRuntime()
    : detectCodexRuntime()
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

class ClaudeDriver implements RuntimeDriver {
  readonly runtimeKind = "claude_code" as const
  readonly supportsPersistentSession = true

  spawn(context: SpawnContext): DriverLaunch {
    const mcpCommand = process.execPath
    const mcpArgs = [
      context.chatBridgePath,
      "--remote-agent-id",
      context.remoteAgentId,
      "--server-url",
      context.serverUrl,
      "--machine-key",
      context.machineKey,
      "--state-file",
      context.bridgeStatePath,
    ]

    const mcpConfig = JSON.stringify({
      mcpServers: {
        chat: {
          command: mcpCommand,
          args: mcpArgs,
        },
      },
    })

    let mcpConfigArg = mcpConfig
    if (process.platform === "win32") {
      const configPath = path.join(
        context.workingDirectory,
        ".synapse-claude-mcp.json"
      )
      writeFileSync(configPath, mcpConfig, "utf8")
      mcpConfigArg = configPath
    }

    const args = [
      "--print",
      "--verbose",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--mcp-config",
      mcpConfigArg,
    ]

    if (context.sessionId) {
      args.push("--resume", context.sessionId)
    }

    const child = spawn(context.runtimePath || "claude", args, {
      cwd: context.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      shell: process.platform === "win32",
    })

    writeJsonLine(child, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: context.prompt }],
      },
      ...(context.sessionId ? { session_id: context.sessionId } : {}),
    })

    return { process: child }
  }

  parseOutputLine(line: string) {
    const event = safeJsonParse<any>(line)
    if (!event) {
      return []
    }

    const events: DriverEvent[] = []
    if (
      event.type === "system" &&
      event.subtype === "init" &&
      event.session_id
    ) {
      events.push({ kind: "session", sessionId: String(event.session_id) })
    }
    if (
      event.type === "control_request" &&
      typeof event.request_id === "string" &&
      event.request &&
      typeof event.request === "object"
    ) {
      events.push({
        kind: "control_request",
        requestId: event.request_id,
        request: event.request,
      })
    }
    if (event.type === "result") {
      if (event.is_error && event.stop_reason !== "max_tokens") {
        events.push({
          kind: "error",
          message: String(
            event.result || event.errors?.[0] || "Claude execution failed"
          ),
        })
      }
      events.push({ kind: "turn_end" })
    }
    return events
  }

  encodeWakeMessage(text: string, sessionId?: string) {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      ...(sessionId ? { session_id: sessionId } : {}),
    })
  }
}

class CodexDriver implements RuntimeDriver {
  readonly runtimeKind = "codex" as const
  readonly supportsPersistentSession = false

  private child: ChildProcess | null = null

  private context: SpawnContext | null = null

  private requestSeq = 0

  private pendingRequests = new Map<
    string,
    | "initialize"
    | "collaborationMode/list"
    | "thread/start"
    | "thread/resume"
    | "turn/start"
  >()

  private currentThreadId?: string

  private currentModel?: string

  private threadConfig() {
    return {
      "features.default_mode_request_user_input": true,
    }
  }

  spawn(context: SpawnContext): DriverLaunch {
    const gitDirectory = path.join(context.workingDirectory, ".git")
    if (!existsSync(gitDirectory)) {
      execSync("git init", {
        cwd: context.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      })
      execSync('git add -A && git commit --allow-empty -m "init"', {
        cwd: context.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "synapse",
          GIT_AUTHOR_EMAIL: "synapse@local",
          GIT_COMMITTER_NAME: "synapse",
          GIT_COMMITTER_EMAIL: "synapse@local",
        },
      })
    }

    const bridgeCommand = process.execPath
    const bridgeArgs = [
      context.chatBridgePath,
      "--remote-agent-id",
      context.remoteAgentId,
      "--server-url",
      context.serverUrl,
      "--machine-key",
      context.machineKey,
      "--state-file",
      context.bridgeStatePath,
    ]

    const args = [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      `mcp_servers.chat.command=${JSON.stringify(bridgeCommand)}`,
      "-c",
      `mcp_servers.chat.args=${JSON.stringify(bridgeArgs)}`,
      "-c",
      "mcp_servers.chat.startup_timeout_sec=30",
      "-c",
      "mcp_servers.chat.tool_timeout_sec=300",
      "-c",
      "mcp_servers.chat.enabled=true",
      "-c",
      "mcp_servers.chat.required=true",
    ]

    const runtimePath = context.runtimePath || "codex"
    const isWindowsJsEntry =
      process.platform === "win32" && runtimePath.endsWith(".js")

    const child = isWindowsJsEntry
      ? spawn(process.execPath, [runtimePath, ...args], {
          cwd: context.workingDirectory,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
          },
        })
      : spawn(runtimePath, args, {
          cwd: context.workingDirectory,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
          },
          shell: process.platform === "win32",
        })

    this.child = child
    this.context = context
    this.requestSeq = 0
    this.pendingRequests.clear()
    this.currentThreadId = context.sessionId ?? undefined
    this.currentModel = undefined
    this.sendRequest("initialize", {
      clientInfo: {
        name: "synapse_remote_agent",
        title: "Synapse Remote Agent",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    })

    return { process: child }
  }

  parseOutputLine(line: string) {
    const event = safeJsonParse<any>(line)
    if (!event || typeof event !== "object") {
      return []
    }

    const events: DriverEvent[] = []
    if (event.id && "result" in event) {
      const requestId = String(event.id)
      const method = this.pendingRequests.get(requestId)
      this.pendingRequests.delete(requestId)
      switch (method) {
        case "initialize":
          this.sendNotification("initialized")
          this.sendRequest("collaborationMode/list", {})
          if (this.context?.sessionId) {
            this.sendRequest("thread/resume", {
              threadId: this.context.sessionId,
              cwd: this.context.workingDirectory,
              approvalPolicy: "never",
              config: this.threadConfig(),
            })
          } else {
            this.sendRequest("thread/start", {
              cwd: this.context?.workingDirectory,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              config: this.threadConfig(),
            })
          }
          break
        case "collaborationMode/list":
          break
        case "thread/start":
        case "thread/resume": {
          const thread = event.result?.thread
          const threadId =
            typeof thread?.id === "string"
              ? thread.id
              : typeof thread?.threadId === "string"
                ? thread.threadId
                : this.context?.sessionId
          if (threadId) {
            this.currentThreadId = threadId
            events.push({ kind: "session", sessionId: threadId })
          }
          if (typeof event.result?.model === "string") {
            this.currentModel = event.result.model
          }
          this.startTurn()
          break
        }
        case "turn/start":
          break
        default:
          break
      }
      return events
    }

    if (event.id && "error" in event) {
      events.push({
        kind: "error",
        message: String(
          event.error?.message || "Codex app-server request failed"
        ),
      })
      events.push({ kind: "turn_end" })
      return events
    }

    if (typeof event.method === "string" && "id" in event) {
      events.push({
        kind: "codex_server_request",
        requestId: event.id,
        method: event.method,
        params:
          event.params && typeof event.params === "object" ? event.params : {},
      })
      return events
    }

    if (typeof event.method === "string") {
      switch (event.method) {
        case "thread/started": {
          const threadId =
            typeof event.params?.thread?.id === "string"
              ? event.params.thread.id
              : undefined
          if (threadId) {
            events.push({ kind: "session", sessionId: threadId })
          }
          break
        }
        case "turn/plan/updated":
          events.push({
            kind: "plan_updated",
            explanation:
              typeof event.params?.explanation === "string"
                ? event.params.explanation
                : undefined,
            plan: Array.isArray(event.params?.plan)
              ? event.params.plan
                  .map((step: any) => ({
                    step: String(step?.step || ""),
                    status: String(step?.status || "pending"),
                  }))
                  .filter((step: { step: string }) => Boolean(step.step))
              : [],
          })
          break
        case "turn/completed":
          if (event.params?.turn?.error?.message) {
            events.push({
              kind: "error",
              message: String(event.params.turn.error.message),
            })
          }
          events.push({ kind: "turn_end" })
          break
        default:
          break
      }
      return events
    }

    return events
  }

  destroy() {
    this.child = null
    this.context = null
    this.pendingRequests.clear()
    this.currentThreadId = undefined
    this.currentModel = undefined
  }

  private sendRequest(
    method:
      | "initialize"
      | "collaborationMode/list"
      | "thread/start"
      | "thread/resume"
      | "turn/start",
    params: Record<string, unknown>
  ) {
    const requestId = `req-${++this.requestSeq}`
    this.pendingRequests.set(requestId, method)
    writeJsonLine(this.child, {
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    })
  }

  private sendNotification(method: string, params?: Record<string, unknown>) {
    writeJsonLine(this.child, {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    })
  }

  private startTurn() {
    if (!this.currentThreadId || !this.context) {
      return
    }
    this.sendRequest("turn/start", {
      threadId: this.currentThreadId,
      input: [
        {
          type: "text",
          text: this.context.prompt,
        },
      ],
      cwd: this.context.workingDirectory,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      collaborationMode: {
        mode: "default",
        settings: {
          model: this.currentModel || "gpt-5.4",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    })
  }
}

type PendingInteractionBase = {
  interactionId: string
  kind: "user_input" | "plan_approval"
  runKey: string
  conversationId: string
  toolName?: string
  originalInput?: Record<string, any>
}

type PendingInteraction =
  | (PendingInteractionBase & {
      protocol: "claude_permission"
      requestId: string
    })
  | (PendingInteractionBase & {
      protocol: "codex_request"
      requestId: string | number
    })

type LatestPlanDraft = {
  title: string
  summary?: string
  planMarkdown: string
  checklist?: Array<{ id?: string; text: string; done?: boolean }>
}

type RemoteAgentRuntimeState =
  | "offline"
  | "idle"
  | "running"
  | "waiting_user_input"
  | "plan_drafting"
  | "waiting_plan_approval"
  | "error"

function createDriver(runtimeKind: RuntimeKind): RuntimeDriver {
  return runtimeKind === "claude_code" ? new ClaudeDriver() : new CodexDriver()
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }
    this.ws.send(JSON.stringify(payload))
    return true
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
        log("error", "daemon", "WebSocket error", {
          error: error.message,
        })
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
          const runtimeCatalog = [detectClaudeRuntime(), detectCodexRuntime()]
          log("info", "daemon", "Server accepted machine session", {
            machineId: connected.machineId,
            sessionId: connected.sessionId,
          })
          log("info", "daemon", "Runtime catalog detected", {
            runtimeCatalog,
          })
          this.send({
            type: "ready",
            runtimeCatalog,
          })
          log("debug", "daemon", "Sent ready payload", {
            runtimeCount: runtimeCatalog.length,
          })
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
              runtimePath: start.runtimePath ?? undefined,
              localRootPath: start.localRootPath ?? undefined,
              sessionId: start.sessionId ?? undefined,
            }
          )
          const agent = this.getOrCreateAgent(start.remoteAgentId)
          await agent.configure(start)
          return
        }

        if (
          message?.type === "agent:stop" &&
          typeof message.remoteAgentId === "string"
        ) {
          log(
            "info",
            `remote-agent:${message.remoteAgentId}`,
            "Received agent:stop"
          )
          const agent = this.agents.get(message.remoteAgentId)
          if (agent) {
            agent.stop("server stop")
          }
          return
        }

        if (message?.type === "agent:deliver") {
          const deliver = message as DeliveryMessage
          const grouped = new Map<string, Delivery[]>()
          for (const delivery of deliver.deliveries ?? []) {
            const bucket = grouped.get(delivery.remoteAgentId) ?? []
            bucket.push(delivery)
            grouped.set(delivery.remoteAgentId, bucket)
          }
          for (const [remoteAgentId, deliveries] of grouped) {
            log(
              "info",
              `remote-agent:${remoteAgentId}`,
              "Received message deliveries",
              {
                count: deliveries.length,
                conversationIds: [
                  ...new Set(
                    deliveries.map((delivery) => delivery.conversationId)
                  ),
                ],
              }
            )
            const agent = this.getOrCreateAgent(remoteAgentId)
            await agent.enqueueDeliveries(deliveries)
          }
          return
        }

        if (message?.type === "agent:interaction:resolved") {
          const resolved = message as InteractionResolvedMessage
          log(
            "info",
            `remote-agent:${resolved.remoteAgentId}`,
            "Received resolved interaction",
            {
              interactionId: resolved.interactionId,
            }
          )
          const agent = this.agents.get(resolved.remoteAgentId)
          if (agent) {
            await agent.resolveInteraction(resolved)
          }
          return
        }
      })

      ws.once("close", () => {
        log("warn", "daemon", "WebSocket closed")
        cleanup()
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

  private sessionId?: string

  private process: ChildProcess | null = null

  private stdoutBuffer = ""

  private stderrBuffer = ""

  private running = false

  private pendingWake = false

  private readonly pendingDeliveryIds = new Set<string>()

  private readonly pendingDeliveries: Delivery[] = []

  private stateDirectory = ""

  private stateFile = ""

  private bridgeStateFile = ""

  private driver: RuntimeDriver | null = null

  private pendingInteraction: PendingInteraction | null = null

  private pendingSyntheticPrompts: string[] = []

  private latestPlanDraft: LatestPlanDraft | null = null

  private lastConversationId?: string

  constructor(
    private readonly params: {
      remoteAgentId: string
      daemon: DaemonSupervisor
      config: DaemonConfig
      getMachineId: () => string | null
    }
  ) {}

  async configure(message: AgentStartMessage) {
    this.runtimeKind = message.runtimeKind
    this.runtimePath = message.runtimePath ?? undefined
    this.localRootPath = message.localRootPath ?? undefined

    const machineId = this.params.getMachineId()
    if (!machineId) {
      throw new Error("Machine id is not ready")
    }

    this.stateDirectory = path.join(
      MACHINE_DIR_ROOT,
      machineId,
      this.params.remoteAgentId
    )
    this.stateFile = path.join(this.stateDirectory, "session.json")
    this.bridgeStateFile = path.join(this.stateDirectory, "bridge-state.json")
    ensureDirectory(this.stateDirectory)
    ensureDirectory(path.join(this.stateDirectory, "notes"))
    if (!existsSync(path.join(this.stateDirectory, "MEMORY.md"))) {
      writeFileSync(path.join(this.stateDirectory, "MEMORY.md"), "", "utf8")
    }

    const workingDirectory =
      this.localRootPath || path.join(this.stateDirectory, "workspace")
    ensureDirectory(workingDirectory)

    const storedState = readSessionState(this.stateFile)
    this.sessionId =
      message.sessionId ?? storedState.sessionId ?? this.sessionId
    this.pendingInteraction =
      storedState.pendingInteraction ?? this.pendingInteraction
    this.latestPlanDraft = storedState.latestPlanDraft ?? this.latestPlanDraft
    this.lastConversationId =
      message.conversationId ??
      storedState.lastConversationId ??
      this.lastConversationId
    log(
      "info",
      `remote-agent:${this.params.remoteAgentId}`,
      "Configured remote agent",
      {
        runtimeKind: this.runtimeKind,
        runtimePath: this.runtimePath ?? undefined,
        localRootPath: this.localRootPath ?? undefined,
        stateDirectory: this.stateDirectory,
        sessionId: this.sessionId ?? undefined,
      }
    )
    this.persistSession()
    if (this.pendingInteraction) {
      this.publishStatus(
        this.pendingInteraction.kind === "plan_approval"
          ? "waiting_plan_approval"
          : "waiting_user_input",
        "Waiting for a response in Synapse",
        this.pendingInteraction.conversationId
      )
      return
    }
    this.publishStatus("idle", "Ready", undefined)
  }

  stop(reason: string) {
    if (
      this.process &&
      (this.process.exitCode === null || this.process.killed === false)
    ) {
      this.process.kill()
    }
    this.process = null
    this.driver?.destroy?.()
    this.driver = null
    this.running = false
    this.pendingWake = false
    log(
      "warn",
      `remote-agent:${this.params.remoteAgentId}`,
      "Stopped remote agent",
      {
        reason,
      }
    )
    this.persistSession()
    this.publishStatus("offline", reason, undefined)
  }

  async enqueueDeliveries(deliveries: Delivery[]) {
    for (const delivery of deliveries) {
      if (this.pendingDeliveryIds.has(delivery.deliveryId)) continue
      this.pendingDeliveryIds.add(delivery.deliveryId)
      this.pendingDeliveries.push(delivery)
    }
    const uniqueConversationIds = [
      ...new Set(deliveries.map((delivery) => delivery.conversationId)),
    ]
    if (uniqueConversationIds.length === 1) {
      this.lastConversationId = uniqueConversationIds[0]
      this.persistSession()
    }
    log(
      "debug",
      `remote-agent:${this.params.remoteAgentId}`,
      "Queued deliveries",
      {
        pendingCount: this.pendingDeliveries.length,
      }
    )
    await this.wake()
  }

  async resolveInteraction(message: InteractionResolvedMessage) {
    const interaction = message.interaction || {}
    const pending =
      this.pendingInteraction?.interactionId === message.interactionId
        ? this.pendingInteraction
        : null
    const resolvedConversationId =
      typeof interaction.conversationId === "string" &&
      interaction.conversationId
        ? interaction.conversationId
        : pending?.conversationId

    if (!pending) {
      log(
        "warn",
        `remote-agent:${this.params.remoteAgentId}`,
        "Resolved interaction arrived without a matching pending request; falling back to a synthetic prompt",
        {
          interactionId: message.interactionId,
          status:
            typeof interaction.status === "string"
              ? interaction.status
              : undefined,
        }
      )
      await this.handleResolvedInteractionFallback(
        interaction,
        resolvedConversationId
      )
      return
    }

    log(
      "info",
      `remote-agent:${this.params.remoteAgentId}`,
      "Applying resolved interaction",
      {
        interactionId: message.interactionId,
        protocol: pending.protocol,
        kind: pending.kind,
        requestId: stringifyRequestId(pending.requestId),
        requestIdType: typeof pending.requestId,
      }
    )

    if (pending.protocol === "claude_permission") {
      const response =
        pending.kind === "user_input"
          ? {
              behavior: "allow",
              updatedInput: {
                ...(pending.originalInput || {}),
                answers: this.buildClaudeAnswerMap(interaction),
              },
              toolUseID: pending.originalInput?.tool_use_id,
            }
          : interaction.status === "approved"
            ? {
                behavior: "allow",
                updatedInput: pending.originalInput || {},
              }
            : {
                behavior: "deny",
                message:
                  interaction.resolutionNote ||
                  "The user asked you to revise the proposed plan.",
              }

      const wrote = writeJsonLine(this.process, {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: pending.requestId,
          response,
        },
      })
      if (!wrote) {
        log(
          "warn",
          `remote-agent:${this.params.remoteAgentId}`,
          "Failed to deliver resolved interaction to the live runtime; falling back to a synthetic prompt",
          {
            interactionId: message.interactionId,
            protocol: pending.protocol,
            requestId: pending.requestId,
          }
        )
        await this.handleResolvedInteractionFallback(
          interaction,
          pending.conversationId
        )
        return
      }
      this.pendingInteraction = null
      this.persistSession()
      log(
        "info",
        `remote-agent:${this.params.remoteAgentId}`,
        "Delivered resolved interaction to runtime",
        {
          interactionId: message.interactionId,
          protocol: pending.protocol,
          requestId: pending.requestId,
        }
      )
      this.publishStatus(
        "running",
        "Continuing after user input",
        pending.conversationId
      )
      return
    }

    if (pending.protocol === "codex_request") {
      if (pending.kind === "user_input") {
        const wrote = writeJsonLine(this.process, {
          jsonrpc: "2.0",
          id: pending.requestId,
          result: {
            answers: this.buildCodexAnswerMap(interaction),
          },
        })
        if (!wrote) {
          log(
            "warn",
            `remote-agent:${this.params.remoteAgentId}`,
            "Failed to deliver resolved interaction to the live runtime; falling back to a synthetic prompt",
            {
              interactionId: message.interactionId,
              protocol: pending.protocol,
              requestId: pending.requestId,
            }
          )
          await this.handleResolvedInteractionFallback(
            interaction,
            pending.conversationId
          )
          return
        }
        this.pendingInteraction = null
        this.persistSession()
        log(
          "info",
          `remote-agent:${this.params.remoteAgentId}`,
          "Delivered resolved interaction to runtime",
          {
            interactionId: message.interactionId,
            protocol: pending.protocol,
            requestId: pending.requestId,
          }
        )
        this.publishStatus(
          "running",
          "Continuing after user input",
          pending.conversationId
        )
        return
      }

      const note =
        typeof interaction.resolutionNote === "string"
          ? interaction.resolutionNote
          : undefined
      this.pendingInteraction = null
      this.persistSession()
      if (interaction.status === "approved") {
        this.pendingSyntheticPrompts.push(buildPlanApprovedPrompt(note))
      } else {
        this.pendingSyntheticPrompts.push(buildPlanRevisionPrompt(note))
      }
      this.latestPlanDraft = null
      this.persistSession()
      log(
        "info",
        `remote-agent:${this.params.remoteAgentId}`,
        "Queued plan interaction follow-up",
        {
          interactionId: message.interactionId,
          protocol: pending.protocol,
        }
      )
      this.publishStatus(
        "idle",
        "Plan decision received",
        pending.conversationId
      )
      await this.wake()
    }
  }

  private async handleResolvedInteractionFallback(
    interaction: Record<string, any>,
    conversationId?: string
  ) {
    const kind = typeof interaction.kind === "string" ? interaction.kind : null
    const status =
      typeof interaction.status === "string" ? interaction.status : null
    const note =
      typeof interaction.resolutionNote === "string"
        ? interaction.resolutionNote
        : undefined

    if (kind === "user_input" && status === "answered") {
      this.pendingInteraction = null
      this.pendingSyntheticPrompts.push(
        buildResolvedUserInputPrompt(interaction)
      )
      this.persistSession()
      this.publishStatus("idle", "Input received; resuming", conversationId)
      await this.wake()
      return
    }

    if (
      kind === "plan_approval" &&
      (status === "approved" || status === "rejected")
    ) {
      this.pendingInteraction = null
      this.latestPlanDraft = null
      this.pendingSyntheticPrompts.push(
        status === "approved"
          ? buildPlanApprovedPrompt(note)
          : buildPlanRevisionPrompt(note)
      )
      this.persistSession()
      this.publishStatus("idle", "Plan decision received", conversationId)
      await this.wake()
      return
    }

    log(
      "warn",
      `remote-agent:${this.params.remoteAgentId}`,
      "Resolved interaction could not be replayed",
      {
        interactionId:
          typeof interaction.id === "string" ? interaction.id : undefined,
        kind: kind ?? undefined,
        status: status ?? undefined,
      }
    )
  }

  private workingDirectory() {
    return this.localRootPath || path.join(this.stateDirectory, "workspace")
  }

  private persistSession() {
    if (!this.stateFile) return
    writeSessionState(this.stateFile, {
      sessionId: this.sessionId,
      pendingInteraction: this.pendingInteraction ?? undefined,
      latestPlanDraft: this.latestPlanDraft ?? undefined,
      lastConversationId: this.lastConversationId,
    })
  }

  private async wake() {
    if (!this.stateDirectory) {
      return
    }

    if (this.pendingInteraction) {
      return
    }

    const driver = this.driver ?? createDriver(this.runtimeKind)
    if (
      driver.supportsPersistentSession &&
      this.process &&
      !this.running &&
      typeof driver.encodeWakeMessage === "function"
    ) {
      const nextPrompt = this.nextPrompt()
      const wakeMessage = driver.encodeWakeMessage(nextPrompt, this.sessionId)
      if (wakeMessage && this.process.stdin?.writable) {
        this.pendingDeliveries.length = 0
        this.pendingDeliveryIds.clear()
        this.running = true
        this.pendingWake = false
        this.latestPlanDraft = null
        this.persistSession()
        log(
          "info",
          `remote-agent:${this.params.remoteAgentId}`,
          "Waking persistent session",
          {
            sessionId: this.sessionId ?? undefined,
          }
        )
        this.publishStatus(
          "running",
          "Checking unread messages",
          this.resolveConversationId()
        )
        this.process.stdin.write(`${wakeMessage}\n`)
        return
      }
    }

    if (this.running || this.pendingWake) {
      return
    }

    this.pendingWake = true
    log(
      "debug",
      `remote-agent:${this.params.remoteAgentId}`,
      "Scheduling new run",
      {
        sessionId: this.sessionId ?? undefined,
      }
    )
    this.startRun()
  }

  private startRun() {
    this.pendingWake = false
    this.running = true
    this.pendingDeliveries.length = 0
    this.pendingDeliveryIds.clear()
    this.latestPlanDraft = null
    this.persistSession()
    const resolvedRuntime = this.resolveRuntimePathForLaunch()
    if (!resolvedRuntime.ok) {
      this.running = false
      this.driver = null
      log(
        "error",
        `remote-agent:${this.params.remoteAgentId}`,
        "Runtime unavailable",
        {
          runtimeKind: this.runtimeKind,
          runtimePath: this.runtimePath ?? undefined,
          error: resolvedRuntime.error,
        }
      )
      this.publishStatus(
        "error",
        resolvedRuntime.error,
        this.resolveConversationId(),
        resolvedRuntime.error
      )
      return
    }

    const driver = createDriver(this.runtimeKind)
    this.driver = driver
    const prompt = this.nextPrompt()

    let launch: DriverLaunch
    try {
      log(
        "info",
        `remote-agent:${this.params.remoteAgentId}`,
        "Starting local runtime",
        {
          runtimeKind: this.runtimeKind,
          runtimePath: this.runtimePath ?? undefined,
          workingDirectory: this.workingDirectory(),
          sessionId: this.sessionId ?? undefined,
        }
      )
      launch = driver.spawn({
        prompt,
        remoteAgentId: this.params.remoteAgentId,
        serverUrl: this.params.config.serverUrl,
        machineKey: this.params.config.apiKey,
        runtimePath: resolvedRuntime.runtimePath,
        workingDirectory: this.workingDirectory(),
        chatBridgePath: CHAT_BRIDGE_PATH,
        bridgeStatePath: this.bridgeStateFile,
        sessionId: this.sessionId,
      })
    } catch (error) {
      this.running = false
      this.driver = null
      log(
        "error",
        `remote-agent:${this.params.remoteAgentId}`,
        "Failed to start local runtime",
        {
          error: error instanceof Error ? error.message : String(error),
        }
      )
      this.publishStatus(
        "error",
        error instanceof Error ? error.message : String(error),
        this.resolveConversationId(),
        error instanceof Error ? error.message : String(error)
      )
      return
    }

    this.process = launch.process
    this.stdoutBuffer = ""
    this.stderrBuffer = ""
    this.publishStatus(
      "running",
      "Processing messages",
      this.resolveConversationId()
    )

    let processErrored = false
    launch.process.once("error", (error: NodeJS.ErrnoException) => {
      processErrored = true
      this.process = null
      this.driver?.destroy?.()
      this.driver = null
      this.running = false
      const message =
        error.code === "ENOENT"
          ? `Failed to start ${this.runtimeKind}: executable not found`
          : error.message
      log(
        "error",
        `remote-agent:${this.params.remoteAgentId}`,
        "Runtime process error",
        {
          runtimeKind: this.runtimeKind,
          runtimePath: resolvedRuntime.runtimePath,
          error: error.message,
          code: error.code,
        }
      )
      this.publishStatus(
        "error",
        message,
        this.resolveConversationId(),
        error.message
      )
    })

    launch.process.stdout?.on("data", (chunk: Buffer | string) => {
      this.stdoutBuffer += String(chunk)
      const { lines, remainder } = splitLines(this.stdoutBuffer)
      this.stdoutBuffer = remainder
      for (const line of lines) {
        const preview = previewLine(line)
        if (preview) {
          log(
            "debug",
            `remote-agent:${this.params.remoteAgentId}`,
            "Runtime stdout",
            {
              preview,
            }
          )
        }
        for (const event of driver.parseOutputLine(line)) {
          void this.handleDriverEvent(event).catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error)
            log(
              "error",
              `remote-agent:${this.params.remoteAgentId}`,
              "Driver event handling failed",
              {
                message,
              }
            )
            this.publishStatus(
              "error",
              message,
              this.resolveConversationId(),
              message
            )
          })
        }
      }
    })

    launch.process.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk)
      this.stderrBuffer += text
      if (text.includes("No conversation found with session ID")) {
        this.sessionId = undefined
        this.persistSession()
      }
      const preview = trimFirstLine(text)
      if (preview) {
        log(
          "warn",
          `remote-agent:${this.params.remoteAgentId}`,
          "Runtime stderr",
          {
            preview,
          }
        )
      }
    })

    launch.process.once("exit", (code, signal) => {
      if (processErrored) {
        return
      }
      this.process = null
      const supportsPersistentSession =
        this.driver?.supportsPersistentSession === true
      this.driver?.destroy?.()
      if (!supportsPersistentSession) {
        this.driver = null
      }
      this.running = false
      log(
        "info",
        `remote-agent:${this.params.remoteAgentId}`,
        "Runtime process exited",
        {
          code: code ?? undefined,
          signal: signal ?? undefined,
          sessionId: this.sessionId ?? undefined,
        }
      )
      if (this.pendingInteraction) {
        this.publishStatus(
          this.pendingInteraction.kind === "plan_approval"
            ? "waiting_plan_approval"
            : "waiting_user_input",
          "Waiting for a response in Synapse",
          this.pendingInteraction.conversationId
        )
      } else if (
        this.pendingDeliveries.length > 0 ||
        this.pendingSyntheticPrompts.length > 0
      ) {
        void this.wake()
      } else {
        this.publishStatus("idle", "Idle", this.resolveConversationId())
      }
    })
  }

  private resolveRuntimePathForLaunch():
    | { ok: true; runtimePath?: string }
    | { ok: false; error: string } {
    if (this.runtimePath?.trim()) {
      return { ok: true, runtimePath: this.runtimePath.trim() }
    }
    const detected = detectRuntime(this.runtimeKind)
    if (detected.status !== "available" || !detected.executablePath) {
      return {
        ok: false,
        error: describeRuntimeCatalogIssue(detected),
      }
    }
    return {
      ok: true,
      runtimePath: detected.executablePath,
    }
  }

  private async handleDriverEvent(event: DriverEvent) {
    switch (event.kind) {
      case "session":
        if (this.sessionId !== event.sessionId) {
          this.sessionId = event.sessionId
          this.persistSession()
          log(
            "info",
            `remote-agent:${this.params.remoteAgentId}`,
            "Session updated",
            {
              sessionId: event.sessionId,
            }
          )
          this.params.daemon.send({
            type: "agent:session",
            remoteAgentId: this.params.remoteAgentId,
            conversationId: this.resolveConversationId(),
            sessionId: event.sessionId,
          })
        }
        this.publishStatus(
          this.running ? "running" : "idle",
          "Session connected",
          this.resolveConversationId()
        )
        break
      case "error":
        log(
          "error",
          `remote-agent:${this.params.remoteAgentId}`,
          "Runtime event error",
          {
            message: event.message,
          }
        )
        this.publishStatus(
          "error",
          event.message,
          this.resolveConversationId(),
          event.message
        )
        break
      case "turn_end":
        this.running = false
        log(
          "debug",
          `remote-agent:${this.params.remoteAgentId}`,
          "Runtime turn completed",
          {
            pendingCount: this.pendingDeliveries.length,
          }
        )
        if (this.process && !this.driver?.supportsPersistentSession) {
          this.process.kill()
        }
        if (this.latestPlanDraft) {
          await this.requestPlanApproval(this.latestPlanDraft)
          break
        }
        if (this.pendingInteraction) {
          break
        }
        if (
          this.pendingDeliveries.length > 0 ||
          this.pendingSyntheticPrompts.length > 0
        ) {
          void this.wake()
        } else {
          this.publishStatus("idle", "Idle", this.resolveConversationId())
        }
        break
      case "control_request":
        await this.handleClaudeControlRequest(event.requestId, event.request)
        break
      case "codex_server_request":
        await this.handleCodexServerRequest(
          event.requestId,
          event.method,
          event.params
        )
        break
      case "plan_updated":
        this.latestPlanDraft = {
          title: "Plan from Codex",
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
        }
        this.persistSession()
        this.publishStatus(
          "plan_drafting",
          "Drafting a plan",
          this.resolveConversationId()
        )
        break
      default:
        break
    }
  }

  private nextPrompt() {
    const synthetic = this.pendingSyntheticPrompts.shift()
    if (synthetic) {
      return synthetic
    }
    if (this.sessionId) {
      return buildWakePrompt()
    }
    return buildBootstrapPrompt({
      remoteAgentId: this.params.remoteAgentId,
      runtimeKind: this.runtimeKind,
      workingDirectory: this.workingDirectory(),
      stateDirectory: this.stateDirectory,
    })
  }

  private resolveConversationId() {
    const bridgeState = readBridgeState(this.bridgeStateFile)
    if (bridgeState.lastConversationId) {
      this.lastConversationId = bridgeState.lastConversationId
      this.persistSession()
      return bridgeState.lastConversationId
    }
    return this.lastConversationId
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

  private publishStatus(
    state: RemoteAgentRuntimeState,
    statusText?: string,
    conversationId?: string,
    lastError?: string
  ) {
    this.params.daemon.send({
      type: "agent:status",
      remoteAgentId: this.params.remoteAgentId,
      state,
      statusText,
      conversationId: conversationId ?? null,
      interactionId: this.pendingInteraction?.interactionId ?? null,
      sessionId: this.sessionId ?? null,
      lastError: lastError ?? null,
      runKey: this.pendingInteraction?.runKey ?? null,
      capabilities: this.runtimeCapabilities(),
    })
  }

  private async handleClaudeControlRequest(
    requestId: string,
    request: Record<string, any>
  ) {
    const subtype = String(request.subtype || "")
    switch (subtype) {
      case "initialize":
        writeJsonLine(this.process, {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: {
              commands: [],
              output_style: "normal",
              available_output_styles: ["normal"],
              models: [],
              account: {},
              pid: process.pid,
            },
          },
        })
        return
      case "set_model":
      case "set_max_thinking_tokens":
      case "set_permission_mode":
      case "interrupt":
        writeJsonLine(this.process, {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
          },
        })
        return
      case "elicitation":
        writeJsonLine(this.process, {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: {
              action: "cancel",
            },
          },
        })
        return
      case "can_use_tool":
        await this.handleClaudeToolPermissionRequest(requestId, request)
        return
      default:
        writeJsonLine(this.process, {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId,
            error: `Unsupported Claude control request subtype: ${subtype}`,
          },
        })
    }
  }

  private async handleClaudeToolPermissionRequest(
    requestId: string,
    request: Record<string, any>
  ) {
    const toolName = String(request.tool_name || "")
    const input =
      request.input && typeof request.input === "object"
        ? (request.input as Record<string, any>)
        : {}
    if (toolName === "AskUserQuestion") {
      const interaction = await this.createUserInputInteraction({
        requestId,
        protocol: "claude_permission",
        title:
          typeof input.questions?.[0]?.question === "string"
            ? input.questions[0].question
            : "Question from Claude",
        instructions: undefined,
        questions: Array.isArray(input.questions)
          ? input.questions.map((question: any, index: number) => ({
              id: `question-${index + 1}`,
              header: String(question?.header || `Question ${index + 1}`),
              type: question?.multiSelect ? "multi_select" : "single_select",
              prompt: String(question?.question || `Question ${index + 1}`),
              required: true,
              allowOther: true,
              options: Array.isArray(question?.options)
                ? question.options.map((option: any, optionIndex: number) => ({
                    id: `option-${index + 1}-${optionIndex + 1}`,
                    label: String(option?.label || `Option ${optionIndex + 1}`),
                    description:
                      typeof option?.description === "string"
                        ? option.description
                        : undefined,
                  }))
                : [],
            }))
          : [],
        toolName,
        originalInput: input,
      })
      this.pendingInteraction = interaction
      this.persistSession()
      this.publishStatus(
        "waiting_user_input",
        "Waiting for user input",
        interaction.conversationId
      )
      return
    }

    if (toolName === "ExitPlanMode") {
      const planMarkdown =
        typeof input.plan === "string" && input.plan.trim()
          ? input.plan
          : typeof input.planFilePath === "string" &&
              existsSync(input.planFilePath)
            ? readFileSync(input.planFilePath, "utf8")
            : ""
      const interaction = await this.createPlanApprovalInteraction({
        requestId,
        protocol: "claude_permission",
        title: "Plan from Claude",
        summary: "Claude wants approval before leaving plan mode.",
        planMarkdown: planMarkdown || "Claude did not provide a plan body.",
        checklist: undefined,
        toolName,
        originalInput: input,
      })
      this.pendingInteraction = interaction
      this.persistSession()
      this.publishStatus(
        "waiting_plan_approval",
        "Waiting for plan approval",
        interaction.conversationId
      )
      return
    }

    writeJsonLine(this.process, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "allow",
          updatedInput: input,
        },
      },
    })
  }

  private async handleCodexServerRequest(
    requestId: string | number,
    method: string,
    params: Record<string, any>
  ) {
    if (method === "item/tool/requestUserInput") {
      log(
        "info",
        `remote-agent:${this.params.remoteAgentId}`,
        "Codex requested user input",
        {
          requestId: stringifyRequestId(requestId),
          requestIdType: typeof requestId,
          questionCount: Array.isArray(params.questions)
            ? params.questions.length
            : 0,
        }
      )
      const interaction = await this.createUserInputInteraction({
        requestId,
        protocol: "codex_request",
        title:
          typeof params.questions?.[0]?.question === "string"
            ? params.questions[0].question
            : "Question from Codex",
        instructions: undefined,
        questions: Array.isArray(params.questions)
          ? params.questions.map((question: any, index: number) => ({
              id:
                typeof question?.id === "string"
                  ? question.id
                  : `question-${index + 1}`,
              header: String(question?.header || `Question ${index + 1}`),
              type: "single_select",
              prompt: String(question?.question || `Question ${index + 1}`),
              required: true,
              allowOther: Boolean(question?.isOther),
              secret: Boolean(question?.isSecret),
              options: Array.isArray(question?.options)
                ? question.options.map((option: any, optionIndex: number) => ({
                    id: `option-${index + 1}-${optionIndex + 1}`,
                    label: String(option?.label || `Option ${optionIndex + 1}`),
                    description:
                      typeof option?.description === "string"
                        ? option.description
                        : undefined,
                  }))
                : [],
            }))
          : [],
      })
      this.pendingInteraction = interaction
      this.persistSession()
      this.publishStatus(
        "waiting_user_input",
        "Waiting for user input",
        interaction.conversationId
      )
      return
    }

    if (method === "item/commandExecution/requestApproval") {
      writeJsonLine(this.process, {
        jsonrpc: "2.0",
        id: requestId,
        result: { decision: "accept" },
      })
      return
    }

    if (
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      writeJsonLine(this.process, {
        jsonrpc: "2.0",
        id: requestId,
        result: { decision: "accept" },
      })
      return
    }

    if (method === "mcpServer/elicitation/request") {
      writeJsonLine(this.process, {
        jsonrpc: "2.0",
        id: requestId,
        result: { action: "cancel", content: null },
      })
    }
  }

  private async createUserInputInteraction(
    params:
      | {
          requestId: string
          protocol: "claude_permission"
          title: string
          instructions?: string
          questions: Array<Record<string, any>>
          toolName?: string
          originalInput?: Record<string, any>
        }
      | {
          requestId: string | number
          protocol: "codex_request"
          title: string
          instructions?: string
          questions: Array<Record<string, any>>
          toolName?: string
          originalInput?: Record<string, any>
        }
  ): Promise<PendingInteraction> {
    const conversationId = this.resolveConversationId()
    if (!conversationId) {
      throw new Error(
        "Could not determine the active conversation for user input"
      )
    }
    const runKey = `remote-agent:${this.params.remoteAgentId}:user-input:${randomUUID()}`
    const result = await requestJson<{ interaction: Record<string, any> }>(
      this.params.config.serverUrl,
      this.params.config.apiKey,
      `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/interactions/user-input`,
      {
        method: "POST",
        body: JSON.stringify({
          conversationId,
          runKey,
          title: params.title,
          instructions: params.instructions,
          questions: params.questions,
        }),
      }
    )
    if (params.protocol === "claude_permission") {
      return {
        interactionId: String(result.interaction.id),
        kind: "user_input",
        protocol: "claude_permission",
        requestId: params.requestId,
        runKey,
        conversationId,
        toolName: params.toolName,
        originalInput: params.originalInput,
      }
    }
    return {
      interactionId: String(result.interaction.id),
      kind: "user_input",
      protocol: "codex_request",
      requestId: params.requestId,
      runKey,
      conversationId,
      toolName: params.toolName,
      originalInput: params.originalInput,
    }
  }

  private async createPlanApprovalInteraction(
    params:
      | {
          requestId: string
          protocol: "claude_permission"
          title: string
          summary?: string
          planMarkdown: string
          checklist?: Array<Record<string, any>>
          toolName?: string
          originalInput?: Record<string, any>
        }
      | {
          requestId: string | number
          protocol: "codex_request"
          title: string
          summary?: string
          planMarkdown: string
          checklist?: Array<Record<string, any>>
          toolName?: string
          originalInput?: Record<string, any>
        }
  ): Promise<PendingInteraction> {
    const conversationId = this.resolveConversationId()
    if (!conversationId) {
      throw new Error(
        "Could not determine the active conversation for plan approval"
      )
    }
    const runKey = `remote-agent:${this.params.remoteAgentId}:plan:${randomUUID()}`
    const result = await requestJson<{ interaction: Record<string, any> }>(
      this.params.config.serverUrl,
      this.params.config.apiKey,
      `/api/v1/internal/remote-agents/${this.params.remoteAgentId}/interactions/plan-approval`,
      {
        method: "POST",
        body: JSON.stringify({
          conversationId,
          runKey,
          title: params.title,
          summary: params.summary,
          planMarkdown: params.planMarkdown,
          checklist: params.checklist,
        }),
      }
    )
    if (params.protocol === "claude_permission") {
      return {
        interactionId: String(result.interaction.id),
        kind: "plan_approval",
        protocol: "claude_permission",
        requestId: params.requestId,
        runKey,
        conversationId,
        toolName: params.toolName,
        originalInput: params.originalInput,
      }
    }
    return {
      interactionId: String(result.interaction.id),
      kind: "plan_approval",
      protocol: "codex_request",
      requestId: params.requestId,
      runKey,
      conversationId,
      toolName: params.toolName,
      originalInput: params.originalInput,
    }
  }

  private async requestPlanApproval(planDraft: LatestPlanDraft) {
    try {
      const interaction = await this.createPlanApprovalInteraction({
        requestId: `plan-${randomUUID()}`,
        protocol: "codex_request",
        title: planDraft.title,
        summary: planDraft.summary,
        planMarkdown: planDraft.planMarkdown,
        checklist: planDraft.checklist,
      })
      this.pendingInteraction = interaction
      this.persistSession()
      this.publishStatus(
        "waiting_plan_approval",
        "Waiting for plan approval",
        interaction.conversationId
      )
    } catch (error) {
      log(
        "error",
        `remote-agent:${this.params.remoteAgentId}`,
        "Failed to create plan approval",
        {
          error: error instanceof Error ? error.message : String(error),
        }
      )
      this.publishStatus(
        "error",
        error instanceof Error ? error.message : String(error),
        this.resolveConversationId(),
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private buildClaudeAnswerMap(interaction: Record<string, any>) {
    const answers: Record<string, string> = {}
    const questions = Array.isArray(interaction.userInput?.questions)
      ? interaction.userInput.questions
      : []
    for (const question of questions) {
      const prompt =
        typeof question?.prompt === "string" ? question.prompt : undefined
      if (!prompt) {
        continue
      }
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

  private buildCodexAnswerMap(interaction: Record<string, any>) {
    const answers: Record<string, { answers: string[] }> = {}
    const questions = Array.isArray(interaction.userInput?.questions)
      ? interaction.userInput.questions
      : []
    for (const question of questions) {
      const questionId =
        typeof question?.id === "string" ? question.id : undefined
      if (!questionId) {
        continue
      }
      const answer = question?.answer
      const values = [
        ...(Array.isArray(answer?.selectedOptionLabels)
          ? answer.selectedOptionLabels.map((value: unknown) => String(value))
          : []),
        typeof answer?.otherText === "string" ? answer.otherText : undefined,
        typeof answer?.text === "string" ? answer.text : undefined,
      ].filter((value): value is string => Boolean(value))
      answers[questionId] = { answers: values }
    }
    return answers
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  activeLogLevel = config.logLevel
  ensureDirectory(MACHINE_DIR_ROOT)
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
