import { isValidTraceparent } from "../../infrastructure/observability/traceparent.js"

/**
 * TURN-scoped cache of a reverse-MCP conversation's delivery-origin
 * traceparents, keyed by the api-minted turn epoch (deduped by trace id, cap 20
 * per epoch — matches the origin_carriers wire cap). Every tools/call span is
 * created with LINKS to the RUNNING turn's origins.
 *
 * The turn epoch is owned by the api, NOT by agent behaviour: the api dispatches
 * the wake (`agent:deliver`) under a minted epoch, so
 * `notifyPendingRemoteAgentDeliveries` calls `beginTurnForConversation` with that
 * epoch right after a successful send.
 *
 * The single source of truth for WHICH epoch's origins a tools/call reads is
 * `runningEpoch` — the last epoch the daemon confirmed as running via
 * `agent:status.turn_epoch` (`reconcile`). Insertion order of the epoch map is
 * used ONLY as a capacity-eviction tiebreak, never to decide the running turn:
 * the api's epoch set is a SUBSET of the daemon's turns (a wake dispatched before
 * the reverse-MCP transport registers opens no epoch here; the daemon mints its
 * own epochs for bootstrap / task-resolve wakes), so positional inference of the
 * front is unsound. Reads follow the daemon; the daemon is authoritative.
 *
 * Because reads key on `runningEpoch`, only the daemon-confirmed turn is ever
 * read. A retry of a still-pending delivery reuses its turn's PERSISTED epoch
 * (`turn_epoch`, stamped on the delivery row at first dispatch), so it re-enters
 * the SAME bucket via `beginTurn`; `addOrigins` dedups by trace id, so a retry
 * adds nothing and opens ZERO extra buckets. The only never-fronted buckets are
 * genuinely-new turns — a successor the daemon has queued behind a running one,
 * or a fresh delivery it coalesced into a turn keyed on another epoch. The cap
 * evicts those completed-turn-first, queued-turn-last (see evictOverflow); that
 * ordering is a pure interleave-correctness guarantee (never drop an un-run turn
 * ahead of a finished one), not a churn-tolerance mechanism.
 *
 * This fixes F3's reverse-MCP half (the old session-scoped cache linked every
 * tools/call to prior turns' origins because an active session's cache never
 * reset) AND R3's cross-trace interleave (a queued successor's origins can never
 * be read while an earlier turn runs, because reads key on the daemon-confirmed
 * running epoch — never on "the newest / oldest bucket").
 *
 * Best-effort caveats (see docs/trace-propagation-policy.md):
 *  - Before the daemon confirms the first turn (`runningEpoch` still null) a
 *    tools/call links nothing; the turn's first `extend` (check_messages /
 *    read_history) seeds the running epoch's origins from the live delivery rows.
 *  - `extend` reads EVERY pending delivery of the conversation, not just the
 *    running turn's. The delivery row now carries its dispatch epoch, but extend
 *    deliberately does NOT filter by it: it links CONSERVATIVELY. If the agent
 *    polls check_messages mid-turn while a successor message is already queued,
 *    that successor's origin is also linked onto the running turn. This over-
 *    links (a benign extra correlation) but never UNDER-links — the successor's
 *    own turn still links its origin when the daemon fronts it — and never mis-
 *    routes a read to the wrong turn. Under-linking would be the worse error: the
 *    daemon may coalesce a separately-dispatched (different-epoch) delivery into
 *    the running turn, so epoch-filtering the rows would strip an origin the turn
 *    genuinely processed.
 */
const TURN_CARRIER_CAP = 20
// Pure memory bound on retained epoch buckets, > the daemon's 100-deep per-
// conversation turn queue. Eviction NEVER removes the runningEpoch bucket, and
// prefers completed turns over never-fronted ones (see evictOverflow).
const MAX_TURN_BUCKETS = 128

export class TurnCarrierCache {
  private readonly turns = new Map<string, Map<string, string>>()
  // The daemon's last-confirmed running epoch — the ONLY bucket reads target.
  // null = daemon idle / no turn confirmed yet ⇒ reads return empty.
  private runningEpoch: string | null = null
  // Epochs the daemon has confirmed running at least once (via `reconcile`). A
  // fronted-but-superseded bucket is a COMPLETED turn; the cap evicts those
  // before any bucket the daemon has never fronted, so a still-queued turn is
  // never dropped ahead of stale finished ones.
  private readonly fronted = new Set<string>()

  private bucket(epoch: string): Map<string, string> {
    let b = this.turns.get(epoch)
    if (!b) {
      b = new Map<string, string>()
      this.turns.set(epoch, b)
      this.evictOverflow()
    }
    return b
  }

  // Cap retained buckets. Prefer evicting a COMPLETED turn (an epoch the daemon
  // fronted and has since superseded) over one it has never fronted; never evict
  // the confirmed running bucket. Within a tier, oldest-inserted goes first.
  private evictOverflow(): void {
    while (this.turns.size > MAX_TURN_BUCKETS) {
      const victim = this.pickEvictable()
      if (victim === undefined) break // only the running bucket remains
      this.turns.delete(victim)
      this.fronted.delete(victim)
    }
  }

  private pickEvictable(): string | undefined {
    let firstNeverFronted: string | undefined
    for (const epoch of this.turns.keys()) {
      if (epoch === this.runningEpoch) continue
      if (this.fronted.has(epoch)) return epoch // a completed turn — evict first
      if (firstNeverFronted === undefined) firstNeverFronted = epoch
    }
    return firstNeverFronted
  }

