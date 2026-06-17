/**
 * Personal-WeChat (ilink) typing indicator adapter.
 *
 * Upstream `sendtyping` takes `{ ilink_user_id, typing_ticket, status }` where
 * the ticket is fetched per-user from `ilink/bot/getconfig`. The previous
 * version sent `{ msg: { to_user_id, status } }` with no ticket, which the
 * gateway ignores. We fetch the ticket lazily on first start() and reuse it for
 * the lifetime of this adapter (recreated per turn by actor-status-hooks).
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import type { TypingAdapter } from "../../typing/controller.js"
import {
  getWeixinCredentialsOrThrow,
  nonEmpty,
  postWeixinJson,
} from "./client.js"
import {
  buildWeixinBaseInfo,
  WEIXIN_ENDPOINTS,
  WEIXIN_TYPING_STATUS,
} from "./protocol.js"
import type { EndpointRef } from "../types.js"

export interface WeixinTypingAdapterDeps {
  account: TransportAccountSummary
  endpointRef: EndpointRef
  logger?: {
    warn(msg: string, fields?: Record<string, unknown>): void
  }
}

export function createWeixinTypingAdapter(
  deps: WeixinTypingAdapterDeps
): TypingAdapter {
  const { token, baseUrl } = getWeixinCredentialsOrThrow(deps.account)
  const toUserId = deps.endpointRef.externalId

  // typing_ticket is per-user; fetch once via getconfig, then reuse.
  let ticketPromise: Promise<string | undefined> | undefined
  function getTicket(): Promise<string | undefined> {
    if (!ticketPromise) {
      ticketPromise = postWeixinJson({
        baseUrl: baseUrl!,
        endpoint: WEIXIN_ENDPOINTS.GET_CONFIG,
        token,
        timeoutMs: 10_000,
        body: { ilink_user_id: toUserId, base_info: buildWeixinBaseInfo() },
      })
        .then((resp) =>
          Number(resp.ret || 0) === 0 ? nonEmpty(resp.typing_ticket) : undefined
        )
        .catch(() => undefined)
    }
    return ticketPromise
  }

  async function send(status: number): Promise<void> {
    const typingTicket = await getTicket()
    await postWeixinJson({
      baseUrl: baseUrl!,
      endpoint: WEIXIN_ENDPOINTS.SEND_TYPING,
      token,
      timeoutMs: 10_000,
      body: {
        ilink_user_id: toUserId,
        typing_ticket: typingTicket,
        status,
        base_info: buildWeixinBaseInfo(),
      },
    })
  }

  return {
    start: () => send(WEIXIN_TYPING_STATUS.TYPING),
    stop: () => send(WEIXIN_TYPING_STATUS.CANCEL),
  }
}
