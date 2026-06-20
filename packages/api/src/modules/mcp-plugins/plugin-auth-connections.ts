import { createHash, randomBytes } from "crypto"
import type {
  PluginAuthBindingDefinition,
  PluginAuthConnection,
  PluginAuthValueSource,
  PluginConfigFieldDefinition,
} from "@synapse/shared"
import {
  PLUGIN_AUTH_BINDING_DRIVER_KIND,
  PLUGIN_AUTH_CHALLENGE_KIND,
  PLUGIN_AUTH_CHALLENGE_OPEN_MODE,
  PLUGIN_AUTH_CONNECTION_STATUS,
  PLUGIN_AUTH_DERIVED_VALUE_NAME,
  PLUGIN_AUTH_SESSION_PHASE,
  PLUGIN_AUTH_SESSION_STATUS,
  PLUGIN_AUTH_VALUE_SOURCE_KIND,
  PLUGIN_CONFIG_FIELD_TYPE,
  parseJsonObject,
} from "@synapse/shared"
import { requireEpochMillis } from "@synapse/shared/datetime"
import { config } from "../../config/index.js"
import {
  decrypt,
  decryptSensitiveFields,
  encrypt,
} from "../../infrastructure/crypto/index.js"
import { parseInstantString } from "../../infrastructure/datetime.js"
import {
  defaultPluginConnectionRunner,
  findPluginAuthConnectionRow,
  findPluginAuthSessionRow,
  findPluginAuthSessionRowByState,
  findPluginInstallationAuthConfigRow,
  getPluginAuthSpecRow,
  insertPluginAuthSession,
  updatePluginAuthSession,
  updatePluginAuthSessionNoReturn,
  updatePluginConnection,
  upsertPluginAuthConnectionFromSessionResult,
  type PluginConnectionQueryRunner,
} from "./repo.js"
import {
  normalizeMijiaLocale,
  progressMijiaQrLoginSession,
  refreshMijiaSessionTokens,
  startMijiaQrLoginSession,
} from "./mijia/auth.js"
import { persistMijiaConnectionState } from "./mijia/connection-store.js"
import type { MijiaAuthState } from "./mijia/types.js"
import {
  progressFeishuCliSetup,
  refreshFeishuUserAccessToken,
  startFeishuCliSetup,
} from "./feishu/auth.js"
import {
  type FeishuAppScopeInspection,
  inspectFeishuAppScopeStatus,
  resolveFeishuAccountsBaseUrl,
  resolveFeishuOpenBaseUrl,
} from "./feishu/client.js"
import { normalizeFeishuFeatureKeys } from "./feishu/features.js"
import {
  presentAuthConnection,
  presentAuthSession,
  presentInstant,
} from "./presenter.js"

type JsonObject = Record<string, unknown>

export type { PluginAuthSessionRow, PluginConnectionRow } from "./repo.types.js"
import type {
  PluginAuthSessionRow,
  PluginConnectionRow,
  PluginAuthSessionsChallengePayload,
  PluginAuthSessionsMetadata,
  PluginAuthSessionsResultPayload,
  PluginAuthSessionsResultPreview,
  PluginAuthSessionsTransientPayload,
  PluginConnectionsPublicPayload,
  PluginConnectionsSecretPayload,
} from "./repo.types.js"

type PluginAuthSpec = {
  catalogItemId: string
  catalogVersionId: string | null
  defaultConfig: Record<string, unknown>
  authBindings: PluginAuthBindingDefinition[]
}

type InstallationConfigRow = {
  catalogItemId: string
  catalogVersionId: string
  configData: Record<string, unknown>
  defaultConfig: Record<string, unknown>
}

type OAuthTransientPayload = {
  codeVerifier: string
  redirectUri: string
  clientId: string
  clientSecret?: string
  tokenUrl: string
  userInfoUrl?: string
  tokenRequestContentType:
    | "application/json"
    | "application/x-www-form-urlencoded"
  audience?: string
  extraTokenParams?: Record<string, string>
  profileIdPath?: string
  profileDisplayNamePath?: string
  profileAvatarUrlPath?: string
}

export class PluginAuthError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

// Business JSON decode → shared parseJsonObject (object-only, array-reject). r6 P1-8.
const asObject = parseJsonObject

export async function readProviderJsonObjectResponse(
  response: Response,
  label: string
): Promise<JsonObject> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await response.text())
  } catch {
    throw new PluginAuthError(
      response.ok ? 502 : response.status || 502,
      `${label} must be valid JSON.`
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginAuthError(
      response.ok ? 502 : response.status || 502,
      `${label} must be a JSON object.`
    )
  }
  return parsed as JsonObject
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asNullableString(value: unknown): string | null {
  const normalized = asString(value)
  return normalized || null
}

function asStringArray(value: unknown): string[] {
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

function isMissingConfigValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  )
}

function base64Url(buffer: Buffer) {
  return buffer.toString("base64url")
}

function createPkcePair() {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

function getByPath(source: unknown, path?: string): unknown {
  if (!path) return undefined
  let current: unknown = source
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function decryptDeep(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return decrypt(value)
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => decryptDeep(item))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = decryptDeep(nested)
    }
    return result
  }
  return value
}

function encryptDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return encrypt(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => encryptDeep(item))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = encryptDeep(nested)
    }
    return result
  }
  return value
}

async function getPluginAuthSpec(
  pluginId: string,
  catalogVersionId?: string | null
): Promise<PluginAuthSpec> {
  const row = await getPluginAuthSpecRow(pluginId, catalogVersionId)

  if (!row) {
    throw new PluginAuthError(404, "Plugin not found")
  }

  return {
    catalogItemId: row.catalogItemId,
    catalogVersionId: row.catalogVersionId,
    defaultConfig: row.defaultConfig,
    authBindings: row.authBindings,
  }
}

function getBinding(
  bindings: PluginAuthBindingDefinition[],
  bindingKey: string
) {
  const binding = bindings.find((item) => item.key === bindingKey)
  if (!binding) {
    throw new PluginAuthError(404, "Auth binding not found")
  }
  return binding
}

async function getSessionRow(
  sessionId: string,
  workspaceId: string,
  workspaceMemberId: string
) {
  const row = await findPluginAuthSessionRow(
    sessionId,
    workspaceId,
    workspaceMemberId
  )
  if (!row) {
    throw new PluginAuthError(404, "Auth session not found")
  }
  return row
}

async function getSessionRowByState(state: string) {
  const row = await findPluginAuthSessionRowByState(state)
  if (!row) {
    throw new PluginAuthError(404, "Auth session not found")
  }
  return row
}

