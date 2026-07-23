import { isValidTraceparent } from "../../infrastructure/observability/traceparent.js"

/**
 * TURN-scoped cache of a reverse-MCP conversation's delivery-origin
 * traceparents (deduped by trace id, cap 20 — matches the origin_carriers wire
 * cap). Every tools/call span is created with LINKS to the turn's origins.
 *
 * The turn epoch is owned by the api, NOT by agent behaviour: the api dispatches
 * the wake (`agent:deliver`), so `notifyPendingRemoteAgentDeliveries` opens a
 * new turn via `beginTurnForConversation` right after a successful send. The
 * `consumed` flag makes back-to-back delivery batches that feed ONE wake MERGE
 * (both pre-consumption), while a genuinely new wake after the agent has begun a
 * tools/call RESETS the origins — fixing F3's reverse-MCP half (the old
 * session-scoped cache linked every tools/call to prior turns' origins because
 * an active session's cache never reset).
 *
 * Best-effort caveat: a turn woken by a non-delivery path (an agent that resumes
 * without a fresh `agent:deliver`) does not open an epoch here, so its first
 * tools/call may link the previous delivery-driven turn's origins; `extend`
 * (check_messages / read_history) still refreshes from the live delivery rows.
 * See docs/trace-propagation-policy.md.
 */
const TURN_CARRIER_CAP = 20

export class TurnCarrierCache {
  private readonly byTraceId = new Map<string, string>()
  // True once the running turn's origins have been read for a tools/call span
  // (`originsForToolCall`): the NEXT `beginTurn` then resets rather than merges.
  private consumed = false

  /**
   * Merge valid, previously unseen origin traceparents; returns the NEWLY added
   * ones (the mid-handler post-`addLink` set). Used by check_messages /
   * read_history as they discover the turn's delivery rows.
   */
  extend(traceparents: Array<string | null | undefined>): string[] {
    const added: string[] = []
    for (const traceparent of traceparents) {
      if (!isValidTraceparent(traceparent)) continue
      const traceId = traceparent.slice(3, 35)
      if (this.byTraceId.has(traceId)) continue
      while (this.byTraceId.size >= TURN_CARRIER_CAP) {
        const oldest = this.byTraceId.keys().next().value
        if (oldest === undefined) break
        this.byTraceId.delete(oldest)
      }
      this.byTraceId.set(traceId, traceparent)
      added.push(traceparent)
    }
    return added
  }

  /**
   * Open (or extend) the turn's epoch with the dispatched wake's origins. Clears
   * FIRST iff the current epoch was already consumed by a tools/call — so
   * coalesced batches of one wake merge, but a new wake after consumption starts
   * fresh.
   */
  beginTurn(traceparents: Array<string | null | undefined>): void {
    if (this.consumed) {
      this.byTraceId.clear()
      this.consumed = false
    }
    this.extend(traceparents)
  }

  /**
   * The turn's origin traceparents for a tools/call span's creation-time links,
   * marking the epoch consumed (so the next dispatched wake opens a new turn).
   */
  originsForToolCall(): string[] {
    this.consumed = true
    return [...this.byTraceId.values()]
  }

  /** The current origins without consuming the epoch (tests / introspection). */
  list(): string[] {
    return [...this.byTraceId.values()]
  }
}

// ─── process-local registry ─────────────────────────────────────────────────
// Lets service.ts (which dispatches the wake) reach the reverse-MCP session's
// cache (owned by mcp-endpoint.ts) WITHOUT an import cycle — both import this
// leaf module. Keyed `${remoteAgentId}:${conversationId}`; a conversation can
// have more than one live transport, so the value is a Set.
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
 * Open a fresh turn on every live cache of a conversation, from the api that
 * just dispatched the wake. No-op when no reverse-MCP session is connected yet
 * (the first tools/call will `extend` from the delivery rows anyway).
 */
export function beginTurnForConversation(
  remoteAgentId: string,
  conversationId: string,
  traceparents: Array<string | null | undefined>
): void {
  const set = cachesByConversation.get(
    registryKey(remoteAgentId, conversationId)
  )
  if (!set) return
  for (const cache of set) cache.beginTurn(traceparents)
}
