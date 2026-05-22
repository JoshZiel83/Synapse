import { execFileSync, execSync } from "node:child_process"
import process from "node:process"
import {
  query as claudeAgentQuery,
  type CanUseTool,
  type McpServerConfig,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type {
  AgentDriver,
  AgentSession,
  AgentSessionEvent,
  PermissionDecision,
  RuntimeCatalogEntry,
  SendPromptOptions,
  SessionSpec,
} from "./types.js"

function trimFirstLine(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
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

function detectClaudeBinary(): { path?: string; version?: string } {
  const explicit = process.env.SYNAPSE_CLAUDE_PATH?.trim()
  const path = explicit || which("claude")
  if (!path) return {}
  let version: string | undefined
  try {
    version = trimFirstLine(
      execFileSync(path, ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      })
    )
  } catch {
    // version probe is best-effort
  }
  return { path, version }
}

type PendingPromptResolver = {
  resolve: (message: SDKUserMessage) => void
  reject: (error: Error) => void
}

class PromptInputQueue {
  private readonly queued: SDKUserMessage[] = []
  private readonly waiters: PendingPromptResolver[] = []
  private closed = false

  push(message: SDKUserMessage) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve(message)
      return
    }
    this.queued.push(message)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters) {
      waiter.reject(new Error("Prompt stream closed"))
    }
    this.waiters.length = 0
  }

  async *iterator(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const queued = this.queued.shift()
      if (queued) {
        yield queued
        continue
      }
      if (this.closed) return
      const next = await new Promise<SDKUserMessage>((resolve, reject) => {
        this.waiters.push({ resolve, reject })
      }).catch(() => null)
      if (!next) return
      yield next
    }
  }
}

class EventQueue {
  private readonly queued: AgentSessionEvent[] = []
  private readonly waiters: Array<(event: AgentSessionEvent | null) => void> =
    []
  private closed = false

  push(event: AgentSessionEvent) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(event)
      return
    }
    this.queued.push(event)
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters) waiter(null)
    this.waiters.length = 0
  }

  async *iterator(): AsyncGenerator<AgentSessionEvent> {
    while (true) {
      const queued = this.queued.shift()
      if (queued) {
        yield queued
        continue
      }
      if (this.closed) return
      const next = await new Promise<AgentSessionEvent | null>((resolve) => {
        this.waiters.push(resolve)
      })
      if (!next) return
      yield next
    }
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage
}

function buildPermissionResultForDecision(
  decision: PermissionDecision,
  toolUseID: string
): PermissionResult {
  if (decision.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput ?? {},
      toolUseID,
    }
  }
  return {
    behavior: "deny",
    message: decision.message,
    toolUseID,
  }
}

class ClaudeAgentSession implements AgentSession {
  readonly runtimeKind = "claude_code" as const

  private readonly eventQueue = new EventQueue()
  private readonly prompts = new PromptInputQueue()
  private readonly pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >()
  private query: ClaudeQuery | null = null
  private claudeSessionId: string | undefined
  private drainPromise: Promise<void> | null = null

  constructor(
    readonly remoteAgentId: string,
    readonly conversationId: string,
    initialSessionId: string | undefined
  ) {
    this.claudeSessionId = initialSessionId
  }

  get sessionId() {
    return this.claudeSessionId
  }

  attach(query: ClaudeQuery) {
    this.query = query
    this.drainPromise = this.drainQuery(query)
  }

