/**
 * QQ outbound — Stage 1 skeleton.
 *
 * Real implementation lands in Stage 4 (text) + Stage 5 (rich media) +
 * Stage 8 (Inline Keyboard). For now we throw a PermanentTransportError
 * so any premature scheduling surfaces clearly in dashboard / sweeper
 * metadata rather than silently retrying.
 */

import {
  PermanentTransportError,
  type OutboundSendInput,
  type OutboundSendResult,
} from "../types.js"

export async function sendQqMessage(
  _input: OutboundSendInput
): Promise<OutboundSendResult> {
  throw new PermanentTransportError(
    "qq sendMessage not yet implemented (Stage 4)",
    { code: "qq_outbound_not_implemented" }
  )
}
