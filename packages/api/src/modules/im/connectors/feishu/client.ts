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

function larkDomain(domain: "feishu" | "lark" | undefined): Lark.Domain {
  // Default to Feishu (open.feishu.cn) so existing China accounts are unchanged.
  return domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu
}

export function createFeishuClient(account: TransportAccountSummary) {
  const { appId, appSecret, domain } = getFeishuCredentialsOrThrow(account)
  return new Lark.Client({
    appId,
    appSecret,
    domain: larkDomain(domain),
    loggerLevel: Lark.LoggerLevel.warn,
  })
}

export function createFeishuWsClient(account: TransportAccountSummary) {
  const { appId, appSecret, domain } = getFeishuCredentialsOrThrow(account)
  return new Lark.WSClient({
    appId,
    appSecret,
    domain: larkDomain(domain),
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