  private async drainQuery(query: ClaudeQuery) {
    try {
      for await (const message of query as AsyncIterable<SDKMessage>) {
        this.handleMessage(message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.eventQueue.push({ kind: "error", message })
    } finally {
      this.eventQueue.push({ kind: "turn_completed" })
      this.eventQueue.close()
    }
  }

  private handleMessage(message: SDKMessage) {
    if (
      message.type === "system" &&
      (message as SDKSystemMessage).subtype === "init"
    ) {
      const init = message as SDKSystemMessage & { session_id?: string }
      if (init.session_id && init.session_id !== this.claudeSessionId) {
        this.claudeSessionId = init.session_id
        this.eventQueue.push({
          kind: "session_started",
          sessionId: init.session_id,
        })
      }
      return
    }
    if (message.type === "assistant") {
      const text = extractAssistantText(message as any)
      if (text) this.eventQueue.push({ kind: "assistant_message", text })
      return
    }
    if (message.type === "result") {
      const result = message as any
      if (result.is_error && result.stop_reason !== "max_tokens") {
        this.eventQueue.push({
          kind: "error",
          message: String(
            result.result || result.errors?.[0] || "Claude execution failed"
          ),
        })
      }
      this.eventQueue.push({ kind: "turn_completed" })
    }
  }

  async send(prompt: string, _options?: SendPromptOptions) {
    if (!prompt.trim()) return
    this.prompts.push(userMessage(prompt))
  }

  async setMcpServers(servers: Record<string, McpServerConfig>) {
    if (!this.query?.setMcpServers) return
    await this.query.setMcpServers(servers)
  }

  async respondPermission(
    requestId: string,
    decision: PermissionDecision
  ): Promise<void> {
    const waiter = this.pendingPermissions.get(requestId)
    if (!waiter) {
      throw new Error(`No pending permission request with id ${requestId}`)
    }
    this.pendingPermissions.delete(requestId)
    waiter(decision)
  }

  events(): AsyncIterable<AgentSessionEvent> {
    return this.eventQueue.iterator()
  }

  async close(_reason: string) {
    this.prompts.close()
    for (const [id, waiter] of this.pendingPermissions) {
      waiter({ behavior: "deny", message: "session closed" })
      this.pendingPermissions.delete(id)
    }
    try {
      await this.query?.close?.()
    } catch {
      // ignore
    }
    this.query = null
    this.eventQueue.close()
    if (this.drainPromise) {
      await Promise.race([
        this.drainPromise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ])
    }
  }

  promptIterable(): AsyncIterable<SDKUserMessage> {
    return this.prompts.iterator()
  }

  /** Test/internal helper: enqueue a seed prompt before query() starts iterating. */
  seedPrompt(message: SDKUserMessage) {
    this.prompts.push(message)
  }

  buildCanUseTool(): CanUseTool {
    return async (toolName, input, options) => {
      if (toolName === "AskUserQuestion") {
        const questions = Array.isArray((input as any).questions)
          ? ((input as any).questions as Array<Record<string, unknown>>)
          : []
        const title =
          (questions[0]?.question as string | undefined)?.trim() ||
          "Question from Claude"
        return new Promise<PermissionResult>((resolve) => {
          this.pendingPermissions.set(options.toolUseID, (decision) =>
            resolve(
              buildPermissionResultForDecision(decision, options.toolUseID)
            )
          )
          this.eventQueue.push({
            kind: "user_input_requested",
            requestId: options.toolUseID,
            title,
            questions,
            toolName,
            originalInput: input as Record<string, unknown>,
          })
        })
      }
      if (toolName === "ExitPlanMode") {
        const planMarkdown =
          typeof (input as any).plan === "string"
            ? ((input as any).plan as string)
            : "Claude did not include a plan body."
        return new Promise<PermissionResult>((resolve) => {
          this.pendingPermissions.set(options.toolUseID, (decision) =>
            resolve(
              buildPermissionResultForDecision(decision, options.toolUseID)
            )
          )
          this.eventQueue.push({
            kind: "plan_approval_requested",
            requestId: options.toolUseID,
            title: "Plan from Claude",
            summary: "Claude wants approval before leaving plan mode.",
            planMarkdown,
            toolName,
            originalInput: input as Record<string, unknown>,
          })
        })
      }
      return {
        behavior: "allow",
        updatedInput: input as Record<string, unknown>,
        toolUseID: options.toolUseID,
      }
    }
  }
}

function extractAssistantText(message: { message?: any }): string {
  const content = message.message?.content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("")
}

export class ClaudeDriver implements AgentDriver {
  readonly runtimeKind = "claude_code" as const

  detect(): RuntimeCatalogEntry {
    const probe = detectClaudeBinary()
    if (!probe.path) {
      return { runtimeKind: this.runtimeKind, status: "missing_binary" }
    }
    return {
      runtimeKind: this.runtimeKind,
      executablePath: probe.path,
      status: "available",
      version: probe.version,
    }
  }

  async createSession(spec: SessionSpec): Promise<AgentSession> {
    const session = new ClaudeAgentSession(
      spec.remoteAgentId,
      spec.conversationId,
      spec.resumeSessionId
    )

    const options: ClaudeQueryOptions = {
      cwd: spec.workingDirectory,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: session.buildCanUseTool(),
      mcpServers: spec.mcpServers,
      env: {
        ...process.env,
        ...spec.childEnvOverlay,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      pathToClaudeCodeExecutable: spec.runtimePath,
      abortController: spec.abortSignal
        ? abortControllerFromSignal(spec.abortSignal)
        : undefined,
    }
    if (spec.resumeSessionId) {
      options.resume = spec.resumeSessionId
    }

    // Seed the initial prompt before launching the query so the SDK picks it up immediately.
    if (spec.initialPrompt.trim()) {
      session.seedPrompt(userMessage(spec.initialPrompt))
    }

    const query = claudeAgentQuery({
      prompt: session.promptIterable(),
      options,
    })
    session.attach(query)
    return session
  }
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller
}
