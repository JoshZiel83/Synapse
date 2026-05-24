/**
 * Lark.Client + Lark.WSClient + Lark.EventDispatcher factories.
 *
 * Clients are not cached; the underlying SDK manages tenant tokens internally.
 */

import * as Lark from "@larksuiteoapi/node-sdk"
import type { TransportAccountSummary } from "@synapse/shared/types"
import { extractFeishuCredentials } from "./credentials.js"

export function getFeishuCredentialsOrThrow(account: TransportAccountSummary) {
  const { credentials, errors } = extractFeishuCredentials(account.credentials)
  if (!credentials) {
    throw new Error(
      `Feishu account ${account.id} credentials invalid: ${errors.join(", ")}`
    )
  }
  return credentials
}

export function createFeishuClient(account: TransportAccountSummary) {
  const { appId, appSecret } = getFeishuCredentialsOrThrow(account)
  return new Lark.Client({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
  })
}

export function createFeishuWsClient(account: TransportAccountSummary) {
  const { appId, appSecret } = getFeishuCredentialsOrThrow(account)
  return new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
  })
}

export function createFeishuEventDispatcher(account: TransportAccountSummary) {
  const { verificationToken, encryptKey } = getFeishuCredentialsOrThrow(account)
  return new Lark.EventDispatcher({
    verificationToken,
    encryptKey,
    loggerLevel: Lark.LoggerLevel.warn,
  })
}
