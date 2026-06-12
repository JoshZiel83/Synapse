import {
  type FeishuFeatureKey,
  getFeishuFeatureScopeCoverage,
  resolveFeishuFeatureScopes,
} from "./features.js"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { parseJsonObject } from "@synapse/shared"

type JsonObject = Record<string, unknown>
type RequestBody =
  | string
  | URLSearchParams
  | FormData
  | Blob
  | ArrayBuffer
  | Uint8Array

export type FeishuBrand = "feishu" | "lark"
export type FeishuAppScopeInspection = {
  status: "ready" | "missing_app_scopes" | "unavailable"
  canQuery: boolean
  checkedAt: string
  message: string
  requestedFeatures: string[]
  requestedScopes: string[]
  enabledScopes: string[]
  missingScopes: string[]
  missingFeatures: Array<{
    key: string
    title: string
    missingScopes: string[]
    mayRequireAppReview?: boolean
  }>
  consoleUrl?: string
  queryError?: string
}

type FeishuResolvedConnection = {
  status?: string
  publicPayload?: JsonObject
  secretPayload?: JsonObject
}

// Business JSON decode → shared parseJsonObject (object-only, array-reject). r6 P1-8.
const asObject = parseJsonObject

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0
    )
  }

  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return []
}

export function resolveFeishuOpenBaseUrl(brand: FeishuBrand) {
  return brand === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn"
}

export function resolveFeishuAccountsBaseUrl(brand: FeishuBrand) {
  return brand === "lark"
    ? "https://accounts.larksuite.com"
    : "https://accounts.feishu.cn"
}

export function buildFeishuScopeApplyUrl(
  brand: FeishuBrand,
  appId: string,
  scopes: string[]
) {
  const host = brand === "lark" ? "open.larksuite.com" : "open.feishu.cn"
  const url = new URL(`https://${host}/page/scope-apply`)
  url.searchParams.set("clientID", appId)
  if (scopes.length > 0) {
    url.searchParams.set("scopes", Array.from(new Set(scopes)).join(" "))
  }
  return url.toString()
}

function readFeishuConnection(
  config: Record<string, unknown>
): FeishuResolvedConnection {
  const raw = config.feishuAccount
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "Feishu account is not configured. Reconnect the plugin and try again."
    )
  }

  const connection = raw as FeishuResolvedConnection
  if (connection.status && connection.status !== "active") {
    throw new Error(
      "Feishu account authorization expired. Reconnect the plugin and try again."
    )
  }

  return connection
}

export function getFeishuConnectionMetadata(config: Record<string, unknown>) {
  const connection = readFeishuConnection(config)
  const publicPayload = asObject(connection.publicPayload)
  const secretPayload = asObject(connection.secretPayload)
  const brand = asString(publicPayload.brand) === "lark" ? "lark" : "feishu"
  const openBaseUrl =
    asString(publicPayload.openBaseUrl) || resolveFeishuOpenBaseUrl(brand)
  const accountsBaseUrl =
    asString(publicPayload.accountsBaseUrl) ||
    resolveFeishuAccountsBaseUrl(brand)
  const accessToken = asString(secretPayload.accessToken)
  const appId = asString(secretPayload.appId)
  const appSecret = asString(secretPayload.appSecret)
  const refreshToken = asString(secretPayload.refreshToken)

  if (!accessToken) {
    throw new Error(
      "Feishu user access token is missing. Reconnect the plugin and try again."
    )
  }

  return {
    brand: brand as FeishuBrand,
    openBaseUrl,
    accountsBaseUrl,
    accessToken,
    appId,
    appSecret,
    refreshToken,
    scopes: Array.isArray(publicPayload.scopes)
      ? publicPayload.scopes.filter(
          (item): item is string => typeof item === "string"
        )
      : [],
  }
}

async function parseErrorResponse(response: Response) {
  const contentType = response.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    const payload = asObject(await response.json().catch(() => ({})))
    const message =
      asString(payload.msg) ||
      asString(payload.error_description) ||
      asString(payload.error) ||
      `HTTP ${response.status}`
    const code = payload.code
    if (typeof code === "number") {
      return `[${code}] ${message}`
    }
    return message
  }

  const text = await response.text().catch(() => "")
  return text.trim() || `HTTP ${response.status}`
}