async function getConnectionRow(connectionId: string, workspaceId?: string) {
  const row = await findPluginAuthConnectionRow(connectionId, workspaceId)
  if (!row) {
    throw new PluginAuthError(404, "Auth connection not found")
  }
  return row
}

async function getInstallationConfigRow(
  installationId: string,
  workspaceId: string
): Promise<InstallationConfigRow> {
  const row = await findPluginInstallationAuthConfigRow(
    installationId,
    workspaceId
  )

  if (!row) {
    throw new PluginAuthError(404, "Installation not found")
  }

  return row
}

function mergeConfigLayers(...layers: Record<string, unknown>[]) {
  const merged: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
  }
  return merged
}

async function buildDraftConfig(input: {
  workspaceId: string
  pluginId: string
  defaultConfig: Record<string, unknown>
  installationId?: string
  draftConfig?: Record<string, unknown>
}) {
  if (!input.installationId) {
    return mergeConfigLayers(input.defaultConfig, input.draftConfig || {})
  }

  const row = await getInstallationConfigRow(
    input.installationId,
    input.workspaceId
  )
  if (row.catalogItemId !== input.pluginId) {
    throw new PluginAuthError(
      400,
      "Installation does not belong to this plugin"
    )
  }

  return mergeConfigLayers(
    input.defaultConfig,
    decryptSensitiveFields(row.configData),
    input.draftConfig || {}
  )
}

function defaultOauthCallbackUrl() {
  return `${config.app.baseUrl.replace(/\/$/, "")}/api/v1/mcp/auth/callback`
}

function resolveAuthValue(
  source: PluginAuthValueSource | undefined,
  configData: Record<string, unknown>
) {
  if (!source) return undefined
  switch (source.source) {
    case PLUGIN_AUTH_VALUE_SOURCE_KIND.CONFIG:
      return source.field ? configData[source.field] : undefined
    case PLUGIN_AUTH_VALUE_SOURCE_KIND.ENV:
      return source.env ? process.env[source.env] : undefined
    case PLUGIN_AUTH_VALUE_SOURCE_KIND.LITERAL:
      return source.value
    case PLUGIN_AUTH_VALUE_SOURCE_KIND.DERIVED:
      if (source.name === PLUGIN_AUTH_DERIVED_VALUE_NAME.APP_BASE_URL) {
        return config.app.baseUrl.replace(/\/$/, "")
      }
      if (source.name === PLUGIN_AUTH_DERIVED_VALUE_NAME.OAUTH_CALLBACK_URL) {
        return defaultOauthCallbackUrl()
      }
      return undefined
    default:
      return undefined
  }
}

function getBindingStringInput(
  binding: PluginAuthBindingDefinition,
  inputKey: string,
  configData: Record<string, unknown>
) {
  return asString(resolveAuthValue(binding.inputs?.[inputKey], configData))
}

function validatePrerequisiteFields(
  binding: PluginAuthBindingDefinition,
  configData: Record<string, unknown>
) {
  for (const fieldKey of binding.prerequisiteFields || []) {
    const value = configData[fieldKey]
    if (isMissingConfigValue(value)) {
      throw new PluginAuthError(
        400,
        `Field '${fieldKey}' is required before starting '${binding.key}'`
      )
    }
  }
}

function getTokenRequestContentType(binding: PluginAuthBindingDefinition) {
  const metadata = asObject(binding.metadata)
  return metadata.tokenRequestContentType === "application/json"
    ? "application/json"
    : "application/x-www-form-urlencoded"
}

function buildMijiaResultPreview(authState: object) {
  const state = authState as JsonObject
  const externalAccountId =
    asNullableString(state.cUserId) || asNullableString(state.userId)
  const displayName = asNullableString(state.userId) || externalAccountId

  return {
    externalAccountId: externalAccountId || undefined,
    displayName: displayName || undefined,
    locale: normalizeMijiaLocale(state.locale),
  }
}

function buildMijiaResultPayload(authState: object) {
  const state = authState as JsonObject
  // Mijia `expireTime` is an UNTRUSTED auth-state value documented as epoch
  // MILLISECONDS (set as `Date.now() + SESSION_LIFETIME_MS` in mijia/auth.ts).
  // Route through requireEpochMillis so a seconds-magnitude or otherwise corrupt
  // value fails loud (C2) rather than minting a 1970/year-55000 token expiry.
  const expiresAt =
    typeof state.expireTime === "number"
      ? presentInstant(new Date(requireEpochMillis(state.expireTime, "ms")))
      : null
  const preview = buildMijiaResultPreview(authState)

  return {
    externalAccountId: preview.externalAccountId || null,
    displayName: preview.displayName || null,
    avatarUrl: null,
    publicPayload: {
      locale: preview.locale,
      userId: asNullableString(state.userId),
      cUserId: asNullableString(state.cUserId),
    },
    secretPayload: {
      ...(encryptDeep(state) as JsonObject),
      expiresAt,
    },
  }
}

function buildFeishuResultPreview(input: {
  brand: "feishu" | "lark"
  tokenScope: string
  profile: JsonObject
  requestedFeatures: string[]
  appScopeStatus?: FeishuAppScopeInspection
}) {
  const externalAccountId =
    asNullableString(input.profile.open_id) ||
    asNullableString(input.profile.union_id) ||
    asNullableString(input.profile.user_id)
  const displayName =
    asNullableString(input.profile.name) ||
    asNullableString(input.profile.en_name) ||
    externalAccountId
  const avatarUrl = asNullableString(input.profile.avatar_url)
  const scopes = asStringArray(input.tokenScope)

  return {
    externalAccountId: externalAccountId || undefined,
    displayName: displayName || undefined,
    avatarUrl: avatarUrl || undefined,
    brand: input.brand,
    scopes,
    features: input.requestedFeatures,
    appScopeStatus: input.appScopeStatus,
  }
}

