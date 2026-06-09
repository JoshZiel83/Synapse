import { createHash, randomBytes } from "crypto"
import type pg from "pg"
import type {
  PluginAuthBindingDefinition,
  PluginAuthConnection,
  PluginAuthSession,
  PluginAuthValueSource,
  PluginConfigFieldDefinition,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import { CompiledQuery, sql } from "kysely"
import { config } from "../../config/index.js"
import {
  PLUGIN_CONNECTION_LIVE_STATUSES,
  PLUGIN_INSTALLATION_LIVE_STATUSES,
} from "./live-status.js"
import {
  decrypt,
  decryptSensitiveFields,
  encrypt,
} from "../../infrastructure/crypto/index.js"
import { db, type TableInsert } from "../../infrastructure/database/kysely.js"
import {
  parseInstantString,
  serializeInstant,
  serializeOptionalInstant,
} from "../../infrastructure/datetime.js"
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

type JsonObject = Record<string, unknown>
type QueryRunner = <T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
) => Promise<{ rows: T[] }>

/** Default {@link QueryRunner} backed by the top-level Kysely db. */
const dbRunner: QueryRunner = <T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
) =>
  db
    .executeQuery<T>(CompiledQuery.raw(text, params ?? []))
    .then((r) => ({ rows: r.rows as T[] }))

type PluginAuthSessionRow = {
  id: string
  workspace_id: string
  catalog_item_id: string
  catalog_version_id: string | null
  installation_id: string | null
  binding_key: string
  driver: string
  workspace_member_id: string
  status: string
  phase: string | null
  state: string | null
  challenge_payload: unknown
  transient_payload: unknown
  error_code: string | null
  error_message: string | null
  result_preview: unknown
  result_payload: unknown
  metadata: unknown
  expires_at: Date
  created_at: Date
  updated_at: Date
}

type PluginConnectionRow = {
  id: string
  workspace_id: string
  installation_id: string
  catalog_item_id: string
  catalog_version_id?: string | null
  owner_scope: string
  owner_workspace_member_id: string | null
  binding_key: string
  driver: string
  external_account_id: string | null
  display_name: string | null
  avatar_url: string | null
  status: string
  expires_at: Date | null
  public_payload: unknown
  secret_payload: unknown
  created_at: Date
  updated_at: Date
}

type PluginAuthSpec = {
  catalogItemId: string
  catalogVersionId: string | null
  defaultConfig: Record<string, unknown>
  authBindings: PluginAuthBindingDefinition[]
}

