/**
 * Tool-call/result pairing reconciler.
 *
 * The AI-SDK provider converters require a structurally complete transcript:
 * every assistant tool-call must be followed by a tool_result with the SAME
 * toolCallId, or the provider rejects it (Anthropic 400 on orphan tool_use; the
 * SDK raises MissingToolResultsError). With branch-state deleted, the canonical
 * layer is the only continuity carrier, and a crash / interrupt
 * (TurnInterruptedError) can leave an assistant turn whose tool-calls never got
 * results. This pass repairs that BEFORE sending — Synapse owns the invariant,
 * not the SDK.
 *
 * Policy (explicit, not implicit): for each assistant message carrying
 * tool-calls, any callId without a matching tool_result in the IMMEDIATELY
 * following tool_result message(s) gets a synthesized error-text result
 * ("tool execution interrupted"). This keeps the transcript valid and tells the
 * model the call did not complete, rather than silently dropping the call (which
 * would orphan the assistant turn) or truncating history.
 */
import type {
  CanonicalContentBlock,
  CanonicalToolResult,
  ConversationMessage,
} from "@synapse/shared"
import { textBlock } from "@synapse/shared"

const INTERRUPTED_TEXT =
  "Tool execution was interrupted; no result was produced."

function synthesizedResult(
  toolCallId: string,
  toolName: string,
  providerCallId?: string
): CanonicalToolResult {
  const content: CanonicalContentBlock[] = [textBlock(INTERRUPTED_TEXT)]
  return {
    toolCallId,
    providerCallId,
    toolName,
    content,
    isError: true,
    metadata: { synthesized: "interrupted" },
  }
}

/**
 * Returns a new message array where every assistant tool-call has a matching
 * tool_result. Does not mutate the input. Idempotent (re-running is a no-op once
 * all calls are paired).
 */
export function reconcileToolPairing(
  messages: ConversationMessage[]
): ConversationMessage[] {
  const out: ConversationMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    out.push(msg)

    if (
      msg.role !== "assistant" ||
      !msg.toolCalls ||
      msg.toolCalls.length === 0
    ) {
      continue
    }

    // Collect resolved callIds from the immediately-following tool_result
    // message(s) (the canonical layer emits one tool_result_batch per round, but
    // tolerate several).
    const resolved = new Set<string>()
    let j = i + 1
    while (j < messages.length && messages[j].role === "tool_result") {
      const tr = messages[j]
      if (tr.role === "tool_result") {
        for (const r of tr.results) resolved.add(r.toolCallId)
      }
      j++
    }

    const missing = msg.toolCalls.filter((tc) => !resolved.has(tc.callId))
    if (missing.length === 0) continue

    const synth: ConversationMessage = {
      role: "tool_result",
      results: missing.map((tc) =>
        synthesizedResult(tc.callId, tc.toolName, tc.providerCallId)
      ),
    }
    // Insert the synthesized results right after the assistant turn (before any
    // existing tool_result messages so ordering stays call → result).
    out.push(synth)
  }

  return out
}

export { INTERRUPTED_TEXT }