function buildFeishuResultPayload(input: {
  brand: "feishu" | "lark"
  appId: string
  appSecret: string
  tokenData: {
    accessToken: string
    refreshToken: string
    expiresIn: number
    refreshExpiresIn: number
    scope: string
    tokenType: string
  }
  profile: JsonObject
  requestedFeatures: string[]
  appScopeStatus?: FeishuAppScopeInspection
}) {
  const expiresAt = presentInstant(
    new Date(Date.now() + input.tokenData.expiresIn * 1000)
  )
  const refreshExpiresAt = presentInstant(
    new Date(Date.now() + input.tokenData.refreshExpiresIn * 1000)
  )
  const preview = buildFeishuResultPreview({
    brand: input.brand,
    tokenScope: input.tokenData.scope,
    profile: input.profile,
    requestedFeatures: input.requestedFeatures,
    appScopeStatus: input.appScopeStatus,
  })

  return {
    externalAccountId: preview.externalAccountId || null,
    displayName: preview.displayName || null,
    avatarUrl: preview.avatarUrl || null,
    publicPayload: {
      brand: input.brand,
      openBaseUrl: resolveFeishuOpenBaseUrl(input.brand),
      accountsBaseUrl: resolveFeishuAccountsBaseUrl(input.brand),
      scopes: preview.scopes,
      features: input.requestedFeatures,
      profile: input.profile,
      appScopeStatus: input.appScopeStatus,
    },
    secretPayload: {
      appId: encrypt(input.appId),
      appSecret: encrypt(input.appSecret),
      accessToken: encrypt(input.tokenData.accessToken),
      refreshToken: encrypt(input.tokenData.refreshToken),
      tokenType: input.tokenData.tokenType,
      expiresAt,
      refreshExpiresAt,
    },
  }
}

function buildFeishuScopeInspectionErrorMessage(input: {
  baseMessage: string
  inspection?: FeishuAppScopeInspection
}) {
  const inspection = input.inspection
  if (!inspection) {
    return input.baseMessage
  }

  if (
    inspection.status === "missing_app_scopes" &&
    inspection.missingScopes.length > 0
  ) {
    const featureSummary =
      inspection.missingFeatures.length > 0
        ? inspection.missingFeatures
            .map(
              (feature) =>
                `${feature.title} (${feature.missingScopes.join(", ")})`
            )
            .join("; ")
        : inspection.missingScopes.join(", ")
    return `${input.baseMessage} Missing app scopes: ${featureSummary}. Open the Feishu developer console and refresh app scopes after the review is approved.`
  }

  if (inspection.status === "unavailable" && inspection.queryError) {
    return `${input.baseMessage} ${inspection.queryError}`
  }

  return input.baseMessage
}

function getFeishuSessionAppCredentials(transientPayload: JsonObject) {
  const appCredentials = asObject(transientPayload.appCredentials)
  const appId = asString(appCredentials.appId)
  const appSecret = asString(appCredentials.appSecret)
  if (!appId || !appSecret) {
    return undefined
  }

  return {
    brand: asString(appCredentials.brand) === "lark" ? "lark" : "feishu",
    appId,
    appSecret,
  } as const
}

async function buildFeishuAppScopeInspection(input: {
  transientPayload: JsonObject
  resultPayload?: JsonObject
}) {
  const transientAppCredentials = getFeishuSessionAppCredentials(
    input.transientPayload
  )
  const decryptedResultSecret = asObject(
    decryptDeep(asObject(input.resultPayload?.secretPayload))
  )
  const resultPublicPayload = asObject(input.resultPayload?.publicPayload)
  const resultAppId = asString(decryptedResultSecret.appId)
  const resultAppSecret = asString(decryptedResultSecret.appSecret)
  const appCredentials =
    transientAppCredentials ||
    (resultAppId && resultAppSecret
      ? {
          brand:
            asString(resultPublicPayload.brand) === "lark" ? "lark" : "feishu",
          appId: resultAppId,
          appSecret: resultAppSecret,
        }
      : undefined)
  if (!appCredentials) {
    return undefined
  }

  const requestedFeatures = normalizeFeishuFeatureKeys(
    input.transientPayload.requestedFeatures || resultPublicPayload.features
  )
  if (requestedFeatures.length === 0) {
    return undefined
  }

  return inspectFeishuAppScopeStatus({
    brand: appCredentials.brand,
    openBaseUrl: asString(resultPublicPayload.openBaseUrl) || undefined,
    appId: appCredentials.appId,
    appSecret: appCredentials.appSecret,
    requestedFeatures,
    requestedScopes: asStringArray(input.transientPayload.requestedScopes),
  })
}

async function expirePluginAuthSession(sessionId: string) {
  return updatePluginAuthSession(sessionId, {
    status: PLUGIN_AUTH_SESSION_STATUS.EXPIRED,
    phase: null,
    errorCode: "AUTH_SESSION_EXPIRED",
    errorMessage: "Auth session expired",
  })
}