async function requestTenantAccessToken(input: {
  brand: FeishuBrand
  openBaseUrl?: string
  appId: string
  appSecret: string
}) {
  const endpoint = `${
    input.openBaseUrl || resolveFeishuOpenBaseUrl(input.brand)
  }/open-apis/auth/v3/tenant_access_token/internal`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      app_id: input.appId,
      app_secret: input.appSecret,
    }),
  })
  const payload = asObject(await response.json().catch(() => ({})))
  const code = typeof payload.code === "number" ? payload.code : undefined

  if (!response.ok || (code !== undefined && code !== 0)) {
    throw new Error(
      code !== undefined
        ? `[${code}] ${asString(payload.msg) || "Failed to request Feishu tenant access token."}`
        : asString(payload.msg) ||
            asString(payload.error_description) ||
            "Failed to request Feishu tenant access token."
    )
  }

  const tenantAccessToken =
    asString(payload.tenant_access_token) ||
    asString(asObject(payload.data).tenant_access_token)
  if (!tenantAccessToken) {
    throw new Error(
      "Feishu tenant access token response is missing tenant_access_token."
    )
  }

  return tenantAccessToken
}

function isUserTokenType(tokenType: string) {
  return tokenType === "user" || tokenType === "user_access_token"
}

export async function inspectFeishuAppScopeStatus(input: {
  brand: FeishuBrand
  openBaseUrl?: string
  appId: string
  appSecret: string
  requestedFeatures: FeishuFeatureKey[]
  requestedScopes?: string[]
}): Promise<FeishuAppScopeInspection> {
  const checkedAt = nowIsoInstant()
  const requestedScopes = Array.from(
    new Set(
      (input.requestedScopes && input.requestedScopes.length > 0
        ? input.requestedScopes
        : resolveFeishuFeatureScopes(input.requestedFeatures)
      ).filter(Boolean)
    )
  )
  const baseResult = {
    checkedAt,
    requestedFeatures: input.requestedFeatures,
    requestedScopes,
    enabledScopes: [] as string[],
    missingScopes: requestedScopes,
    missingFeatures: getFeishuFeatureScopeCoverage(input.requestedFeatures, []),
    consoleUrl: buildFeishuScopeApplyUrl(
      input.brand,
      input.appId,
      requestedScopes
    ),
  }

  try {
    const tenantAccessToken = await requestTenantAccessToken(input)
    const endpoint = `${
      input.openBaseUrl || resolveFeishuOpenBaseUrl(input.brand)
    }/open-apis/application/v6/applications/${encodeURIComponent(input.appId)}?lang=zh_cn`
    const response = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        Accept: "application/json",
      },
    })
    const payload = asObject(await response.json().catch(() => ({})))
    const code = typeof payload.code === "number" ? payload.code : undefined

    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new Error(
        code !== undefined
          ? `[${code}] ${asString(payload.msg) || "Failed to query Feishu app scopes."}`
          : asString(payload.msg) || "Failed to query Feishu app scopes."
      )
    }

    const scopeRows = Array.isArray(asObject(asObject(payload.data).app).scopes)
      ? (asObject(payload.data).app as { scopes?: unknown[] }).scopes || []
      : []
    const enabledScopes = Array.from(
      new Set(
        scopeRows.flatMap((row) => {
          const scope = asString(asObject(row).scope)
          const tokenTypes = asStringArray(asObject(row).token_types)
          return scope && tokenTypes.some(isUserTokenType) ? [scope] : []
        })
      )
    ).sort()
    const enabledScopeSet = new Set(enabledScopes)
    const missingScopes = requestedScopes.filter(
      (scope) => !enabledScopeSet.has(scope)
    )
    const missingFeatures = getFeishuFeatureScopeCoverage(
      input.requestedFeatures,
      enabledScopes
    ).filter((feature) => feature.missingScopes.length > 0)

    return {
      status: missingScopes.length === 0 ? "ready" : "missing_app_scopes",
      canQuery: true,
      checkedAt,
      message:
        missingScopes.length === 0
          ? "The Feishu app already has all selected user scopes enabled."
          : "The Feishu app is still missing some user scopes for the selected features.",
      requestedFeatures: input.requestedFeatures,
      requestedScopes,
      enabledScopes,
      missingScopes,
      missingFeatures,
      consoleUrl:
        missingScopes.length > 0
          ? buildFeishuScopeApplyUrl(input.brand, input.appId, missingScopes)
          : undefined,
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to query Feishu app scopes."

    return {
      status: "unavailable",
      canQuery: false,
      checkedAt,
      message: message.includes("application:application:self_manage")
        ? "Unable to query app scopes because the app has not enabled application:application:self_manage yet."
        : "Unable to query Feishu app scopes right now.",
      requestedFeatures: input.requestedFeatures,
      requestedScopes,
      enabledScopes: [],
      missingScopes: requestedScopes,
      missingFeatures: baseResult.missingFeatures,
      consoleUrl: baseResult.consoleUrl,
      queryError: message,
    }
  }
}

