/**
 * Personal-WeChat (ilinkai) typing indicator adapter.
 *
 * Maps TypingAdapter start/stop to POST /ilink/bot/sendtyping with
 * status=1 (begin) and status=2 (cancel). The endpoint is undocumented;
 * if it 4xx/5xxs the TypingController's failure guard kicks in.
 */

import type { TransportAccountSummary } from "@synapse/shared/types"
import type { TypingAdapter } from "../../typing/controller.js"
import { buildWeixinHeaders, getWeixinCredentialsOrThrow } from "./client.js"
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
  const url = `${baseUrl!.replace(/\/+$/, "")}/ilink/bot/sendtyping`
  const toUserId = deps.endpointRef.externalId

  async function send(status: 1 | 2): Promise<void> {
    const body = JSON.stringify({
      msg: { to_user_id: toUserId, status },
      base_info: {},
    })
    const response = await fetch(url, {
      method: "POST",
      headers: buildWeixinHeaders(body, token),
      body,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(
        `Weixin sendtyping(${status}) failed ${response.status}: ${text.slice(0, 200)}`
      )
    }
  }

  return {
    start: () => send(1),
    stop: () => send(2),
  }
}
