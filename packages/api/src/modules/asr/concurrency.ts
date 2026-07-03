// Provider-neutral realtime-ASR concurrency limiter. One global module-level set
// of active session ids; the cap is passed IN by the active provider (Volcengine
// passes config.asr.volcengine.maxConcurrency) so the core carries no vendor ref.
//
// A single global limiter is correct: exactly one provider is active per process
// (selected by config.asr.provider at boot), and switching providers requires a
// restart — which clears this in-memory set. Acquire on session start, release on
// session close. Migrated verbatim from the pre-abstraction modules/asr/service.ts.

const activeSessionIds = new Set<string>()

/** Reserve a slot for `sessionId` under `cap`. Idempotent for an already-held id.
 *  Returns false when the cap is reached (the caller surfaces
 *  ASR_CONCURRENCY_LIMIT_REACHED). */
export function acquireConcurrencySlot(
  sessionId: string,
  cap: number
): boolean {
  if (activeSessionIds.has(sessionId)) {
    return true
  }

  if (activeSessionIds.size >= Math.max(1, cap)) {
    return false
  }

  activeSessionIds.add(sessionId)
  return true
}

export function releaseConcurrencySlot(sessionId: string): void {
  activeSessionIds.delete(sessionId)
}
