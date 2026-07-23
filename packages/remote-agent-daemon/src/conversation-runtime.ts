import { mkdirSync } from "node:fs"
import path from "node:path"
import { getDriver } from "./drivers/registry.js"
import { buildAgentChildEnv } from "./drivers/proxy-env.js"
import { detach } from "./trace-context.js"
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
   * Optional proxy URL for the agent child process. When set, standard proxy
   * env vars are injected so claude / codex traffic routes through it. Leave
   * unset (the default) for direct outbound; the runtime never assumes a
   * localhost proxy on its own.
   */
  proxyUrl?: string
  resumeSessionId?: string
  initialPrompt: string
  callbacks: ConversationRuntimeCallbacks
}

function ensureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true })
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
    // The event loop is SESSION-lifetime (claude keeps one streaming query
    // alive across turns; codex feeds later prompts through the same process),
    // so it must carry NO ambient trace carrier — otherwise every later
    // lifecycle callback would inherit whichever turn's carrier created it
    // (F4). `detach` launches it under runWithoutCarrier so it is context-free
    // by construction; each callback re-enters its OWN per-turn carrier via
    // ConversationTurns.scoped.
    detach(() => this.drainEvents(session))
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
        // A callback throw is a real failure for the current turn — the
        // server / task endpoint refused our event, the IM tool path
        // blew up, etc. Mark the turn as errored so the trailing
        // turn_completed doesn't classify it as clean and clear last_error.
        this.errorInCurrentTurn = true
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
