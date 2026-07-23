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
   * `epoch` is the completed turn's epoch — the index layer drains exactly that
   * turn's still-pending deliveries (never a queued successor's) and ends its
   * observability snapshot.
   */
  onTurnCompleted(
    conversationId: string,
    info: { hadError: boolean; epoch: string }
  ): void
  /**
   * A turn that never reached its own terminal was stranded: the session died
   * with it running or queued, or a wake was evicted from a full queue. The
   * index layer drains that epoch's still-pending deliveries and fail-reports
   * them so the api reschedules (at-least-once). Distinct from onTurnCompleted
   * (a real terminal) — a dropped turn produced no result.
   */
  onTurnDropped(conversationId: string, epoch: string): void
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
  callbacks: ConversationRuntimeCallbacks
}

function ensureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true })
}

// A conversation dispatches ONE turn at a time (the drivers serialize; codex
// cannot run concurrent turns). Extra wakes queue in `pendingTurns` in dispatch
// order and fire as each turn's terminal advances the gate. Capped so a wedged
// turn plus a flood of wakes cannot grow the queue without bound; the OLDEST
// queued wake is evicted and fail-reported (the api reschedules) rather than
// starving fresh work behind a backlog.
const MAX_PENDING_TURNS_PER_CONVERSATION = 100

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
  // ── Turn gate (R3) ────────────────────────────────────────────────────────
  // A conversation dispatches ONE turn at a time. `turnInFlight` is true from the
  // moment a turn is armed — SYNCHRONOUSLY, before the async session spin-up or
  // send — until its terminal (`turn_completed`) advances the gate. `activeEpoch`
  // is that turn's api-minted (or daemon-minted) epoch: the single source the
  // index layer reads to attribute the terminal, kept in lockstep with
  // `ConversationTurns.frontEpoch`. Wakes that arrive mid-turn queue in
  // `pendingTurns` (dispatch order) and fire one-at-a-time as the gate advances.
  private turnInFlight = false
  private activeEpoch: string | null = null
  private readonly pendingTurns: Array<{ epoch: string; prompt: string }> = []
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

  /**
   * The epoch of the turn currently dispatched to the session (null when idle).
   * Read by the index layer to note a resume-driver's carrier against the RIGHT
   * open turn. Stays in lockstep with `ConversationTurns.frontEpoch`.
   */
  get runningEpoch(): string | null {
    return this.activeEpoch
  }

  /**
   * Start the underlying AgentSession with `initialPrompt` as the seed of the
   * bootstrap turn `initialEpoch`. No-op if a session is already alive (the
   * caller then wakes via `sendPrompt`). Arms the gate for the bootstrap turn
   * SYNCHRONOUSLY — before the awaited spin-up whose `drainEvents` detaches — so
   * a wake racing the bootstrap sees `turnInFlight` and queues instead of
   * starting a second session or dispatching a concurrent turn (§5a).
   */
  async ensureStarted(initialPrompt: string, initialEpoch: string) {
    if (this.session) return
    if (this.starting) return this.starting
    this.turnInFlight = true
    this.activeEpoch = initialEpoch
    this.starting = this.startInternal(initialPrompt)
      .catch((error) => {
        // The bootstrap threw before a drain loop exists to emit a terminal.
        // Strand only the wakes that QUEUED behind it during the async spin-up
        // (their callers already returned from `sendPrompt`, so nothing else
        // fail-reports them); the bootstrap epoch itself is fail-reported by the
        // ensureStarted caller, which catches this re-throw (avoids a double
        // report). Then reset the gate so a later wake can retry the bootstrap.
        this.failGateOnStartThrow()
        throw error
      })
      .finally(() => {
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
    try {
      await this.consumeSessionEvents(session)
    } finally {
      // The event stream ended: the SDK closed it (subprocess gone) or an
      // unexpected throw escaped consumeSessionEvents. Either way the session can
      // no longer accept prompts, so null the handle — the next sendPrompt then
      // takes its !session branch and bootstraps a fresh SDK query with the new
      // prompt as seed. Leaving the dead handle in place instead surfaces as the
      // EPIPE storm (server retries agent:deliver every 10s → routed to dead
      // stdin → EPIPE → deliveries pending forever). Then strand any turn still
      // armed / queued so its deliveries fail-report and the api reschedules —
      // the gate must never wedge turnInFlight on a dead session. Skipped on
      // explicit close(): that path (onClosed) owns its own conversation-wide
      // drain + endConversation.
      if (!this.closed && this.session === session) {
        this.session = null
        this.failGateOnDeath()
      }
    }
  }

  private async consumeSessionEvents(session: AgentSession) {
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
          case "turn_completed": {
            // A terminal with no armed turn is stray / duplicate (a driver that
            // double-emits) — ignore it so it can't fire a spurious completion
            // or advance the gate past a live turn.
            if (!this.turnInFlight || this.activeEpoch === null) break
            const completedEpoch = this.activeEpoch
            const hadError = this.errorInCurrentTurn
            this.errorInCurrentTurn = false
            this.spec.callbacks.onTurnCompleted(this.spec.conversationId, {
              hadError,
              epoch: completedEpoch,
            })
            // Advance to the next queued wake (or go idle). Dispatching into a
            // session that died between the terminal and here is safe: the
            // drainEvents finally strands the just-dispatched epoch.
            this.advanceGate()
            break
          }
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
  }

  /**
   * Dispatch a wake as a turn under `epoch`, or queue it if a turn is already
   * running (Δ1 — the plain gate, no universal bootstrap-adopt belt). The caller
   * mints `epoch` (api `agent:deliver.turn_epoch`, or daemon-minted for a
   * non-delivery wake) and inserts the matching `ConversationTurns` bucket under
   * the SAME epoch, so `activeEpoch` and `frontEpoch` stay in lockstep.
   */
  async sendPrompt(epoch: string, prompt: string) {
    if (this.closed) return
    if (this.turnInFlight) {
      // A turn is running — queue this wake; it dispatches when the running
      // turn's terminal advances the gate.
      this.pushPendingTurn(epoch, prompt)
      return
    }
    if (!this.session) {
      // Idle with no live session (a prior turn's session died and was nulled):
      // this wake bootstraps a fresh one as its seed turn; ensureStarted arms
      // the gate for `epoch`.
      await this.ensureStarted(prompt, epoch)
      return
    }
    // Idle with a live session (steady-state reuse): arm the gate for this epoch
    // and dispatch immediately.
    this.turnInFlight = true
    this.activeEpoch = epoch
    await this.session.send(prompt)
  }

  /**
   * A turn's terminal arrived — dispatch the next queued wake, or go idle. Called
   * only from the turn_completed handler (gate armed). Dispatching into a session
   * that died between the terminal and here is safe: drainEvents' finally strands
   * the just-set epoch via failGateOnDeath.
   */
  private advanceGate() {
    const next = this.pendingTurns.shift()
    if (!next) {
      this.turnInFlight = false
      this.activeEpoch = null
      return
    }
    this.activeEpoch = next.epoch
    // turnInFlight stays true — one turn hands straight to the next.
    const session = this.session
    if (!session) {
      // Session died between the terminal and this dispatch — strand this turn
      // and every one still queued.
      this.failGateOnDeath()
      return
    }
    void session.send(next.prompt)
  }

  private pushPendingTurn(epoch: string, prompt: string) {
    this.pendingTurns.push({ epoch, prompt })
    // Bound the queue: a wedged turn plus a wake flood must not grow it without
    // limit. Evict the OLDEST queued wake (FIFO) and strand it so its deliveries
    // fail-report — dropping the newest would starve fresh work behind a backlog.
    while (this.pendingTurns.length > MAX_PENDING_TURNS_PER_CONVERSATION) {
      const dropped = this.pendingTurns.shift()
      if (!dropped) break
      this.spec.callbacks.onTurnDropped(this.spec.conversationId, dropped.epoch)
    }
  }

  /**
   * The session died (or advanceGate found no session) with a turn armed and/or
   * wakes queued. Strand them ALL — the running epoch and every queued one — so
   * their deliveries fail-report (the api reschedules) and reset the gate; it
   * must never wedge turnInFlight on a dead session.
   */
  private failGateOnDeath() {
    const stranded: string[] = []
    if (this.turnInFlight && this.activeEpoch !== null) {
      stranded.push(this.activeEpoch)
    }
    for (const pending of this.pendingTurns) stranded.push(pending.epoch)
    this.pendingTurns.length = 0
    this.turnInFlight = false
    this.activeEpoch = null
    for (const epoch of stranded) {
      this.spec.callbacks.onTurnDropped(this.spec.conversationId, epoch)
    }
  }

  /**
   * The bootstrap `startInternal` threw before a drain loop exists. Strand ONLY
   * the wakes that queued behind it (the bootstrap epoch is fail-reported by the
   * ensureStarted caller, which catches the re-throw — this avoids a double
   * report) and reset the gate so a later wake can retry the bootstrap.
   */
  private failGateOnStartThrow() {
    const strandedQueued = this.pendingTurns.map((turn) => turn.epoch)
    this.pendingTurns.length = 0
    this.turnInFlight = false
    this.activeEpoch = null
    for (const epoch of strandedQueued) {
      this.spec.callbacks.onTurnDropped(this.spec.conversationId, epoch)
    }
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