async function progressMijiaPluginAuthSession(row: PluginAuthSessionRow) {
  if (
    row.driver !== PLUGIN_AUTH_BINDING_DRIVER_KIND.MIJIA_QR_LOGIN ||
    row.status !== PLUGIN_AUTH_SESSION_STATUS.PENDING
  ) {
    return row
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return expirePluginAuthSession(row.id)
  }

  const transientPayload = asObject(decryptDeep(row.transientPayload))
  const mijiaPayload = asObject(transientPayload.mijia)

  try {
    const progress = await progressMijiaQrLoginSession({
      transientPayload: mijiaPayload,
      timeoutMs: 1_200,
    })

    switch (progress.status) {
      case PLUGIN_AUTH_SESSION_STATUS.PENDING: {
        if (!progress.phase || progress.phase === row.phase) {
          return row
        }

        const updated = await updatePluginAuthSession(row.id, {
          phase: progress.phase,
        })
        return updated
      }
      case PLUGIN_AUTH_SESSION_STATUS.COMPLETED: {
        const resultPayload = buildMijiaResultPayload(progress.authState)
        const updated = await updatePluginAuthSession(row.id, {
          status: PLUGIN_AUTH_SESSION_STATUS.COMPLETED,
          phase: null,
          resultPreview: buildMijiaResultPreview(
            progress.authState
          ) as PluginAuthSessionsResultPreview,
          resultPayload: resultPayload as PluginAuthSessionsResultPayload,
          errorCode: null,
          errorMessage: null,
        })
        return updated
      }
      case PLUGIN_AUTH_SESSION_STATUS.EXPIRED: {
        const expired = await updatePluginAuthSession(row.id, {
          status: PLUGIN_AUTH_SESSION_STATUS.EXPIRED,
          phase: null,
          errorCode: progress.errorCode,
          errorMessage: progress.errorMessage,
        })
        return expired
      }
      case PLUGIN_AUTH_SESSION_STATUS.FAILED: {
        const failed = await updatePluginAuthSession(row.id, {
          status: PLUGIN_AUTH_SESSION_STATUS.FAILED,
          phase: null,
          errorCode: progress.errorCode,
          errorMessage: progress.errorMessage,
        })
        return failed
      }
      default:
        return row
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete Mijia authorization."
    const failed = await updatePluginAuthSession(row.id, {
      status: PLUGIN_AUTH_SESSION_STATUS.FAILED,
      phase: null,
      errorCode: "MIJIA_AUTH_ERROR",
      errorMessage: message,
    })
    return failed
  }
}

async function progressFeishuPluginAuthSession(row: PluginAuthSessionRow) {
  if (
    row.driver !== PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP ||
    row.status !== PLUGIN_AUTH_SESSION_STATUS.PENDING
  ) {
    return row
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return expirePluginAuthSession(row.id)
  }

  const transientPayload = asObject(decryptDeep(row.transientPayload))

  try {
    const progress = await progressFeishuCliSetup(transientPayload as any)
    switch (progress.status) {
      case PLUGIN_AUTH_SESSION_STATUS.PENDING: {
        const nextTransient =
          progress.transientPayload || (transientPayload as any)
        const nextChallenge = progress.challengePayload || row.challengePayload
        const nextExpiresAt = progress.expiresAt || row.expiresAt

        const updated = await updatePluginAuthSession(row.id, {
          phase: PLUGIN_AUTH_SESSION_PHASE.PENDING_SCAN,
          challengePayload: nextChallenge as PluginAuthSessionsChallengePayload,
          transientPayload: encryptDeep(
            nextTransient
          ) as PluginAuthSessionsTransientPayload,
          expiresAt:
            typeof nextExpiresAt === "string"
              ? parseInstantString(nextExpiresAt)
              : nextExpiresAt,
        })
        return updated
      }
      case PLUGIN_AUTH_SESSION_STATUS.COMPLETED: {
        const appScopeStatus = await buildFeishuAppScopeInspection({
          transientPayload,
        })
        const resultPayload = buildFeishuResultPayload({
          brand: progress.appCredentials.brand,
          appId: progress.appCredentials.appId,
          appSecret: progress.appCredentials.appSecret,
          tokenData: progress.tokenData,
          profile: progress.profile,
          requestedFeatures: progress.requestedFeatures,
          appScopeStatus,
        })
        const resultPreview = buildFeishuResultPreview({
          brand: progress.appCredentials.brand,
          tokenScope: progress.tokenData.scope,
          profile: progress.profile,
          requestedFeatures: progress.requestedFeatures,
          appScopeStatus,
        })

        const updated = await updatePluginAuthSession(row.id, {
          status: PLUGIN_AUTH_SESSION_STATUS.COMPLETED,
          phase: null,
          resultPreview: resultPreview as PluginAuthSessionsResultPreview,
          resultPayload: resultPayload as PluginAuthSessionsResultPayload,
          errorCode: null,
          errorMessage: null,
        })
        return updated
      }
      case PLUGIN_AUTH_SESSION_STATUS.EXPIRED: {
        const expired = await updatePluginAuthSession(row.id, {
          status: PLUGIN_AUTH_SESSION_STATUS.EXPIRED,
          phase: null,
          errorCode: progress.errorCode,
          errorMessage: progress.errorMessage,
        })
        return expired
      }
      case PLUGIN_AUTH_SESSION_STATUS.FAILED: {
        const appScopeStatus = await buildFeishuAppScopeInspection({
          transientPayload,
        })
        const failed = await updatePluginAuthSession(row.id, {
          status: PLUGIN_AUTH_SESSION_STATUS.FAILED,
          phase: null,
          resultPreview: {
            features: normalizeFeishuFeatureKeys(
              transientPayload.requestedFeatures
            ),
            appScopeStatus,
          } as PluginAuthSessionsResultPreview,
          errorCode: progress.errorCode,
          errorMessage: buildFeishuScopeInspectionErrorMessage({
            baseMessage: progress.errorMessage,
            inspection: appScopeStatus,
          }),
        })
        return failed
      }
      default:
        return row
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete Feishu authorization."
    const failed = await updatePluginAuthSession(row.id, {
      status: PLUGIN_AUTH_SESSION_STATUS.FAILED,
      phase: null,
      errorCode: "FEISHU_AUTH_ERROR",
      errorMessage: message,
    })
    return failed
  }
}

async function exchangeAuthorizationCode(
  payload: OAuthTransientPayload,
  code: string
) {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: payload.redirectUri,
    client_id: payload.clientId,
    code_verifier: payload.codeVerifier,
  }

  if (payload.audience) {
    params.audience = payload.audience
  }
  for (const [key, value] of Object.entries(payload.extraTokenParams || {})) {
    params[key] = value
  }
  if (payload.clientSecret) {
    params.client_secret = payload.clientSecret
  }

  const body =
    payload.tokenRequestContentType === "application/json"
      ? JSON.stringify(params)
      : new URLSearchParams(params).toString()

  const response = await fetch(payload.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": payload.tokenRequestContentType,
      Accept: "application/json",
    },
    body,
  })

  const responseBody = await readProviderJsonObjectResponse(
    response,
    "OAuth token response"
  )
  if (!response.ok) {
    let message = "Token exchange failed"
    if (typeof responseBody.error_description === "string") {
      message = responseBody.error_description
    } else if (typeof responseBody.error === "string") {
      message = responseBody.error
    }
    throw new PluginAuthError(response.status || 400, message)
  }

  return responseBody
}

