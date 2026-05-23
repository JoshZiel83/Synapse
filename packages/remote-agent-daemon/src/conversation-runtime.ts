import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { getDriver } from "./drivers/registry.js"
import { buildAgentChildEnv } from "./drivers/proxy-env.js"
import type {
  AgentSession,
  AgentSessionEvent,
  PermissionDecision,
  RuntimeKind,
} from "./drivers/types.js"

export type ConversationRuntimeCallbacks = {
  onSessionStarted(conversationId: string, sessionId: string): void
  /**
   * `hadError` is true when the SDK pushed an `error` event between this
   * session start and now. Used by the index.ts layer to decide whether to
   * clear last_error in the published status (clean turn → clear; errored
   * turn → preserve the message the corresponding onError already set).
   */
  onTurnCompleted(conversationId: string, info: { hadError: boolean }): void
  onError(conversationId: string, message: string): void
  onUserInputRequested(
    conversationId: string,
    event: Extract<AgentSessionEvent, { kind: "user_input_requested" }>
  ): Promise<void>
  onPlanApprovalRequested(
    conversationId: string,
    event: Extract<AgentSessionEvent, { kind: "plan_approval_requested" }>
  ): Promise<void>
  onPlanUpdated(
    conversationId: string,
    event: Extract<AgentSessionEvent, { kind: "plan_updated" }>
  ): void
  onAssistantMessage(conversationId: string, text: string): void
  onClosed(conversationId: string, reason: string): void
}

export type ConversationRuntimeSpec = {
  remoteAgentId: string
  conversationId: string
  runtimeKind: RuntimeKind
  runtimePath?: string
  rootDirectory: string
  localRootPath?: string
  serverUrl: string
  machineKey: string
  /**
   * Optional proxy URL for the agent child process. When set, the SOCKS5 /
   * HTTPS env vars are injected so claude / codex traffic routes through it.
   * Leave unset (the default) for direct outbound; the runtime never assumes
   * a localhost proxy on its own.
   */
  proxyUrl?: string
  resumeSessionId?: string
  initialPrompt: string
  callbacks: ConversationRuntimeCallbacks
}

function ensureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true })
}

export type BridgeStateView = {
  lastConversationId?: string
  lastToolName?: string
  updatedAt?: string
}

export function readBridgeState(filePath: string): BridgeStateView {
  try {
    if (!filePath || !existsSync(filePath)) return {}
    const raw = readFileSync(filePath, "utf8").trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    return {
      lastConversationId:
        typeof parsed.lastConversationId === "string"
          ? parsed.lastConversationId
          : undefined,
      lastToolName:
        typeof parsed.lastToolName === "string"
          ? parsed.lastToolName
          : undefined,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    }
  } catch {
    return {}
  }
}

export class ConversationRuntime {
  private session: AgentSession | null = null
  private currentSessionId: string | undefined
  private starting: Promise<void> | null = null
  private closed = false
  // Tracks whether the SDK pushed an `error` event in the current turn so
  // turn_completed can tell the index.ts layer whether to clear last_error.
  // Reset whenever a new session starts or a turn completes — each turn
  // gets a fresh slate.
  private errorInCurrentTurn = false
  readonly workingDirectory: string
  readonly bridgeStateFile: string
  readonly conversationDirectory: string

  constructor(private readonly spec: ConversationRuntimeSpec) {
    this.currentSessionId = spec.resumeSessionId
    this.conversationDirectory = path.join(
      spec.rootDirectory,
      "conversations",
      spec.conversationId
    )
    // cwd is ALWAYS per-conversation, regardless of whether the operator
    // configured a `localRootPath`. CC writes its session transcript to
    // ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, so two conversations
    // sharing one cwd would collide on disk: the project directory ends up
    // polluted across sessions and CC's resume / file-checkpoint heuristics
    // can pick up the wrong conversation's history. The plan calls this out
    // explicitly — "cwd 必须按 conversation 隔离" — so we keep workspace
    // scratch under conversationDirectory and surface the operator-provided
    // localRootPath via additionalDirectories instead (claude SDK supports
    // it directly; codex sees the cwd-only sandbox view).
    this.workingDirectory = path.join(this.conversationDirectory, "workspace")
    this.bridgeStateFile = path.join(
      this.conversationDirectory,
      "bridge-state.json"
    )
    ensureDirectory(this.conversationDirectory)
    ensureDirectory(this.workingDirectory)
  }

  get conversationId() {
    return this.spec.conversationId
  }

  get remoteAgentId() {
    return this.spec.remoteAgentId
  }

  get runtimeKind() {
    return this.spec.runtimeKind
  }

  get sessionId() {
    return this.currentSessionId
  }