  private static addOrigins(
    bucket: Map<string, string>,
    traceparents: Array<string | null | undefined>
  ): string[] {
    const added: string[] = []
    for (const traceparent of traceparents) {
      if (!isValidTraceparent(traceparent)) continue
      const traceId = traceparent.slice(3, 35)
      if (bucket.has(traceId)) continue
      while (bucket.size >= TURN_CARRIER_CAP) {
        const oldest = bucket.keys().next().value
        if (oldest === undefined) break
        bucket.delete(oldest)
      }
      bucket.set(traceId, traceparent)
      added.push(traceparent)
    }
    return added
  }

  /**
   * Attach the dispatched wake's origins to its epoch bucket (find-or-create,
   * keyed strictly by epoch). Idempotent per epoch: a retry reuses its turn's
   * persisted epoch, so it lands in the SAME bucket and `addOrigins` dedups by
   * trace id. Does NOT change `runningEpoch` — a freshly-dispatched wake's bucket
   * stays inert until the daemon confirms it via `reconcile`.
   *
   * Buckets are keyed by epoch, never by origin membership: the same origin can
   * legitimately belong to more than one turn's bucket (`extend` over-links a
   * queued successor's origin onto the running turn), so origin identity is not a
   * turn key — only the api-minted epoch is.
   */
  beginTurn(
    epoch: string,
    traceparents: Array<string | null | undefined>
  ): void {
    TurnCarrierCache.addOrigins(this.bucket(epoch), traceparents)
  }

  /**
   * Merge valid, previously unseen origins into the RUNNING turn's bucket;
   * returns the NEWLY added ones (the mid-handler post-`addLink` set). Used by
   * check_messages / read_history as they discover the running turn's delivery
   * rows. No-op returning `[]` when no turn is confirmed running.
   */
  extend(traceparents: Array<string | null | undefined>): string[] {
    if (this.runningEpoch === null) return []
    return TurnCarrierCache.addOrigins(
      this.bucket(this.runningEpoch),
      traceparents
    )
  }

  /**
   * Reconcile the running epoch against the daemon's `agent:status.turn_epoch`
   * (a REQUIRED wire field — always present, value nullable).
   * `string` → that epoch is running (get-or-create its bucket; drop nothing —
   * a still-queued api bucket survives to be read once the daemon fronts it).
   * `null` → daemon idle (reads return empty; buckets retained so a freshly-
   * dispatched-but-unconfirmed epoch survives a stale idle status).
   */
  reconcile(confirmedEpoch: string | null): void {
    if (confirmedEpoch === null) {
      this.runningEpoch = null
      return
    }
    this.runningEpoch = confirmedEpoch
    this.fronted.add(confirmedEpoch)
    this.bucket(confirmedEpoch)
  }

  /**
   * The RUNNING turn's origin traceparents for a tools/call span's creation-time
   * links. Non-consuming — the running turn's origins are stable across all of
   * its tools/calls; the front advances only via `reconcile`. Empty when no turn
   * is confirmed running.
   */
  originsForToolCall(): string[] {
    if (this.runningEpoch === null) return []
    const bucket = this.turns.get(this.runningEpoch)
    return bucket ? [...bucket.values()] : []
  }

  /** The confirmed running epoch (tests / introspection). */
  frontEpoch(): string | null {
    return this.runningEpoch
  }

  /** The running turn's origins without side effects (tests / introspection). */
  list(): string[] {
    return this.originsForToolCall()
  }

  /** Retained epoch-bucket count (tests / introspection) — the memory bound. */
  bucketCount(): number {
    return this.turns.size
  }
}

// ─── process-local registry ─────────────────────────────────────────────────
// Lets service.ts (which dispatches the wake and receives agent:status) reach
// the reverse-MCP session's cache (owned by mcp-endpoint.ts) WITHOUT an import
// cycle — both import this leaf module. Keyed `${remoteAgentId}:${conversationId}`;
// a conversation can have more than one live transport, so the value is a Set.
const cachesByConversation = new Map<string, Set<TurnCarrierCache>>()

function registryKey(remoteAgentId: string, conversationId: string): string {
  return `${remoteAgentId}:${conversationId}`
}

/**
 * Register a session's cache under its (agent, conversation). Returns an
 * unregister fn the transport calls on close / idle-reap.
 */
export function registerTurnCarrierCache(
  remoteAgentId: string,
  conversationId: string,
  cache: TurnCarrierCache
): () => void {
  const key = registryKey(remoteAgentId, conversationId)
  let set = cachesByConversation.get(key)
  if (!set) {
    set = new Set<TurnCarrierCache>()
    cachesByConversation.set(key, set)
  }
  set.add(cache)
  return () => {
    const live = cachesByConversation.get(key)
    if (!live) return
    live.delete(cache)
    if (live.size === 0) cachesByConversation.delete(key)
  }
}

/**
 * Attach a dispatched wake's origins to its epoch on every live cache of a
 * conversation, from the api that just sent the wake. No-op when no reverse-MCP
 * session is connected yet (the first tools/call will `extend` from the delivery
 * rows once the daemon confirms the turn).
 */
export function beginTurnForConversation(
  remoteAgentId: string,
  conversationId: string,
  epoch: string,
  traceparents: Array<string | null | undefined>
): void {
  const set = cachesByConversation.get(
    registryKey(remoteAgentId, conversationId)
  )
  if (!set) return
  for (const cache of set) cache.beginTurn(epoch, traceparents)
}

/**
 * Reconcile the running epoch on every live cache of a conversation against the
 * daemon's authoritative `agent:status.turn_epoch`. No-op when no reverse-MCP
 * session is connected.
 */
export function reconcileTurnForConversation(
  remoteAgentId: string,
  conversationId: string,
  confirmedEpoch: string | null
): void {
  const set = cachesByConversation.get(
    registryKey(remoteAgentId, conversationId)
  )
  if (!set) return
  for (const cache of set) cache.reconcile(confirmedEpoch)
}
