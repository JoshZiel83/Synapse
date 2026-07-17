import { traceIdOf, type TraceCarrier } from "./trace-context.js"

/**
 * Per-delivery trace-carrier bookkeeping for the daemon's fan-in paths
 * (remediation plan §4.C). One `agent:deliver` batch fans in deliveries from
 * MANY api requests, each with its own trace — a single per-conversation slot
 * provably mis-parents every callback of a mixed batch under whichever trace
 * arrived last (the C3a repro). Instead every traced delivery keeps ITS OWN
 * carrier until the delivery is observed completing (api-side) or the daemon
 * reports it failed, and the async callbacks resolve a scope from exactly the
 * delivery ids they concern.
 *
 * Bounded FIFO (default cap 1024): completions are only observed api-side, so
 * entries for successfully processed deliveries linger until evicted — the
 * eviction is observability-only (a callback for an evicted delivery simply
 * loses its trace attribution; nothing functional depends on the map).
 */
export class DeliveryCarrierMap {
  private readonly carriers = new Map<string, TraceCarrier>()

  constructor(private readonly cap: number = 1024) {}

  get size(): number {
    return this.carriers.size
  }

  /** Remember a delivery's carrier (no-op for untraced deliveries). */
  set(deliveryId: string, carrier: TraceCarrier | undefined): void {
    if (!carrier) return
    // Re-insert moves the entry to the FIFO tail (freshest survives longest).
    this.carriers.delete(deliveryId)
    this.carriers.set(deliveryId, carrier)
    while (this.carriers.size > this.cap) {
      const oldest = this.carriers.keys().next().value
      if (oldest === undefined) break
      this.carriers.delete(oldest)
    }
  }

  get(deliveryId: string): TraceCarrier | undefined {
    return this.carriers.get(deliveryId)
  }

  delete(deliveryId: string): void {
    this.carriers.delete(deliveryId)
  }

  /** The present (still-mapped) carriers for `deliveryIds`, in id order. */
  collect(deliveryIds: Iterable<string>): TraceCarrier[] {
    const found: TraceCarrier[] = []
    for (const id of deliveryIds) {
      const carrier = this.carriers.get(id)
      if (carrier) found.push(carrier)
    }
    return found
  }

  /**
   * The single carrier scope for a set of deliveries: defined iff ALL present
   * carriers share ONE distinct trace-id (an untraced/evicted delivery does
   * not veto). A mixed-origin set yields undefined — the caller's callback
   * then runs untraced rather than falsely attributed to one origin.
   *
   * (Plan §4.C change 4 names this `carrierScopeFor(deliveryIds)` — it lives
   * here as the map's `scopeFor` method; same adjudicated semantics.)
   */
  scopeFor(deliveryIds: Iterable<string>): TraceCarrier | undefined {
    return singleTraceScope(this.collect(deliveryIds))
  }

  clear(): void {
    this.carriers.clear()
  }
}

/**
 * The one carrier iff every carrier in `carriers` shares a single distinct
 * trace-id; undefined when empty or mixed-origin.
 */
export function singleTraceScope(
  carriers: readonly TraceCarrier[]
): TraceCarrier | undefined {
  let scope: TraceCarrier | undefined
  let scopeTraceId: string | undefined
  for (const carrier of carriers) {
    const traceId = traceIdOf(carrier.traceparent)
    if (!traceId) continue
    if (scopeTraceId === undefined) {
      scope = carrier
      scopeTraceId = traceId
    } else if (traceId !== scopeTraceId) {
      return undefined
    }
  }
  return scope
}

/**
 * One entry of the reshaped fail-deliveries body: the delivery id plus ITS OWN
 * originating carrier when still mapped (untraced/evicted ⇒ bare id). Matches
 * `RemoteAgentFailDeliveriesBody["deliveries"][number]` structurally — the
 * daemon keeps no runtime device-protocol dependency, so the shape is
 * re-stated here and `satisfies`-checked at the POST site (index.ts).
 */
export type FailDeliveryEntry = {
  delivery_id: string
  traceparent?: string
  tracestate?: string
}

/**
 * Assemble the per-delivery fail-deliveries report (§4.C, the C3a fan-in fix):
 * EVERY delivery contributes its own carrier to the body (the api LINKs each
 * one, kind=remote_agent_delivery), while `scope` is the single-origin carrier
 * for the POST itself — present iff ALL present carriers share ONE distinct
 * trace (mixed origins ⇒ undefined ⇒ the POST runs untraced api-side as a
 * fresh root with per-delivery links). PURE: the caller (index.ts
 * reportDeliveryFailure) deletes the map entries afterwards, synchronously
 * before its first await, and performs the POST.
 */
export function buildFailDeliveriesReport(
  map: DeliveryCarrierMap,
  deliveryIds: readonly string[]
): { deliveries: FailDeliveryEntry[]; scope: TraceCarrier | undefined } {
  const deliveries = deliveryIds.map((id): FailDeliveryEntry => {
    const carrier = map.get(id)
    return {
      delivery_id: id,
      ...(carrier
        ? {
            traceparent: carrier.traceparent,
            ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
          }
        : {}),
    }
  })
  return { deliveries, scope: map.scopeFor(deliveryIds) }
}

/**
 * Dedupe carriers by trace-id (first carrier per trace wins), capped — the
 * `origin_carriers` wire field the api LINKs task creation back to every
 * originating trace (cap 20 matches the wire schema's max).
 */
export function dedupeCarriersByTraceId(
  carriers: readonly TraceCarrier[],
  cap = 20
): TraceCarrier[] {
  const byTraceId = new Map<string, TraceCarrier>()
  for (const carrier of carriers) {
    if (byTraceId.size >= cap) break
    const traceId = traceIdOf(carrier.traceparent)
    if (!traceId || byTraceId.has(traceId)) continue
    byTraceId.set(traceId, carrier)
  }
  return [...byTraceId.values()]
}
