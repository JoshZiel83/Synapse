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
 * Per-TURN observability state for the remote-agent daemon (F3/F4).
 *
 * A "turn" is the unit of work the daemon is currently driving for a
 * conversation: the deliveries routed into it (`agent:deliver`) plus the
 * carrier of a non-delivery driver frame (`agent:start` / `agent:task:resolved`
 * that woke the conversation). Its lifetime is the OBSERVABILITY lifetime,
 * deliberately SEPARATE from the FUNCTIONAL `pendingDeliveryIds` crash-retry set
 * (index.ts): a turn snapshot is created on the first note of a turn and
 * reclaimed ONLY when the turn's epoch closes (`end` on `turn_completed`/close).
 * Completion of a delivery (the api's `agent:deliveries:completed` frame) and a
 * mid-turn fail-back reclaim only the pending set — they must NOT touch this
 * snapshot, because completion fires mid-turn and the running turn's links must
 * survive until it ends (adjudication ruling R2).
 *
 * `originCarriers`/`scope` therefore describe the turn that actually RAISED the
 * event: the second message of an ordinary conversation no longer collapses to
 * `scope=undefined` (the old whole-conversation pending set spanned every past
 * turn — F3). A separate module because index.ts is an entrypoint that runs
 * `main()` and cannot be imported by a unit test.
 */

// Cap on distinct delivery ids retained per turn (matches the origin_carriers
// wire cap). Eviction is oldest-first so the CURRENT delivery is never dropped.
const MAX_TURN_DELIVERY_ORIGINS = 20

type Turn = {
  deliveryIds: Set<string>
  driverCarrier?: TraceCarrier
}

export class ConversationTurns {
  private readonly turns = new Map<string, Turn>()

  // Reads per-delivery carriers from the same map index.ts owns, so a delivery's
  // origin trace is looked up by id (the carrier itself lives in one place).
  constructor(private readonly carriers: DeliveryCarrierMap) {}

  private ensure(conversationId: string): Turn {
    let turn = this.turns.get(conversationId)
    if (!turn) {
      turn = { deliveryIds: new Set<string>() }
      this.turns.set(conversationId, turn)
    }
    return turn
  }

  /** Merge deliveries routed into the conversation's current turn. */
  noteDeliveries(conversationId: string, deliveryIds: Iterable<string>): void {
    const turn = this.ensure(conversationId)
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
   * conversation, agent:task:resolved). Untraced ⇒ no-op.
   */
  noteDriver(conversationId: string, carrier: TraceCarrier | undefined): void {
    if (!carrier) return
    this.ensure(conversationId).driverCarrier = carrier
  }

  /** End the conversation's current turn — drops its observability snapshot. */
  end(conversationId: string): void {
    this.turns.delete(conversationId)
  }

  private carrierList(conversationId: string): TraceCarrier[] {
    const turn = this.turns.get(conversationId)
    if (!turn) return []
    const list = this.carriers.collect(turn.deliveryIds)
    if (turn.driverCarrier) list.push(turn.driverCarrier)
    return list
  }

  /**
   * The deduped-by-trace-id origin carriers (≤20) for the `origin_carriers`
   * wire field — the current turn's origins survive dedupe (dropOldest).
   */
  originCarriers(conversationId: string): TraceCarrier[] {
    return dedupeCarriersByTraceId(this.carrierList(conversationId))
  }

  /**
   * The single-origin carrier scope for the turn: defined iff ALL of the turn's
   * origins share ONE distinct trace, else undefined (mixed / none ⇒ the caller
   * MASKS with runWithoutCarrier, never inherits).
   */
  scope(conversationId: string): TraceCarrier | undefined {
    return singleTraceScope(this.carrierList(conversationId))
  }

  /**
   * Run `fn` under the turn's single-origin carrier, or MASKED when the turn has
   * no single origin (mixed / none) — never inheriting an ambient carrier.
   */
  runInScope<T>(conversationId: string, fn: () => T): T {
    const scope = this.scope(conversationId)
    return scope ? runWithCarrier(scope, fn) : runWithoutCarrier(fn)
  }

  /**
   * Higher-order wrapper: declare a lifecycle callback so its WHOLE body runs in
   * the conversation's per-turn scope. Uniform (cannot be half-applied inside a
   * long body) and line-greppable by the guard. Every callback's first argument
   * is the conversationId.
   */
  scoped<A extends [conversationId: string, ...rest: unknown[]], R>(
    fn: (...args: A) => R
  ): (...args: A) => R {
    return (...args: A): R => this.runInScope(args[0], () => fn(...args))
  }
}
