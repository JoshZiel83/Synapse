/**
 * QQ C2C typing indicator (Stage 6).
 *
 * Per QQ wiki: POST /v2/users/{openid}/messages with
 * `{msg_type:6, input_notify:{input_type:1, input_second:60}}` shows
 * an "input notification" in the user's C2C window for ~60 seconds.
 * Re-send every ~50 seconds while the user is waiting on a response.
 *
 * Group endpoints don't have an equivalent — there's no "X is typing"
 * concept in QQ groups. The connector returns null for group adapters
 * so the IM typing controller becomes a no-op there.
 *
 * The adapter also needs a valid `msg_id` anchor to address the C2C
 * channel; G2's `lastInboundMessageRef` carries it. If the inbound ref
 * is missing (idle proactive trigger), we return null too — typing
 * without a current message anchor would just produce 4xx noise.
 */

import { qqApiFetch } from "./client.js"
import { decodeUserOpenid } from "./address-encoding.js"
import { QQ_MSG_TYPE } from "./types.js"
import type { EndpointRef, MessageRef, TypingAdapterResult } from "../types.js"
import type { TransportAccountSummary } from "@synapse/shared/types"

/**
 * Build a typing adapter for QQ. Returns null when:
 *   - endpoint is a group (QQ has no group-typing concept)
 *   - the endpoint external_id doesn't decode to a user_openid
 *   - `lastInboundMessageRef` is missing (no msg_id to anchor)
 *
 * Otherwise returns {adapter, config:{heartbeatMs:50_000}} per G2 so
 * the typing controller re-sends every 50s and the "input bubble"
 * stays visible across the QQ-side 60s expiry.
 */
export function createQqTypingAdapter(input: {
  account: TransportAccountSummary
  endpointRef: EndpointRef
  lastInboundMessageRef?: MessageRef
}): TypingAdapterResult | null {
  if (input.endpointRef.endpointType !== "direct") return null
  const userOpenid = decodeUserOpenid(input.endpointRef.externalId)
  if (!userOpenid) return null
  if (!input.lastInboundMessageRef?.externalMessageId) return null
  const msgId = input.lastInboundMessageRef.externalMessageId

  let stopped = false
  return {
    adapter: {
      start: async () => {
        if (stopped) return
        await sendInputNotify(input.account, userOpenid, msgId).catch((err) => {
          // Best-effort — typing failures must not abort the actor turn.
          console.warn(
            `[im:qq] input_notify failed for openid=${userOpenid}:`,
            err
          )
        })
      },
      stop: async () => {
        // QQ has no "stop typing" — the input_notify TTL handles it
        // naturally. Set a flag so any pending start() call (queued
        // after stop()) becomes a no-op.
        stopped = true
      },
    },
    config: {
      // Re-send 10s before the 60s expiry to keep the indicator visible.
      heartbeatMs: 50_000,
      // Hard upper bound: stop after 5 minutes regardless of caller
      // (protects against forgotten controllers).
      ttlMs: 5 * 60 * 1000,
      maxFailures: 2,
    },
  }
}

async function sendInputNotify(
  account: TransportAccountSummary,
  userOpenid: string,
  msgId: string
): Promise<void> {
  const res = await qqApiFetch(
    account,
    `/v2/users/${encodeURIComponent(userOpenid)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        msg_type: QQ_MSG_TYPE.INPUT_NOTIFY,
        msg_id: msgId,
        input_notify: { input_type: 1, input_second: 60 },
      }),
    }
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`qq input_notify ${res.status}: ${text.slice(0, 120)}`)
  }
}