async function refreshOAuthConnection(
  binding: PluginAuthBindingDefinition,
  row: PluginConnectionRow,
  configData: Record<string, unknown>
) {
  const tokenUrl = asString(binding.tokenUrl)
  if (!tokenUrl) {
    throw new PluginAuthError(
      400,
      `Auth binding '${binding.key}' is missing tokenUrl`
    )
  }

  const storedSecretPayload = row.secretPayload
  const secretPayload = asObject(decryptDeep(storedSecretPayload))
  const refreshToken = asString(secretPayload.refreshToken)
  if (!refreshToken) {
    throw new PluginAuthError(400, "Auth connection has no refresh token")
  }

  const clientId = getBindingStringInput(binding, "clientId", configData)
  if (!clientId) {
    throw new PluginAuthError(
      400,
      `Auth binding '${binding.key}' is missing clientId`
    )
  }
  const clientSecret = getBindingStringInput(
    binding,
    "clientSecret",
    configData
  )

  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  }
  if (binding.audience) {
    params.audience = binding.audience
  }
  for (const [key, value] of Object.entries(binding.extraTokenParams || {})) {
    params[key] = value
  }
  if (clientSecret) {
    params.client_secret = clientSecret
  }

  const contentType = getTokenRequestContentType(binding)
  const body =
    contentType === "application/json"
      ? JSON.stringify(params)
      : new URLSearchParams(params).toString()

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body,
  })

  const tokenResponse = await readProviderJsonObjectResponse(
    response,
    "OAuth token refresh response"
  )
  if (!response.ok) {
    let message = "Token refresh failed"
    if (typeof tokenResponse.error_description === "string") {
      message = tokenResponse.error_description
    } else if (typeof tokenResponse.error === "string") {
      message = tokenResponse.error
    }
    throw new PluginAuthError(response.status || 400, message)
  }

  const accessToken = asString(tokenResponse.access_token)
  if (!accessToken) {
    throw new PluginAuthError(400, "Provider did not return an access token")
  }

  const expiresAt =
    typeof tokenResponse.expires_in === "number" &&
    Number.isFinite(tokenResponse.expires_in) &&
    tokenResponse.expires_in > 0
      ? presentInstant(new Date(Date.now() + tokenResponse.expires_in * 1000))
      : row.expiresAt

  const publicPayload = {
    ...row.publicPayload,
    ...(typeof tokenResponse.scope === "string"
      ? {
          scopes: tokenResponse.scope.split(/\s+/).filter(Boolean),
        }
      : {}),
  }

  const nextSecretPayload = {
    ...storedSecretPayload,
    accessToken: encrypt(accessToken),
    refreshToken:
      typeof tokenResponse.refresh_token === "string"
        ? encrypt(tokenResponse.refresh_token)
        : storedSecretPayload.refreshToken,
    tokenType:
      typeof tokenResponse.token_type === "string"
        ? tokenResponse.token_type
        : secretPayload.tokenType,
    expiresAt,
  }

  await updatePluginConnection(row.id, {
    publicPayload: publicPayload as PluginConnectionsPublicPayload,
    secretPayload: nextSecretPayload as PluginConnectionsSecretPayload,
    status: PLUGIN_AUTH_CONNECTION_STATUS.ACTIVE,
    expiresAt:
      typeof expiresAt === "string" ? parseInstantString(expiresAt) : expiresAt,
  })

  return getConnectionRow(row.id)
}

async function refreshFeishuConnection(row: PluginConnectionRow) {
  const storedSecretPayload = row.secretPayload
  const secretPayload = asObject(decryptDeep(storedSecretPayload))
  const publicPayload = row.publicPayload
  const brand = asString(publicPayload.brand) === "lark" ? "lark" : "feishu"
  const appId = asString(secretPayload.appId)
  const appSecret = asString(secretPayload.appSecret)
  const refreshToken = asString(secretPayload.refreshToken)

  if (!appId || !appSecret || !refreshToken) {
    throw new PluginAuthError(
      400,
      "Feishu auth connection is missing refresh credentials"
    )
  }

  const tokenResponse = await refreshFeishuUserAccessToken({
    brand,
    openBaseUrl: asString(publicPayload.openBaseUrl) || undefined,
    appId,
    appSecret,
    refreshToken,
  })

  const expiresAt = new Date(Date.now() + tokenResponse.expiresIn * 1000)
  const refreshExpiresAt = new Date(
    Date.now() + tokenResponse.refreshExpiresIn * 1000
  )
  const nextPublicPayload = {
    ...publicPayload,
    scopes: asStringArray(tokenResponse.scope),
  }
  const nextSecretPayload = {
    ...storedSecretPayload,
    accessToken: encrypt(tokenResponse.accessToken),
    refreshToken: encrypt(tokenResponse.refreshToken),
    tokenType: tokenResponse.tokenType,
    expiresAt: presentInstant(expiresAt),
    refreshExpiresAt: presentInstant(refreshExpiresAt),
  }

  await updatePluginConnection(row.id, {
    publicPayload: nextPublicPayload as PluginConnectionsPublicPayload,
    secretPayload: nextSecretPayload as PluginConnectionsSecretPayload,
    status: PLUGIN_AUTH_CONNECTION_STATUS.ACTIVE,
    expiresAt: expiresAt,
  })

  return getConnectionRow(row.id)
}

// Proactive resolve-time refresh for Mijia. The Mijia plugin proxies a
// stateless multi-tenant sidecar that has nowhere to persist a refreshed
// serviceToken, so the refresh must happen here (Synapse owns the encrypted
// connection store) before the credentials are forwarded. The decrypted
// secret_payload is the internal MijiaAuthState.
async function refreshMijiaConnection(row: PluginConnectionRow) {
  const secretPayload = asObject(decryptDeep(row.secretPayload))
  const nextState = await refreshMijiaSessionTokens(
    secretPayload as unknown as MijiaAuthState
  )
  await persistMijiaConnectionState(row.id, nextState)
  return getConnectionRow(row.id)
}

async function ensureFreshPluginConnection(row: PluginConnectionRow) {
  if (
    row.status !== PLUGIN_AUTH_CONNECTION_STATUS.ACTIVE ||
    !row.expiresAt ||
    row.expiresAt.getTime() > Date.now() + 60_000
  ) {
    return row
  }

  if (!row.catalogItemId) {
    throw new PluginAuthError(
      400,
      "Auth connection is missing its plugin binding"
    )
  }

  const installationRow = await getInstallationConfigRow(
    row.installationId,
    row.workspaceId
  )
  const configData = mergeConfigLayers(
    installationRow.defaultConfig,
    decryptSensitiveFields(installationRow.configData)
  )
  const spec = await getPluginAuthSpec(
    row.catalogItemId,
    row.catalogVersionId || installationRow.catalogVersionId
  )
  const binding = getBinding(spec.authBindings, row.bindingKey)

  try {
    switch (row.driver) {
      case PLUGIN_AUTH_BINDING_DRIVER_KIND.OAUTH2_AUTHORIZATION_CODE_PKCE:
        return await refreshOAuthConnection(binding, row, configData)
      case PLUGIN_AUTH_BINDING_DRIVER_KIND.MIJIA_QR_LOGIN:
        return await refreshMijiaConnection(row)
      case PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP:
        return await refreshFeishuConnection(row)
      default:
        throw new PluginAuthError(
          400,
          `Auth driver '${row.driver}' does not support token refresh`
        )
    }
  } catch {
    await updatePluginConnection(row.id, {
      status: PLUGIN_AUTH_CONNECTION_STATUS.EXPIRED,
    })
    // Reflect the just-persisted status on the in-memory row without spreading
    // the DB row outward (guard-layering r7); the caller reads named fields.
    const expiredRow: PluginConnectionRow = { ...row }
    expiredRow.status = PLUGIN_AUTH_CONNECTION_STATUS.EXPIRED
    return expiredRow
  }
}

