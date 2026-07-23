import {
  DeliveryCarrierMap,
  dedupeCarriersByTraceId,
  singleTraceScope,
} from "./delivery-carriers.js"
import {
  runWithCarrier,
  runWithoutCarrier,
  type TraceCarrier,
} from "./trace-context.js"

/**
 * Per-TURN observability state for the remote-agent daemon (F3/F4/R2/R3).
 *
 * A "turn" is one wake of a conversation, identified by its EPOCH — the string
 * the api mints per (agent, conversation) dispatch (`agent:deliver.turn_epoch`)
 * or the daemon mints for a non-delivery wake (agent:start / task-resolved
 * fallback). Each turn owns a snapshot: the deliveries routed into it plus the
 * carrier of any non-delivery driver frame that raised it.
 *
 * A conversation holds its turns in a FIFO `Map<epoch, Turn>` — insertion order
 * is dispatch order, so `frontEpoch` is the RUNNING turn while later inserts are
 * queued successors. `originCarriers`/`scope` resolve against the FRONT epoch, so
 * a queued turn B's origins never leak into the running turn A's lifecycle spans
 * (the R3 cross-trace fix): each concurrent turn keeps its own bucket instead of
 * collapsing to the whole conversation (the old F3 whole-conversation blur).
 *
 * Deliberately SEPARATE from the FUNCTIONAL, also-epoch-keyed
 * `pendingDeliveryIds` crash-retry set (index.ts): a turn snapshot is created on
 * the first note of an epoch and reclaimed ONLY when that epoch closes (`end` on
 * `turn_completed` / drop / close). Completion of a delivery (the api's
 * `agent:deliveries:completed` frame) and a mid-turn fail-back reclaim only the
 * pending set — they must NOT touch this snapshot, because completion fires
 * mid-turn and the running turn's links must survive until it ends (ruling R2).
 *
 * A separate module because index.ts is an entrypoint that runs `main()` and
 * cannot be imported by a unit test.
 */

// Cap on distinct delivery ids retained per turn (matches the origin_carriers
// wire cap). Eviction is oldest-first so the CURRENT delivery is never dropped.
const MAX_TURN_DELIVERY_ORIGINS = 20

type Turn = {
  deliveryIds: Set<string>
  driverCarrier?: TraceCarrier
}

export class ConversationTurns {
  // conversation -> (epoch -> turn snapshot), FIFO by dispatch order. The first
  // (oldest) epoch is the running turn (`frontEpoch`); later ones are queued.
  private readonly turns = new Map<string, Map<string, Turn>>()

  // Reads per-delivery carriers from the same map index.ts owns, so a delivery's
  // origin trace is looked up by id (the carrier itself lives in one place).
  constructor(private readonly carriers: DeliveryCarrierMap) {}

  private ensure(conversationId: string, epoch: string): Turn {
    let byEpoch = this.turns.get(conversationId)
    if (!byEpoch) {
      byEpoch = new Map<string, Turn>()
      this.turns.set(conversationId, byEpoch)
    }
    let turn = byEpoch.get(epoch)
    if (!turn) {
      turn = { deliveryIds: new Set<string>() }
      byEpoch.set(epoch, turn)
    }
    return turn
  }

  /**
   * The RUNNING turn's epoch for a conversation — the first (oldest) in FIFO
   * order — or null when the conversation has no open turn. Drives the api
   * turn-carrier reconcile (published on `agent:status.turn_epoch`).
   */
  frontEpoch(conversationId: string): string | null {
    const byEpoch = this.turns.get(conversationId)
    if (!byEpoch || byEpoch.size === 0) return null
    const first = byEpoch.keys().next().value
    return first ?? null
  }

  /** Merge deliveries routed into the given turn epoch. */
  noteDeliveries(
    conversationId: string,
    epoch: string,
    deliveryIds: Iterable<string>
  ): void {
    const turn = this.ensure(conversationId, epoch)
    for (const id of deliveryIds) {
      turn.deliveryIds.add(id)
      // Bound the turn's origin set (oldest evicted — Set preserves insertion
      // order) so the newest, i.e. the current delivery, can never be dropped.
      while (turn.deliveryIds.size > MAX_TURN_DELIVERY_ORIGINS) {
        const oldest = turn.deliveryIds.values().next().value
        if (oldest === undefined) break
        turn.deliveryIds.delete(oldest)
      }
    }
  }

  /**
   * Record the carrier of a non-delivery driver frame (agent:start with a
   * conversation, agent:task:resolved) against the turn epoch it drives.
   * Untraced ⇒ no-op (but still opens the epoch bucket so it is FRONT-ordered).
   */
  noteDriver(
    conversationId: string,
    epoch: string,
    carrier: TraceCarrier | undefined
  ): void {
    const turn = this.ensure(conversationId, epoch)
    if (carrier) turn.driverCarrier = carrier
  }

  /** End ONE turn epoch — drops just that turn's observability snapshot. */
  end(conversationId: string, epoch: string): void {
    const byEpoch = this.turns.get(conversationId)
    if (!byEpoch) return
    byEpoch.delete(epoch)
    if (byEpoch.size === 0) this.turns.delete(conversationId)
  }

  /**
   * End EVERY turn of a conversation — the session-death / close backstop (the
   * subprocess is gone, so no queued successor survives).
   */
  endConversation(conversationId: string): void {
    this.turns.delete(conversationId)
  }

  private carrierList(conversationId: string): TraceCarrier[] {
    const epoch = this.frontEpoch(conversationId)
    if (epoch === null) return []
    const turn = this.turns.get(conversationId)?.get(epoch)
    if (!turn) return []
    const list = this.carriers.collect(turn.deliveryIds)
    if (turn.driverCarrier) list.push(turn.driverCarrier)
    return list
  }

  /**
   * The deduped-by-trace-id origin carriers (≤20) of the FRONT turn for the
   * `origin_carriers` wire field — the running turn's origins survive dedupe
   * (dropOldest).
   */
  originCarriers(conversationId: string): TraceCarrier[] {
    return dedupeCarriersByTraceId(this.carrierList(conversationId))
  }

  /**
   * The single-origin carrier scope for the FRONT turn: defined iff ALL of the
   * running turn's origins share ONE distinct trace, else undefined (mixed /
   * none ⇒ the caller MASKS with runWithoutCarrier, never inherits).
   */
  scope(conversationId: string): TraceCarrier | undefined {
    return singleTraceScope(this.carrierList(conversationId))
  }

  /**
   * Run `fn` under the FRONT turn's single-origin carrier, or MASKED when the
   * running turn has no single origin (mixed / none) — never inheriting an
   * ambient carrier.
   */
  runInScope<T>(conversationId: string, fn: () => T): T {
    const scope = this.scope(conversationId)
    return scope ? runWithCarrier(scope, fn) : runWithoutCarrier(fn)
  }

  /**
   * Higher-order wrapper: declare a lifecycle callback so its WHOLE body runs in
   * the conversation's FRONT-turn scope. Uniform (cannot be half-applied inside
   * a long body) and line-greppable by the guard. Every callback's first
   * argument is the conversationId.
   */
  scoped<A extends [conversationId: string, ...rest: unknown[]], R>(
    fn: (...args: A) => R
  ): (...args: A) => R {
    return (...args: A): R => this.runInScope(args[0], () => fn(...args))
  }
}