  /** Start (or restart) the underlying AgentSession. Subsequent calls are no-ops if a session is alive. */
  async ensureStarted(initialPrompt?: string) {
    if (this.session) return
    if (this.starting) return this.starting
    this.starting = this.startInternal(
      initialPrompt ?? this.spec.initialPrompt
    ).finally(() => {
      this.starting = null
    })
    await this.starting
  }

  private async startInternal(initialPrompt: string) {
    if (this.closed) return
    const driver = getDriver(this.spec.runtimeKind)
    const childEnvOverlay = buildAgentChildEnv({
      proxyUrl: this.spec.proxyUrl,
    })
    const mcpServers = this.buildStdioBridgeMcpServers()
    const session = await driver.createSession({
      remoteAgentId: this.spec.remoteAgentId,
      conversationId: this.spec.conversationId,
      workingDirectory: this.workingDirectory,
      additionalDirectories: this.spec.localRootPath
        ? [this.spec.localRootPath]
        : undefined,
      resumeSessionId: this.currentSessionId,
      runtimePath: this.spec.runtimePath,
      mcpServers,
      initialPrompt,
      childEnvOverlay,
    })
    this.session = session
    void this.drainEvents(session)
  }

  private buildStdioBridgeMcpServers() {
    const url = new URL(
      `/api/v1/internal/remote-agents/${this.spec.remoteAgentId}/mcp/${this.spec.conversationId}`,
      this.spec.serverUrl
    )
    return {
      synapse: {
        type: "http" as const,
        url: url.toString(),
        headers: {
          Authorization: `Bearer ${this.spec.machineKey}`,
        },
      },
    }
  }

  /** @deprecated kept until callers stop reading the field; bridgeStateFile is no longer used by the HTTP MCP path. */
  getBridgeStateFile() {
    return this.bridgeStateFile
  }

  private async drainEvents(session: AgentSession) {
    for await (const event of session.events()) {
      if (this.closed) return
      try {
        switch (event.kind) {
          case "session_started":
            if (this.currentSessionId !== event.sessionId) {
              this.currentSessionId = event.sessionId
              this.errorInCurrentTurn = false
              this.spec.callbacks.onSessionStarted(
                this.spec.conversationId,
                event.sessionId
              )
            }
            break
          case "assistant_message":
            this.spec.callbacks.onAssistantMessage(
              this.spec.conversationId,
              event.text
            )
            break
          case "user_input_requested":
            await this.spec.callbacks.onUserInputRequested(
              this.spec.conversationId,
              event
            )
            break
          case "plan_approval_requested":
            await this.spec.callbacks.onPlanApprovalRequested(
              this.spec.conversationId,
              event
            )
            break
          case "plan_updated":
            this.spec.callbacks.onPlanUpdated(this.spec.conversationId, event)
            break
          case "turn_completed":
            this.spec.callbacks.onTurnCompleted(this.spec.conversationId, {
              hadError: this.errorInCurrentTurn,
            })
            this.errorInCurrentTurn = false
            break
          case "error":
            this.errorInCurrentTurn = true
            this.spec.callbacks.onError(this.spec.conversationId, event.message)
            break
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.spec.callbacks.onError(this.spec.conversationId, message)
      }
    }
    // SDK closed the event stream — claude / codex subprocess is gone and the
    // session can no longer accept prompts. If we leave this.session pointing
    // at the dead handle, the next sendPrompt() finds it non-null and writes
    // into a closed stdin, which surfaces as the EPIPE storm in daemon logs
    // and keeps deliveries pending forever (server's retry worker re-fires
    // agent:start every 10s, daemon routes it to the dead session, EPIPE,
    // repeat). Clearing the handle lets the very next sendPrompt take the
    // !session branch in sendPrompt() and call ensureStarted(), which spins
    // up a fresh SDK query with the new prompt as seed.
    if (this.session === session) {
      this.session = null
    }
  }

  async sendPrompt(prompt: string) {
    if (this.closed) return
    if (!this.session) {
      await this.ensureStarted(prompt)
      return
    }
    await this.session.send(prompt)
  }

  async respondPermission(requestId: string, decision: PermissionDecision) {
    if (!this.session) {
      throw new Error("Cannot respond to permission: session not active")
    }
    await this.session.respondPermission(requestId, decision)
  }

  async setMcpServers(servers: Parameters<AgentSession["setMcpServers"]>[0]) {
    if (!this.session) return
    await this.session.setMcpServers(servers)
  }

  async close(reason: string) {
    if (this.closed) return
    this.closed = true
    const session = this.session
    this.session = null
    if (session) {
      try {
        await session.close(reason)
      } catch {
        // ignore
      }
    }
    this.spec.callbacks.onClosed(this.spec.conversationId, reason)
  }
}