export async function startPluginAuthSession(input: {
  workspaceId: string
  pluginId: string
  installationId?: string
  bindingKey: string
  workspaceMemberId: string
  draftConfig?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  let catalogVersionId: string | null | undefined
  if (input.installationId) {
    const installationRow = await getInstallationConfigRow(
      input.installationId,
      input.workspaceId
    )
    if (installationRow.catalogItemId !== input.pluginId) {
      throw new PluginAuthError(
        400,
        "Installation does not belong to this plugin"
      )
    }
    catalogVersionId = installationRow.catalogVersionId
  }

  const spec = await getPluginAuthSpec(input.pluginId, catalogVersionId || null)
  if (!spec.catalogVersionId) {
    throw new PluginAuthError(400, "Plugin has no active version")
  }

  const binding = getBinding(spec.authBindings, input.bindingKey)
  const draftConfig = await buildDraftConfig({
    workspaceId: input.workspaceId,
    pluginId: input.pluginId,
    defaultConfig: spec.defaultConfig,
    installationId: input.installationId,
    draftConfig: input.draftConfig,
  })
  validatePrerequisiteFields(binding, draftConfig)

  switch (binding.driver) {
    case PLUGIN_AUTH_BINDING_DRIVER_KIND.OAUTH2_AUTHORIZATION_CODE_PKCE: {
      const clientId = getBindingStringInput(binding, "clientId", draftConfig)
      if (!clientId) {
        throw new PluginAuthError(
          400,
          `Auth binding '${binding.key}' is missing clientId`
        )
      }
      const clientSecret = getBindingStringInput(
        binding,
        "clientSecret",
        draftConfig
      )
      const authorizeUrlValue = asString(binding.authorizeUrl)
      const tokenUrl = asString(binding.tokenUrl)
      if (!authorizeUrlValue || !tokenUrl) {
        throw new PluginAuthError(
          400,
          `Auth binding '${binding.key}' is missing authorizeUrl/tokenUrl`
        )
      }

      const { verifier, challenge } = createPkcePair()
      const state = base64Url(randomBytes(24))
      const redirectUri =
        getBindingStringInput(binding, "callbackUrl", draftConfig) ||
        defaultOauthCallbackUrl()
      const authorizeUrl = new URL(authorizeUrlValue)
      authorizeUrl.searchParams.set("response_type", "code")
      authorizeUrl.searchParams.set("client_id", clientId)
      authorizeUrl.searchParams.set("redirect_uri", redirectUri)
      authorizeUrl.searchParams.set("state", state)
      authorizeUrl.searchParams.set("code_challenge", challenge)
      authorizeUrl.searchParams.set("code_challenge_method", "S256")
      if ((binding.scopes || []).length > 0) {
        authorizeUrl.searchParams.set("scope", binding.scopes!.join(" "))
      }
      if (binding.audience) {
        authorizeUrl.searchParams.set("audience", binding.audience)
      }
      for (const [key, value] of Object.entries(
        binding.extraAuthorizeParams || {}
      )) {
        authorizeUrl.searchParams.set(key, value)
      }

      const transientPayload = {
        oauth: {
          codeVerifier: verifier,
          redirectUri,
          clientId,
          clientSecret: clientSecret ? encrypt(clientSecret) : undefined,
          tokenUrl,
          userInfoUrl: asString(binding.userInfoUrl) || undefined,
          tokenRequestContentType: getTokenRequestContentType(binding),
          audience: binding.audience,
          extraTokenParams: binding.extraTokenParams,
          profileIdPath: binding.profileIdPath,
          profileDisplayNamePath: binding.profileDisplayNamePath,
          profileAvatarUrlPath: binding.profileAvatarUrlPath,
        },
      }

      const inserted = await insertPluginAuthSession(
        {
          workspaceId: input.workspaceId,
          catalogItemId: spec.catalogItemId,
          catalogVersionId: spec.catalogVersionId,
          installationId: input.installationId || null,
          bindingKey: binding.key,
          driver: binding.driver,
          workspaceMemberId: input.workspaceMemberId,
          status: PLUGIN_AUTH_SESSION_STATUS.PENDING,
          phase: PLUGIN_AUTH_SESSION_PHASE.AWAITING_CALLBACK,
          state,
          challengePayload: {
            kind: PLUGIN_AUTH_CHALLENGE_KIND.REDIRECT,
            url: authorizeUrl.toString(),
            openMode: PLUGIN_AUTH_CHALLENGE_OPEN_MODE.POPUP,
          } as PluginAuthSessionsChallengePayload,
          transientPayload:
            transientPayload as PluginAuthSessionsTransientPayload,
          metadata: (input.metadata || {}) as PluginAuthSessionsMetadata,
        },
        { kind: "now_plus_1h" }
      )

      return {
        session: presentAuthSession(inserted),
      }
    }
    case PLUGIN_AUTH_BINDING_DRIVER_KIND.MIJIA_QR_LOGIN: {
      const result = await startMijiaQrLoginSession({
        locale: draftConfig.locale,
      })
      const inserted = await insertPluginAuthSession(
        {
          workspaceId: input.workspaceId,
          catalogItemId: spec.catalogItemId,
          catalogVersionId: spec.catalogVersionId,
          installationId: input.installationId || null,
          bindingKey: binding.key,
          driver: binding.driver,
          workspaceMemberId: input.workspaceMemberId,
          status: PLUGIN_AUTH_SESSION_STATUS.PENDING,
          phase: PLUGIN_AUTH_SESSION_PHASE.PENDING_SCAN,
          state: null,
          challengePayload:
            result.challengePayload as PluginAuthSessionsChallengePayload,
          transientPayload: encryptDeep(
            result.transientPayload
          ) as PluginAuthSessionsTransientPayload,
          metadata: (input.metadata || {}) as PluginAuthSessionsMetadata,
        },
        parseInstantString(result.expiresAt)
      )

      return {
        session: presentAuthSession(inserted),
      }
    }
    case PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP: {
      const selectedFeatures = normalizeFeishuFeatureKeys(draftConfig.features)
      const existingConnectionRef = asObject(draftConfig.feishuAccount)
      let existingAppCredentials:
        | {
            brand: "feishu" | "lark"
            appId: string
            appSecret: string
          }
        | undefined
      if (
        existingConnectionRef.__kind === "auth_connection_ref" &&
        typeof existingConnectionRef.connectionId === "string"
      ) {
        const connectionRow = await getConnectionRow(
          existingConnectionRef.connectionId,
          input.workspaceId
        )
        const publicPayload = connectionRow.publicPayload
        const secretPayload = asObject(decryptDeep(connectionRow.secretPayload))
        const appId = asString(secretPayload.appId)
        const appSecret = asString(secretPayload.appSecret)
        if (appId && appSecret) {
          existingAppCredentials = {
            brand: asString(publicPayload.brand) === "lark" ? "lark" : "feishu",
            appId,
            appSecret,
          }
        }
      }

      const result = await startFeishuCliSetup(
        selectedFeatures,
        existingAppCredentials
      )
      const inserted = await insertPluginAuthSession(
        {
          workspaceId: input.workspaceId,
          catalogItemId: spec.catalogItemId,
          catalogVersionId: spec.catalogVersionId,
          installationId: input.installationId || null,
          bindingKey: binding.key,
          driver: binding.driver,
          workspaceMemberId: input.workspaceMemberId,
          status: PLUGIN_AUTH_SESSION_STATUS.PENDING,
          phase: PLUGIN_AUTH_SESSION_PHASE.PENDING_SCAN,
          state: null,
          challengePayload:
            result.challengePayload as PluginAuthSessionsChallengePayload,
          transientPayload: encryptDeep(
            result.transientPayload
          ) as PluginAuthSessionsTransientPayload,
          metadata: (input.metadata || {}) as PluginAuthSessionsMetadata,
        },
        parseInstantString(result.expiresAt)
      )

      return {
        session: presentAuthSession(inserted),
      }
    }
    default:
      throw new PluginAuthError(
        400,
        `Auth driver '${binding.driver}' is not implemented yet`
      )
  }
}

export async function getPluginAuthSession(
  sessionId: string,
  workspaceId: string,
  workspaceMemberId: string
) {
  let row = await getSessionRow(sessionId, workspaceId, workspaceMemberId)
  if (
    row.driver === PLUGIN_AUTH_BINDING_DRIVER_KIND.MIJIA_QR_LOGIN &&
    row.status === PLUGIN_AUTH_SESSION_STATUS.PENDING
  ) {
    row = await progressMijiaPluginAuthSession(row)
  } else if (
    row.driver === PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP &&
    row.status === PLUGIN_AUTH_SESSION_STATUS.PENDING
  ) {
    row = await progressFeishuPluginAuthSession(row)
  } else if (
    row.status === PLUGIN_AUTH_SESSION_STATUS.PENDING &&
    row.expiresAt.getTime() <= Date.now()
  ) {
    row = await expirePluginAuthSession(row.id)
  }
  return presentAuthSession(row)
}

export async function inspectPluginAuthSession(input: {
  sessionId: string
  workspaceId: string
  workspaceMemberId: string
}) {
  const row = await getSessionRow(
    input.sessionId,
    input.workspaceId,
    input.workspaceMemberId
  )
  if (row.driver !== PLUGIN_AUTH_BINDING_DRIVER_KIND.FEISHU_CLI_SETUP) {
    throw new PluginAuthError(
      400,
      "Only Feishu auth sessions support app scope inspection."
    )
  }

  const transientPayload = asObject(decryptDeep(row.transientPayload))
  const resultPayload = row.resultPayload
  const inspection = await buildFeishuAppScopeInspection({
    transientPayload,
    resultPayload,
  })
  if (!inspection) {
    throw new PluginAuthError(
      400,
      "This Feishu auth session does not have app credentials yet. Finish the app creation step first."
    )
  }

  const previousPreview = row.resultPreview
  const nextPreview = {
    ...previousPreview,
    features:
      Array.isArray(previousPreview.features) &&
      previousPreview.features.length > 0
        ? previousPreview.features
        : normalizeFeishuFeatureKeys(transientPayload.requestedFeatures),
    appScopeStatus: inspection,
  }
  const updated = await updatePluginAuthSession(row.id, {
    resultPreview: nextPreview as PluginAuthSessionsResultPreview,
  })

  return {
    session: presentAuthSession(updated),
  }
}

export async function handlePluginAuthCallback(input: {
  state?: string
  code?: string
  error?: string
  errorDescription?: string
}) {
  if (!input.state) {
    throw new PluginAuthError(400, "Missing auth state")
  }

  const session = await getSessionRowByState(input.state)

  if (session.expiresAt.getTime() <= Date.now()) {
    await updatePluginAuthSessionNoReturn(session.id, {
      status: PLUGIN_AUTH_SESSION_STATUS.EXPIRED,
    })
    throw new PluginAuthError(410, "Auth session expired")
  }

  if (input.error) {
    const failed = await updatePluginAuthSession(session.id, {
      status: PLUGIN_AUTH_SESSION_STATUS.FAILED,
      phase: null,
      errorCode: input.error,
      errorMessage: input.errorDescription || input.error,
    })
    return presentAuthSession(failed)
  }

  switch (session.driver) {
    case PLUGIN_AUTH_BINDING_DRIVER_KIND.OAUTH2_AUTHORIZATION_CODE_PKCE: {
      if (!input.code) {
        throw new PluginAuthError(400, "Missing authorization code")
      }

      const transientPayload = asObject(decryptDeep(session.transientPayload))
      const oauth = asObject(transientPayload.oauth) as OAuthTransientPayload
      if (
        !oauth.tokenUrl ||
        !oauth.clientId ||
        !oauth.codeVerifier ||
        !oauth.redirectUri
      ) {
        throw new PluginAuthError(400, "Auth session is missing OAuth state")
      }

      const tokenResponse = await exchangeAuthorizationCode(oauth, input.code)
      const accessToken = asString(tokenResponse.access_token)
      if (!accessToken) {
        throw new PluginAuthError(
          400,
          "Provider did not return an access token"
        )
      }

      let profile: Record<string, unknown> = {}
      if (oauth.userInfoUrl) {
        const response = await fetch(oauth.userInfoUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        })
        if (!response.ok) {
          throw new PluginAuthError(
            response.status || 400,
            "Failed to fetch provider profile"
          )
        }
        profile = await readProviderJsonObjectResponse(
          response,
          "OAuth profile response"
        )
      }

      const externalAccountId =
        getByPath(profile, oauth.profileIdPath) ||
        tokenResponse.sub ||
        tokenResponse.user_id
      const displayName =
        getByPath(profile, oauth.profileDisplayNamePath) ||
        tokenResponse.name ||
        tokenResponse.preferred_username
      const avatarUrl = getByPath(profile, oauth.profileAvatarUrlPath)
      const scopes =
        typeof tokenResponse.scope === "string"
          ? tokenResponse.scope.split(/\s+/).filter(Boolean)
          : []
      const expiresAt =
        typeof tokenResponse.expires_in === "number" &&
        Number.isFinite(tokenResponse.expires_in) &&
        tokenResponse.expires_in > 0
          ? presentInstant(
              new Date(Date.now() + tokenResponse.expires_in * 1000)
            )
          : null

      const resultPreview = {
        externalAccountId: externalAccountId
          ? String(externalAccountId)
          : undefined,
        displayName: displayName ? String(displayName) : undefined,
        avatarUrl: avatarUrl ? String(avatarUrl) : undefined,
        scopes,
      }

      const resultPayload = {
        externalAccountId: externalAccountId ? String(externalAccountId) : null,
        displayName: displayName ? String(displayName) : null,
        avatarUrl: avatarUrl ? String(avatarUrl) : null,
        publicPayload: {
          scopes,
          profile,
        },
        secretPayload: {
          accessToken: encrypt(accessToken),
          refreshToken:
            typeof tokenResponse.refresh_token === "string"
              ? encrypt(tokenResponse.refresh_token)
              : null,
          tokenType:
            typeof tokenResponse.token_type === "string"
              ? tokenResponse.token_type
              : null,
          expiresAt,
        },
      }

      const updated = await updatePluginAuthSession(session.id, {
        status: PLUGIN_AUTH_SESSION_STATUS.COMPLETED,
        phase: null,
        resultPreview: resultPreview as PluginAuthSessionsResultPreview,
        resultPayload: resultPayload as PluginAuthSessionsResultPayload,
        errorCode: null,
        errorMessage: null,
      })

      return presentAuthSession(updated)
    }
    default:
      throw new PluginAuthError(
        400,
        `Auth driver '${session.driver}' cannot handle callbacks`
      )
  }
}

