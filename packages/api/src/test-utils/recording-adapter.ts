/**
 * Recording adapters for status-reaction and typing controllers.
 * Each op is appended to an `ops` array with the current clock time, so tests
 * can assert exact call sequences without resorting to spies.
 */

import type { StatusReactionAdapter } from "../modules/im/status-reaction/controller.js"

export type StatusOp =
  | { kind: "set"; emoji: string; at: number }
  | { kind: "clear"; at: number }
  | { kind: "remove"; emoji: string; at: number }

export interface RecordingStatusReactionAdapter extends StatusReactionAdapter {
  ops: StatusOp[]
  /** When set, the next op rejects with this error (then resets to null). */
  nextFailure: Error | null
  /** Optional artificial delay (ms) for setReaction calls; consumed once. */
  nextDelayMs: number | null
}

export function createRecordingStatusAdapter(
  now: () => number = () => Date.now()
): RecordingStatusReactionAdapter {
  const adapter: RecordingStatusReactionAdapter = {
    ops: [],
    nextFailure: null,
    nextDelayMs: null,
    async setReaction(emoji) {
      if (adapter.nextDelayMs !== null) {
        const ms = adapter.nextDelayMs
        adapter.nextDelayMs = null
        await new Promise((r) => setTimeout(r, ms))
      }
      if (adapter.nextFailure) {
        const err = adapter.nextFailure
        adapter.nextFailure = null
        throw err
      }
      adapter.ops.push({ kind: "set", emoji, at: now() })
    },
    async clearReaction() {
      adapter.ops.push({ kind: "clear", at: now() })
    },
    async removeReaction(emoji) {
      adapter.ops.push({ kind: "remove", emoji, at: now() })
    },
  }
  return adapter
}

export type TypingOp =
  | { kind: "start"; at: number }
  | { kind: "stop"; at: number }

export interface RecordingTypingAdapter {
  ops: TypingOp[]
  /** Force the next op to fail. Reset to null after consumption. */
  nextFailure: Error | null
  start(): Promise<void>
  stop(): Promise<void>
}

export function createRecordingTypingAdapter(
  now: () => number = () => Date.now()
): RecordingTypingAdapter {
  const adapter: RecordingTypingAdapter = {
    ops: [],
    nextFailure: null,
    async start() {
      if (adapter.nextFailure) {
        const err = adapter.nextFailure
        adapter.nextFailure = null
        throw err
      }
      adapter.ops.push({ kind: "start", at: now() })
    },
    async stop() {
      if (adapter.nextFailure) {
        const err = adapter.nextFailure
        adapter.nextFailure = null
        throw err
      }
      adapter.ops.push({ kind: "stop", at: now() })
    },
  }
  return adapter
}
