/**
 * Chat dedup observability counters.
 *
 * Lightweight in-process counters + a periodic console.info dump so we
 * have visibility into the S6 "main thread vs SW mutex" dedup work.
 * Two counters today:
 *
 *  - duplicate_watermark_post_total: incremented when
 *    updateChatConversationReadWatermark() runs but the resolved
 *    sequence is already at or below the existing watermark, i.e. the
 *    POST didn't move state forward. Steady-state value >> 0 means a
 *    client is still POSTing read watermarks the worker has already
 *    submitted (the regression S6 was meant to close).
 *  - duplicate_clientmessageid_send_total: incremented when
 *    insertConversationItem() finds an existing row with the same
 *    (conversation_id, author_participant_id, client_message_id) and
 *    returns it instead of creating a new one. Steady-state value >> 0
 *    means main thread and SW are both flushing the same outbox entry.
 *
 * Use prom-client later if/when the rest of the app adopts it; this
 * keeps the counters useful without the infra dependency.
 */

const counters: Record<string, number> = Object.create(null)

export function recordDuplicateWatermarkPost() {
  counters.duplicate_watermark_post_total =
    (counters.duplicate_watermark_post_total ?? 0) + 1
}

export function recordDuplicateClientMessageIdSend() {
  counters.duplicate_clientmessageid_send_total =
    (counters.duplicate_clientmessageid_send_total ?? 0) + 1
}

export function getChatDedupCountersSnapshot(): Readonly<
  Record<string, number>
> {
  return { ...counters }
}

// Test-only: lets the integration suite assert a clean baseline between
// cases without leaking state across runs. Not exposed for production
// callers — there's no reason to ever zero these in a running process.
export function __resetChatDedupCountersForTests() {
  for (const key of Object.keys(counters)) {
    delete counters[key]
  }
}

// Optional periodic dump. Off by default; main() opts in via
// startChatDedupCounterLogger() if observability is desired.
let loggerHandle: ReturnType<typeof setInterval> | null = null

export function startChatDedupCounterLogger(intervalMs = 60_000) {
  if (loggerHandle) return
  loggerHandle = setInterval(() => {
    const snapshot = getChatDedupCountersSnapshot()
    if (Object.keys(snapshot).length === 0) return
    console.info("[chat.dedup]", snapshot)
  }, intervalMs)
  // Don't keep the event loop alive just for telemetry.
  if (typeof loggerHandle.unref === "function") loggerHandle.unref()
}

export function stopChatDedupCounterLogger() {
  if (!loggerHandle) return
  clearInterval(loggerHandle)
  loggerHandle = null
}