export async function getAuthConnection(
  connectionId: string,
  workspaceId: string
) {
  return presentAuthConnection(
    await getConnectionRow(connectionId, workspaceId)
  )
}

export async function attachAuthConnectionsToConfig(input: {
  installationId: string
  workspaceId: string
  workspaceMemberId: string
  configFields: PluginConfigFieldDefinition[]
  authBindings: PluginAuthBindingDefinition[]
  configData?: Record<string, unknown>
  authSessionIds?: Record<string, string>
  run?: PluginConnectionQueryRunner
}) {
  const run = input.run || defaultPluginConnectionRunner
  const result: Record<string, unknown> = { ...(input.configData || {}) }
  const authSessionIds = input.authSessionIds || {}
  const bindingMap = new Map(
    input.authBindings.map((binding) => [binding.key, binding])
  )
  const authFields = input.configFields.filter(
    (field) => field.type === PLUGIN_CONFIG_FIELD_TYPE.AUTH_CONNECTION
  )

  for (const field of authFields) {
    const sessionId = authSessionIds[field.key]
    if (!sessionId) continue

    const session = await getSessionRow(
      sessionId,
      input.workspaceId,
      input.workspaceMemberId
    )
    if (
      session.status !== PLUGIN_AUTH_SESSION_STATUS.COMPLETED &&
      session.status !== PLUGIN_AUTH_SESSION_STATUS.CONSUMED
    ) {
      throw new PluginAuthError(
        400,
        `Authorization for '${field.key}' is not completed`
      )
    }

    const metadata = session.metadata
    const bindingKey = session.bindingKey
    if (field.authBindingKey && bindingKey !== field.authBindingKey) {
      throw new PluginAuthError(
        400,
        `Authorization binding mismatch for '${field.key}'`
      )
    }

    let connection: PluginAuthConnection
    if (
      session.status === PLUGIN_AUTH_SESSION_STATUS.CONSUMED &&
      typeof metadata.consumedConnectionId === "string"
    ) {
      connection = await getAuthConnection(
        metadata.consumedConnectionId,
        input.workspaceId
      )
    } else {
      const normalizedPayload = session.resultPayload
      const publicPayload = asObject(normalizedPayload.publicPayload)
      const secretPayload = asObject(normalizedPayload.secretPayload)
      if (Object.keys(secretPayload).length === 0) {
        throw new PluginAuthError(
          400,
          `Authorization for '${field.key}' is missing connection payload`
        )
      }

      const binding = bindingMap.get(bindingKey)
      const externalAccountId = asNullableString(
        normalizedPayload.externalAccountId
      )
      const displayName = asNullableString(normalizedPayload.displayName)
      const avatarUrl = asNullableString(normalizedPayload.avatarUrl)
      const payloadExpiresAt = asNullableString(secretPayload.expiresAt)
      const connectionRow = await upsertPluginAuthConnectionFromSessionResult({
        run,
        installationId: input.installationId,
        workspaceId: input.workspaceId,
        bindingKey,
        driver: session.driver,
        externalAccountId,
        displayName,
        avatarUrl,
        expiresAt: payloadExpiresAt
          ? parseInstantString(payloadExpiresAt)
          : null,
        publicPayload,
        secretPayload,
        sessionId: session.id,
        sessionMetadata: metadata,
      })
      connection = presentAuthConnection(connectionRow)
    }

    result[field.key] = {
      __kind: "auth_connection_ref",
      connectionId: connection.id,
      bindingKey: connection.bindingKey,
      accountDisplayName: connection.displayName,
      externalAccountId: connection.externalAccountId,
      updatedAt: connection.updatedAt,
    }
  }

  return result
}