type InstallationConfigRow = {
  catalog_item_id: string
  catalog_version_id: string
  config_data: unknown
  default_config: unknown
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

function asObject(value: unknown): JsonObject {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonObject
    } catch {
      return {}
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
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

function getAuthChallenge(
  row: PluginAuthSessionRow
): PluginAuthSession["challenge"] | undefined {
  const challenge = asObject(row.challenge_payload)
  const kind = asString(challenge.kind)
  if (!kind) return undefined
  if (kind !== "redirect" && kind !== "qr_code" && kind !== "none") {
    return undefined
  }
  return {
    kind: kind as NonNullable<PluginAuthSession["challenge"]>["kind"],
    url: asString(challenge.url) || undefined,
    qrUrl: asString(challenge.qrUrl) || undefined,
    openMode:
      challenge.openMode === "replace" || challenge.openMode === "popup"
        ? challenge.openMode
        : undefined,
    expiresAt: asString(challenge.expiresAt)
      ? assertIsoInstant(asString(challenge.expiresAt)!)
      : undefined,
    metadata: asObject(challenge.metadata),
  }
}

function mapConnectionRow(row: PluginConnectionRow): PluginAuthConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.catalog_item_id,
    bindingKey: row.binding_key,
    driver: row.driver as PluginAuthConnection["driver"],
    ownerScope: row.owner_scope as PluginAuthConnection["ownerScope"],
    ownerWorkspaceMemberId: row.owner_workspace_member_id || undefined,
    externalAccountId: row.external_account_id || undefined,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    status: row.status as PluginAuthConnection["status"],
    expiresAt: serializeOptionalInstant(row.expires_at),
    publicPayload: asObject(row.public_payload),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

function mapSessionRow(row: PluginAuthSessionRow): PluginAuthSession {
  const metadata = asObject(row.metadata)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.catalog_item_id,
    revisionId: row.catalog_version_id || undefined,
    bindingKey: row.binding_key,
    driver: row.driver as PluginAuthSession["driver"],
    workspaceMemberId: row.workspace_member_id,
    status: row.status as PluginAuthSession["status"],
    phase: (row.phase as PluginAuthSession["phase"] | null) || undefined,
    state: row.state || undefined,
    challenge: getAuthChallenge(row),
    errorCode: row.error_code || undefined,
    errorMessage: row.error_message || undefined,
    resultPreview: asObject(row.result_preview),
    authConnectionId:
      typeof metadata.consumedConnectionId === "string"
        ? metadata.consumedConnectionId
        : undefined,
    metadata,
    expiresAt: serializeInstant(row.expires_at),
    createdAt: serializeInstant(row.created_at),
    updatedAt: serializeInstant(row.updated_at),
  }
}

async function getPluginAuthSpec(
  pluginId: string,
  catalogVersionId?: string | null
): Promise<PluginAuthSpec> {
  const result = await db.executeQuery(
    sql<{
      catalog_item_id: string
      catalog_version_id: string | null
      default_config: unknown
      auth_bindings: unknown
    }>`SELECT
        item.id AS catalog_item_id,
        version.id AS catalog_version_id,
        spec.default_config,
        spec.auth_bindings
      FROM catalog_items item
      LEFT JOIN catalog_versions version
        ON version.id = COALESCE(${catalogVersionId || null}::uuid, item.latest_version_id)
      LEFT JOIN plugin_package_version_specs spec
        ON spec.catalog_version_id = version.id
      WHERE item.id = ${pluginId}
        AND item.item_kind = 'plugin_package'
      LIMIT 1`.compile(db)
  )

  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Plugin not found")
  }

  const row = result.rows[0]!
  return {
    catalogItemId: row.catalog_item_id,
    catalogVersionId: row.catalog_version_id,
    defaultConfig: asObject(row.default_config),
    authBindings: Array.isArray(row.auth_bindings)
      ? (row.auth_bindings as PluginAuthBindingDefinition[])
      : [],
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
  const row = await db
    .selectFrom("plugin_auth_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .where("workspace_id", "=", workspaceId)
    .where("workspace_member_id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new PluginAuthError(404, "Auth session not found")
  }
  return row as unknown as PluginAuthSessionRow
}

async function getSessionRowByState(state: string) {
  const row = await db
    .selectFrom("plugin_auth_sessions")
    .selectAll()
    .where("state", "=", state)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    throw new PluginAuthError(404, "Auth session not found")
  }
  return row as unknown as PluginAuthSessionRow
}

async function getConnectionRow(connectionId: string, workspaceId?: string) {
  let builder = db
    // Live predicate (review F5/F16): a connection resolves secrets only when both
    // it and its parent installation are live (deleted_at IS NULL AND status ∈
    // liveValues — excludes archived install / expired-revoked connection). Base
    // tables (not _live views) so NOT NULL column types survive.
    .selectFrom("plugin_connections as connection")
    .innerJoin(
      "plugin_installations as installation",
      "installation.id",
      "connection.installation_id"
    )
    .selectAll("connection")
    .select(["installation.catalog_item_id", "installation.catalog_version_id"])
    .where("connection.id", "=", connectionId)
    .where("connection.deleted_at", "is", null)
    .where("connection.status", "in", PLUGIN_CONNECTION_LIVE_STATUSES)
    .where("installation.deleted_at", "is", null)
    .where("installation.status", "in", PLUGIN_INSTALLATION_LIVE_STATUSES)

  if (workspaceId) {
    builder = builder.where("connection.workspace_id", "=", workspaceId)
  }

  const row = await builder.limit(1).executeTakeFirst()
  if (!row) {
    throw new PluginAuthError(404, "Auth connection not found")
  }
  return row as unknown as PluginConnectionRow
}

async function getInstallationConfigRow(
  installationId: string,
  workspaceId: string
): Promise<InstallationConfigRow> {
  const row = await db
    // Live predicate (review F16): exclude tombstoned + non-live-status installs.
    .selectFrom("plugin_installations as installation")
    .innerJoin(
      "plugin_package_version_specs as spec",
      "spec.catalog_version_id",
      "installation.catalog_version_id"
    )
    .select([
      "installation.catalog_item_id",
      "installation.catalog_version_id",
      "installation.config_data",
      "spec.default_config",
    ])
    .where("installation.id", "=", installationId)
    .where("installation.workspace_id", "=", workspaceId)
    .where("installation.deleted_at", "is", null)
    .where("installation.status", "in", PLUGIN_INSTALLATION_LIVE_STATUSES)
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    throw new PluginAuthError(404, "Installation not found")
  }

  return row as unknown as InstallationConfigRow
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
  if (row.catalog_item_id !== input.pluginId) {
    throw new PluginAuthError(
      400,
      "Installation does not belong to this plugin"
    )
  }

  return mergeConfigLayers(
    input.defaultConfig,
    decryptSensitiveFields(asObject(row.config_data)),
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
    case "config":
      return source.field ? configData[source.field] : undefined
    case "env":
      return source.env ? process.env[source.env] : undefined
    case "literal":
      return source.value
    case "derived":
      if (source.name === "app_base_url") {
        return config.app.baseUrl.replace(/\/$/, "")
      }
      if (source.name === "oauth_callback_url") {
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
  const expiresAt =
    typeof state.expireTime === "number"
      ? serializeInstant(new Date(state.expireTime))
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
  const expiresAt = serializeInstant(
    new Date(Date.now() + input.tokenData.expiresIn * 1000)
  )
  const refreshExpiresAt = serializeInstant(
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
  const expired = await db
    .updateTable("plugin_auth_sessions")
    .set({
      status: "expired",
      phase: null,
      error_code: "AUTH_SESSION_EXPIRED",
      error_message: "Auth session expired",
    })
    .where("id", "=", sessionId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return expired as unknown as PluginAuthSessionRow
}

async function progressMijiaPluginAuthSession(row: PluginAuthSessionRow) {
  if (row.driver !== "mijia_qr_login" || row.status !== "pending") {
    return row
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return expirePluginAuthSession(row.id)
  }

  const transientPayload = asObject(
    decryptDeep(asObject(row.transient_payload))
  )
  const mijiaPayload = asObject(transientPayload.mijia)

  try {
    const progress = await progressMijiaQrLoginSession({
      transientPayload: mijiaPayload,
      timeoutMs: 1_200,
    })

    switch (progress.status) {
      case "pending": {
        if (!progress.phase || progress.phase === row.phase) {
          return row
        }

        const updated = await db
          .updateTable("plugin_auth_sessions")
          .set({
            phase: progress.phase,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return updated as unknown as PluginAuthSessionRow
      }
      case "completed": {
        const resultPayload = buildMijiaResultPayload(progress.authState)
        const updated = await db
          .updateTable("plugin_auth_sessions")
          .set({
            status: "completed",
            phase: null,
            result_preview: buildMijiaResultPreview(
              progress.authState
            ) as TableInsert<"plugin_auth_sessions">["result_preview"],
            result_payload:
              resultPayload as TableInsert<"plugin_auth_sessions">["result_payload"],
            error_code: null,
            error_message: null,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return updated as unknown as PluginAuthSessionRow
      }
      case "expired": {
        const expired = await db
          .updateTable("plugin_auth_sessions")
          .set({
            status: "expired",
            phase: null,
            error_code: progress.errorCode,
            error_message: progress.errorMessage,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return expired as unknown as PluginAuthSessionRow
      }
      case "failed": {
        const failed = await db
          .updateTable("plugin_auth_sessions")
          .set({
            status: "failed",
            phase: null,
            error_code: progress.errorCode,
            error_message: progress.errorMessage,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return failed as unknown as PluginAuthSessionRow
      }
      default:
        return row
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete Mijia authorization."
    const failed = await db
      .updateTable("plugin_auth_sessions")
      .set({
        status: "failed",
        phase: null,
        error_code: "MIJIA_AUTH_ERROR",
        error_message: message,
      })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return failed as unknown as PluginAuthSessionRow
  }
}

async function progressFeishuPluginAuthSession(row: PluginAuthSessionRow) {
  if (row.driver !== "feishu_cli_setup" || row.status !== "pending") {
    return row
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return expirePluginAuthSession(row.id)
  }

  const transientPayload = asObject(
    decryptDeep(asObject(row.transient_payload))
  )

  try {
    const progress = await progressFeishuCliSetup(transientPayload as any)
    switch (progress.status) {
      case "pending": {
        const nextTransient =
          progress.transientPayload || (transientPayload as any)
        const nextChallenge =
          progress.challengePayload || asObject(row.challenge_payload)
        const nextExpiresAt = progress.expiresAt || row.expires_at

        const updated = await db
          .updateTable("plugin_auth_sessions")
          .set({
            phase: "pending_scan",
            challenge_payload:
              nextChallenge as TableInsert<"plugin_auth_sessions">["challenge_payload"],
            transient_payload: encryptDeep(
              nextTransient
            ) as TableInsert<"plugin_auth_sessions">["transient_payload"],
            expires_at:
              typeof nextExpiresAt === "string"
                ? parseInstantString(nextExpiresAt)
                : nextExpiresAt,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return updated as unknown as PluginAuthSessionRow
      }
      case "completed": {
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

        const updated = await db
          .updateTable("plugin_auth_sessions")
          .set({
            status: "completed",
            phase: null,
            result_preview:
              resultPreview as TableInsert<"plugin_auth_sessions">["result_preview"],
            result_payload:
              resultPayload as TableInsert<"plugin_auth_sessions">["result_payload"],
            error_code: null,
            error_message: null,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return updated as unknown as PluginAuthSessionRow
      }
      case "expired": {
        const expired = await db
          .updateTable("plugin_auth_sessions")
          .set({
            status: "expired",
            phase: null,
            error_code: progress.errorCode,
            error_message: progress.errorMessage,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return expired as unknown as PluginAuthSessionRow
      }
      case "failed": {
        const appScopeStatus = await buildFeishuAppScopeInspection({
          transientPayload,
        })
        const failed = await db
          .updateTable("plugin_auth_sessions")
          .set({
            status: "failed",
            phase: null,
            result_preview: {
              features: normalizeFeishuFeatureKeys(
                transientPayload.requestedFeatures
              ),
              appScopeStatus,
            } as TableInsert<"plugin_auth_sessions">["result_preview"],
            error_code: progress.errorCode,
            error_message: buildFeishuScopeInspectionErrorMessage({
              baseMessage: progress.errorMessage,
              inspection: appScopeStatus,
            }),
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        return failed as unknown as PluginAuthSessionRow
      }
      default:
        return row
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete Feishu authorization."
    const failed = await db
      .updateTable("plugin_auth_sessions")
      .set({
        status: "failed",
        phase: null,
        error_code: "FEISHU_AUTH_ERROR",
        error_message: message,
      })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return failed as unknown as PluginAuthSessionRow
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

  const responseBody = asObject(await response.json().catch(() => ({})))
  if (!response.ok) {
    throw new PluginAuthError(
      response.status || 400,
      typeof responseBody.error_description === "string"
        ? responseBody.error_description
        : typeof responseBody.error === "string"
          ? responseBody.error
          : "Token exchange failed"
    )
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

  const storedSecretPayload = asObject(row.secret_payload)
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

  const tokenResponse = asObject(await response.json().catch(() => ({})))
  if (!response.ok) {
    throw new PluginAuthError(
      response.status || 400,
      typeof tokenResponse.error_description === "string"
        ? tokenResponse.error_description
        : typeof tokenResponse.error === "string"
          ? tokenResponse.error
          : "Token refresh failed"
    )
  }

  const accessToken = asString(tokenResponse.access_token)
  if (!accessToken) {
    throw new PluginAuthError(400, "Provider did not return an access token")
  }

  const expiresAt =
    typeof tokenResponse.expires_in === "number"
      ? serializeInstant(new Date(Date.now() + tokenResponse.expires_in * 1000))
      : row.expires_at

  const publicPayload = {
    ...asObject(row.public_payload),
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

  await db
    .updateTable("plugin_connections")
    .set({
      public_payload:
        publicPayload as TableInsert<"plugin_connections">["public_payload"],
      secret_payload:
        nextSecretPayload as TableInsert<"plugin_connections">["secret_payload"],
      status: "active",
      expires_at:
        typeof expiresAt === "string"
          ? parseInstantString(expiresAt)
          : expiresAt,
    })
    .where("id", "=", row.id)
    .execute()

  return getConnectionRow(row.id)
}

async function refreshFeishuConnection(row: PluginConnectionRow) {
  const storedSecretPayload = asObject(row.secret_payload)
  const secretPayload = asObject(decryptDeep(storedSecretPayload))
  const publicPayload = asObject(row.public_payload)
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
    expiresAt: serializeInstant(expiresAt),
    refreshExpiresAt: serializeInstant(refreshExpiresAt),
  }

  await db
    .updateTable("plugin_connections")
    .set({
      public_payload:
        nextPublicPayload as TableInsert<"plugin_connections">["public_payload"],
      secret_payload:
        nextSecretPayload as TableInsert<"plugin_connections">["secret_payload"],
      status: "active",
      expires_at: expiresAt,
    })
    .where("id", "=", row.id)
    .execute()

  return getConnectionRow(row.id)
}

// Proactive resolve-time refresh for Mijia. The Mijia plugin proxies a
// stateless multi-tenant sidecar that has nowhere to persist a refreshed
// serviceToken, so the refresh must happen here (Synapse owns the encrypted
// connection store) before the credentials are forwarded. The decrypted
// secret_payload is the internal MijiaAuthState.
async function refreshMijiaConnection(row: PluginConnectionRow) {
  const secretPayload = asObject(decryptDeep(asObject(row.secret_payload)))
  const nextState = await refreshMijiaSessionTokens(
    secretPayload as unknown as MijiaAuthState
  )
  await persistMijiaConnectionState(row.id, nextState)
  return getConnectionRow(row.id)
}

async function ensureFreshPluginConnection(row: PluginConnectionRow) {
  if (
    row.status !== "active" ||
    !row.expires_at ||
    new Date(row.expires_at).getTime() > Date.now() + 60_000
  ) {
    return row
  }

  if (!row.catalog_item_id) {
    throw new PluginAuthError(
      400,
      "Auth connection is missing its plugin binding"
    )
  }

  const installationRow = await getInstallationConfigRow(
    row.installation_id,
    row.workspace_id
  )
  const configData = mergeConfigLayers(
    asObject(installationRow.default_config),
    decryptSensitiveFields(asObject(installationRow.config_data))
  )
  const spec = await getPluginAuthSpec(
    row.catalog_item_id,
    row.catalog_version_id || installationRow.catalog_version_id
  )
  const binding = getBinding(spec.authBindings, row.binding_key)

  try {
    switch (row.driver) {
      case "oauth2_authorization_code_pkce":
        return await refreshOAuthConnection(binding, row, configData)
      case "mijia_qr_login":
        return await refreshMijiaConnection(row)
      case "feishu_cli_setup":
        return await refreshFeishuConnection(row)
      default:
        throw new PluginAuthError(
          400,
          `Auth driver '${row.driver}' does not support token refresh`
        )
    }
  } catch {
    await db
      .updateTable("plugin_connections")
      .set({
        status: "expired",
      })
      .where("id", "=", row.id)
      .execute()
    return {
      ...row,
      status: "expired",
    }
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
    if (installationRow.catalog_item_id !== input.pluginId) {
      throw new PluginAuthError(
        400,
        "Installation does not belong to this plugin"
      )
    }
    catalogVersionId = installationRow.catalog_version_id
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
    case "oauth2_authorization_code_pkce": {
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

      const inserted = await db
        .insertInto("plugin_auth_sessions")
        .values({
          workspace_id: input.workspaceId,
          catalog_item_id: spec.catalogItemId,
          catalog_version_id: spec.catalogVersionId,
          installation_id: input.installationId || null,
          binding_key: binding.key,
          driver: binding.driver,
          workspace_member_id: input.workspaceMemberId,
          status: "pending",
          phase: "awaiting_callback",
          state,
          challenge_payload: {
            kind: "redirect",
            url: authorizeUrl.toString(),
            openMode: "popup",
          } as TableInsert<"plugin_auth_sessions">["challenge_payload"],
          transient_payload:
            transientPayload as TableInsert<"plugin_auth_sessions">["transient_payload"],
          metadata: (input.metadata ||
            {}) as TableInsert<"plugin_auth_sessions">["metadata"],
          expires_at: sql`NOW() + INTERVAL '1 hour'`,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return {
        session: mapSessionRow(inserted as unknown as PluginAuthSessionRow),
      }
    }
    case "mijia_qr_login": {
      const result = await startMijiaQrLoginSession({
        locale: draftConfig.locale,
      })
      const inserted = await db
        .insertInto("plugin_auth_sessions")
        .values({
          workspace_id: input.workspaceId,
          catalog_item_id: spec.catalogItemId,
          catalog_version_id: spec.catalogVersionId,
          installation_id: input.installationId || null,
          binding_key: binding.key,
          driver: binding.driver,
          workspace_member_id: input.workspaceMemberId,
          status: "pending",
          phase: "pending_scan",
          state: null,
          challenge_payload:
            result.challengePayload as TableInsert<"plugin_auth_sessions">["challenge_payload"],
          transient_payload: encryptDeep(
            result.transientPayload
          ) as TableInsert<"plugin_auth_sessions">["transient_payload"],
          metadata: (input.metadata ||
            {}) as TableInsert<"plugin_auth_sessions">["metadata"],
          expires_at: parseInstantString(result.expiresAt),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return {
        session: mapSessionRow(inserted as unknown as PluginAuthSessionRow),
      }
    }
    case "feishu_cli_setup": {
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
        const publicPayload = asObject(connectionRow.public_payload)
        const secretPayload = asObject(
          decryptDeep(asObject(connectionRow.secret_payload))
        )
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
      const inserted = await db
        .insertInto("plugin_auth_sessions")
        .values({
          workspace_id: input.workspaceId,
          catalog_item_id: spec.catalogItemId,
          catalog_version_id: spec.catalogVersionId,
          installation_id: input.installationId || null,
          binding_key: binding.key,
          driver: binding.driver,
          workspace_member_id: input.workspaceMemberId,
          status: "pending",
          phase: "pending_scan",
          state: null,
          challenge_payload:
            result.challengePayload as TableInsert<"plugin_auth_sessions">["challenge_payload"],
          transient_payload: encryptDeep(
            result.transientPayload
          ) as TableInsert<"plugin_auth_sessions">["transient_payload"],
          metadata: (input.metadata ||
            {}) as TableInsert<"plugin_auth_sessions">["metadata"],
          expires_at: parseInstantString(result.expiresAt),
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return {
        session: mapSessionRow(inserted as unknown as PluginAuthSessionRow),
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
  if (row.driver === "mijia_qr_login" && row.status === "pending") {
    row = await progressMijiaPluginAuthSession(row)
  } else if (row.driver === "feishu_cli_setup" && row.status === "pending") {
    row = await progressFeishuPluginAuthSession(row)
  } else if (
    row.status === "pending" &&
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    row = await expirePluginAuthSession(row.id)
  }
  return mapSessionRow(row)
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
  if (row.driver !== "feishu_cli_setup") {
    throw new PluginAuthError(
      400,
      "Only Feishu auth sessions support app scope inspection."
    )
  }

  const transientPayload = asObject(
    decryptDeep(asObject(row.transient_payload))
  )
  const resultPayload = asObject(row.result_payload)
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

  const previousPreview = asObject(row.result_preview)
  const nextPreview = {
    ...previousPreview,
    features:
      Array.isArray(previousPreview.features) &&
      previousPreview.features.length > 0
        ? previousPreview.features
        : normalizeFeishuFeatureKeys(transientPayload.requestedFeatures),
    appScopeStatus: inspection,
  }
  const updated = await db
    .updateTable("plugin_auth_sessions")
    .set({
      result_preview:
        nextPreview as TableInsert<"plugin_auth_sessions">["result_preview"],
    })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow()

  return {
    session: mapSessionRow(updated as unknown as PluginAuthSessionRow),
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

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await db
      .updateTable("plugin_auth_sessions")
      .set({
        status: "expired",
      })
      .where("id", "=", session.id)
      .execute()
    throw new PluginAuthError(410, "Auth session expired")
  }

  if (input.error) {
    const failed = await db
      .updateTable("plugin_auth_sessions")
      .set({
        status: "failed",
        phase: null,
        error_code: input.error,
        error_message: input.errorDescription || input.error,
      })
      .where("id", "=", session.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return mapSessionRow(failed as unknown as PluginAuthSessionRow)
  }

  switch (session.driver) {
    case "oauth2_authorization_code_pkce": {
      if (!input.code) {
        throw new PluginAuthError(400, "Missing authorization code")
      }

      const transientPayload = asObject(
        decryptDeep(asObject(session.transient_payload))
      )
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
        profile = asObject(await response.json().catch(() => ({})))
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
        typeof tokenResponse.expires_in === "number"
          ? serializeInstant(
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

      const updated = await db
        .updateTable("plugin_auth_sessions")
        .set({
          status: "completed",
          phase: null,
          result_preview:
            resultPreview as TableInsert<"plugin_auth_sessions">["result_preview"],
          result_payload:
            resultPayload as TableInsert<"plugin_auth_sessions">["result_payload"],
          error_code: null,
          error_message: null,
        })
        .where("id", "=", session.id)
        .returningAll()
        .executeTakeFirstOrThrow()

      return mapSessionRow(updated as unknown as PluginAuthSessionRow)
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
  return mapConnectionRow(await getConnectionRow(connectionId, workspaceId))
}

export async function attachAuthConnectionsToConfig(input: {
  installationId: string
  workspaceId: string
  workspaceMemberId: string
  configFields: PluginConfigFieldDefinition[]
  authBindings: PluginAuthBindingDefinition[]
  configData?: Record<string, unknown>
  authSessionIds?: Record<string, string>
  run?: QueryRunner
}) {
  const run = input.run || dbRunner
  const result: Record<string, unknown> = { ...(input.configData || {}) }
  const authSessionIds = input.authSessionIds || {}
  const bindingMap = new Map(
    input.authBindings.map((binding) => [binding.key, binding])
  )
  const authFields = input.configFields.filter(
    (field) => field.type === "auth_connection"
  )

  for (const field of authFields) {
    const sessionId = authSessionIds[field.key]
    if (!sessionId) continue

    const session = await getSessionRow(
      sessionId,
      input.workspaceId,
      input.workspaceMemberId
    )
    if (!["completed", "consumed"].includes(session.status)) {
      throw new PluginAuthError(
        400,
        `Authorization for '${field.key}' is not completed`
      )
    }

    const metadata = asObject(session.metadata)
    const bindingKey = session.binding_key
    if (field.authBindingKey && bindingKey !== field.authBindingKey) {
      throw new PluginAuthError(
        400,
        `Authorization binding mismatch for '${field.key}'`
      )
    }

    let connection: PluginAuthConnection
    if (
      session.status === "consumed" &&
      typeof metadata.consumedConnectionId === "string"
    ) {
      connection = await getAuthConnection(
        metadata.consumedConnectionId,
        input.workspaceId
      )
    } else {
      const normalizedPayload = asObject(session.result_payload)
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
      const existing = await run<PluginConnectionRow>(
        `SELECT
           connection.*,
           installation.catalog_item_id,
           installation.catalog_version_id
         FROM plugin_connections connection
         JOIN plugin_installations installation
           ON installation.id = connection.installation_id
         WHERE connection.installation_id = $1
           AND connection.workspace_id = $2
           AND connection.binding_key = $3
           AND connection.external_account_id IS NOT DISTINCT FROM $4
           AND connection.deleted_at IS NULL
         ORDER BY connection.updated_at DESC
         LIMIT 1`,
        [input.installationId, input.workspaceId, bindingKey, externalAccountId]
      )

      let connectionRow: PluginConnectionRow
      if (existing.rows.length > 0) {
        const updated = await run<PluginConnectionRow>(
          `UPDATE plugin_connections
           SET owner_scope = $2,
               owner_workspace_member_id = $3,
               display_name = $4,
               avatar_url = $5,
               status = 'active',
               expires_at = $6,
               public_payload = $7::jsonb,
               secret_payload = $8::jsonb,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *,
             (
               SELECT catalog_item_id
               FROM plugin_installations
               WHERE id = plugin_connections.installation_id
             ) AS catalog_item_id`,
          [
            existing.rows[0]!.id,
            binding?.ownerScope || "installation",
            input.workspaceMemberId || null,
            displayName,
            avatarUrl,
            asNullableString(secretPayload.expiresAt),
            JSON.stringify(publicPayload),
            JSON.stringify(secretPayload),
          ]
        )
        connectionRow = updated.rows[0]!
      } else {
        const inserted = await run<PluginConnectionRow>(
          `INSERT INTO plugin_connections (
             installation_id,
             workspace_id,
             owner_scope,
             owner_workspace_member_id,
             binding_key,
             driver,
             external_account_id,
             display_name,
             avatar_url,
             status,
             expires_at,
             public_payload,
             secret_payload
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11::jsonb, $12::jsonb
           )
           RETURNING *,
             (
               SELECT catalog_item_id
               FROM plugin_installations
               WHERE id = plugin_connections.installation_id
             ) AS catalog_item_id`,
          [
            input.installationId,
            input.workspaceId,
            binding?.ownerScope || "installation",
            input.workspaceMemberId || null,
            bindingKey,
            session.driver,
            externalAccountId,
            displayName,
            avatarUrl,
            asNullableString(secretPayload.expiresAt),
            JSON.stringify(publicPayload),
            JSON.stringify(secretPayload),
          ]
        )
        connectionRow = inserted.rows[0]!
      }

      connection = mapConnectionRow(connectionRow)

      await run(
        `UPDATE plugin_auth_sessions
         SET status = 'consumed',
             metadata = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          session.id,
          JSON.stringify({
            ...metadata,
            consumedConnectionId: connection.id,
          }),
        ]
      )
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
    let secretPayload = asObject(decryptDeep(asObject(row.secret_payload)))
    if (row.status !== "active") {
      // Fail-closed: never forward a non-active connection's secrets. Clear the
      // whole payload (not just OAuth's accessToken) so drivers like Mijia,
      // whose secret is the full session dict, can't leak a stale serviceToken.
      // The entryPoint template layer also gates ${auth:*}/${auth_b64:*} on an
      // active status; this is defense in depth.
      secretPayload = {}
    }
    resolved[key] = {
      type: "auth_connection",
      connectionId: row.id,
      bindingKey: row.binding_key,
      driver: row.driver,
      externalAccountId: row.external_account_id || undefined,
      displayName: row.display_name || undefined,
      avatarUrl: row.avatar_url || undefined,
      status: row.status,
      expiresAt: row.expires_at || undefined,
      publicPayload: asObject(row.public_payload),
      secretPayload,
    }
  }
  return resolved
}