export class FeishuApiClient {
  constructor(
    public readonly openBaseUrl: string,
    private readonly accessToken: string
  ) {}

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ) {
    const url = new URL(path, this.openBaseUrl)
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === "") continue
      url.searchParams.set(key, String(value))
    }
    return url
  }

  async requestJson<T = JsonObject>(input: {
    path: string
    method?: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
    headers?: Record<string, string>
  }): Promise<T> {
    const url = this.buildUrl(input.path, input.query)
    const headers = new Headers(input.headers || {})
    headers.set("Authorization", `Bearer ${this.accessToken}`)
    headers.set("Accept", "application/json")

    let body: RequestBody | undefined
    if (input.body !== undefined) {
      if (input.body instanceof FormData) {
        body = input.body
      } else {
        headers.set("Content-Type", "application/json")
        body = JSON.stringify(input.body)
      }
    }

    const response = await fetch(url, {
      method: input.method || "GET",
      headers,
      body,
    })

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response))
    }

    const payload = asObject(await response.json().catch(() => ({})))
    if (typeof payload.code === "number" && payload.code !== 0) {
      throw new Error(
        `[${payload.code}] ${
          asString(payload.msg) || "Feishu API request failed"
        }`
      )
    }

    return (
      asObject(payload.data).code !== undefined
        ? payload.data
        : (payload.data ?? payload)
    ) as T
  }

  async requestBuffer(input: {
    path: string
    method?: string
    query?: Record<string, string | number | boolean | undefined>
    body?: RequestBody
    headers?: Record<string, string>
  }) {
    const url = this.buildUrl(input.path, input.query)
    const headers = new Headers(input.headers || {})
    headers.set("Authorization", `Bearer ${this.accessToken}`)

    const response = await fetch(url, {
      method: input.method || "GET",
      headers,
      body: input.body,
    })

    if (!response.ok) {
      throw new Error(await parseErrorResponse(response))
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType:
        response.headers.get("content-type") || "application/octet-stream",
      contentDisposition: response.headers.get("content-disposition") || "",
    }
  }
}

export function createFeishuApiClient(config: Record<string, unknown>) {
  const metadata = getFeishuConnectionMetadata(config)
  return {
    metadata,
    client: new FeishuApiClient(metadata.openBaseUrl, metadata.accessToken),
  }
}

export function parseJsonObjectInput(
  value: unknown,
  label: string
): JsonObject {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonObject
      }
    } catch {
      throw new Error(`${label} must be a JSON object.`)
    }
    throw new Error(`${label} must be a JSON object.`)
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject
  }

  throw new Error(`${label} must be a JSON object.`)
}

export function parseJsonArrayInput(value: unknown, label: string): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      throw new Error(`${label} must be a JSON array.`)
    }
    throw new Error(`${label} must be a JSON array.`)
  }

  if (Array.isArray(value)) {
    return value
  }

  throw new Error(`${label} must be a JSON array.`)
}

export function stripMarkdown(value: string) {
  return value
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim()
}