export async function resolveAuthConnectionRefs(
  config: Record<string, unknown>
) {
  const resolved: Record<string, unknown> = { ...config }
  for (const [key, value] of Object.entries(resolved)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const ref = value as Record<string, unknown>
    if (
      ref.__kind !== "auth_connection_ref" ||
      typeof ref.connectionId !== "string"
    ) {
      continue
    }

    const row = await ensureFreshPluginConnection(
      await getConnectionRow(ref.connectionId)
    )
    let secretPayload = asObject(decryptDeep(row.secretPayload))
    if (row.status !== PLUGIN_AUTH_CONNECTION_STATUS.ACTIVE) {
      // Fail-closed: never forward a non-active connection's secrets. Clear the
      // whole payload (not just OAuth's accessToken) so drivers like Mijia,
      // whose secret is the full session dict, can't leak a stale serviceToken.
      // The entryPoint template layer also gates ${auth:*}/${auth_b64:*} on an
      // active status; this is defense in depth.
      secretPayload = {}
    }
    resolved[key] = {
      type: PLUGIN_CONFIG_FIELD_TYPE.AUTH_CONNECTION,
      connectionId: row.id,
      bindingKey: row.bindingKey,
      driver: row.driver,
      externalAccountId: row.externalAccountId || undefined,
      displayName: row.displayName || undefined,
      avatarUrl: row.avatarUrl || undefined,
      status: row.status,
      expiresAt: row.expiresAt || undefined,
      publicPayload: row.publicPayload,
      secretPayload,
    }
  }
  return resolved
}
