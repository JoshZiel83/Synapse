/**
 * QQ inbound — Stage 1 skeleton.
 *
 * Webhook + WebSocket are filled in by Stages 2 and 3 respectively. For
 * now `startAccount` is a no-op (long_connection accounts will spawn
 * the WS client in Stage 3; webhook accounts never go through this
 * path anyway because the runtime manager only runs long_connection
 * accounts), and `handleWebhook` returns a 501-style response so any
 * misconfigured webhook routing surfaces in logs rather than silently
 * accepting payloads.
 */

import type {
  AccountStartContext,
  RunningAccount,
  WebhookHandlerInput,
  WebhookHandlerResult,
} from "../types.js"

export async function startQqAccount(
  ctx: AccountStartContext
): Promise<RunningAccount> {
  const mode = ctx.account.connectionMode
  if (mode === "webhook") {
    ctx.logger.info("qq: webhook mode — no long connection started")
    return { stop: async () => {} }
  }
  // long_connection — Stage 3 will replace this with the WS gateway.
  ctx.logger.warn(
    "qq: long_connection mode not yet implemented (Stage 3); leaving account idle"
  )
  return { stop: async () => {} }
}

export async function handleQqWebhook(
  _input: WebhookHandlerInput
): Promise<WebhookHandlerResult> {
  // Stage 2 implements op=13 challenge + op=0 dispatch with Ed25519
  // verification. Returning 503 keeps the route reachable but visible
  // in monitoring until then.
  return {
    statusCode: 503,
    body: {
      error: "qq webhook handler not yet implemented (Stage 2)",
    },
  }
}
