// mcp-plugins/presenter.ts — DTO/wire-shaping helpers for the mcp-plugins
// module.
//
// presenter.ts is neither a service nor a controller, so it is the layer that
// is permitted to call serializeInstant / serializeOptionalInstant (see
// packages/api/scripts/guard-layering.mjs r3). service.ts shapes timestamps via
// the thin wrappers below instead of touching the infra serializers directly,
// and the auth row → DTO mappers live here (guard-layering r4) instead of in
// plugin-auth-connections.ts.
//
// This file MUST NOT import generated/db or use TableRow<…>; it takes row
// values structurally (the row aliases imported below resolve to TableRow but
// are pulled in via `import type`, so no generated/db import lands here).

import type {
  MarketplacePluginPublisherSummary,
  MarketplacePluginCategoryView,
  MarketplacePluginView,
  PluginAuthorizationView,
  PluginAuthConnection,
  PluginAuthSession,
  MarketplacePublisherView,
  PluginCategoryView,
  PluginConfigFieldState,
  PluginInstallationDetailView,
  WorkspaceAppGrant,
  PluginAuthBindingDefinition,
  PluginConfigFieldDefinition,
  PluginInstallFlow,
  PluginSpecTransport,
  McpSetupStep,
  McpValidationRule,
  PluginAuthChallengeKind,
  PluginAuthChallengeOpenMode,
  PluginReuseScopeV2,
  ReuseScope,
} from "@synapse/shared"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  PLUGIN_CONFIG_FIELD_TYPE,
  PLUGIN_AUTH_CHALLENGE_KINDS,
  PLUGIN_AUTH_CHALLENGE_OPEN_MODES,
  PLUGIN_INSTALLATION_STATUS,
  normalizeConversationTypeMask,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
  REUSE_SCOPES,
  WORKSPACE_APP_GRANT_PERMISSION,
} from "@synapse/shared"
import { assertIsoInstant } from "@synapse/shared/datetime"
import { isEncrypted } from "../../infrastructure/crypto/index.js"
import {
  serializeInstant,
  serializeOptionalInstant,
  type IsoInstantString,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"
import type {
  PluginAuthSessionRow,
  PluginConnectionRow,
} from "./plugin-auth-connections.js"
import {
  installationAccessRowToTarget,
  type InstallationAccessRow,
} from "./service.js"
import type { PluginCategoryRecord, PublisherRecord } from "./repo.types.js"
import type { InstallationRow, PluginCatalogRow } from "./repo.js"

/**
 * Present a stored installation-access row as a WorkspaceAppGrant View. Row→DTO
 * mapper + Date→ISO serializer, so it lives in the presenter (guard r3/r4). The
 * row decoder installationAccessRowToTarget + the row type stay in service.ts;
 * this imports them (same direction as skills/presenter ← service). round-6 P1-7.
 */
export function presentInstallationAccessGrant(
  mount: InstallationAccessRow,
  options?: {
    workspaceConversationTypeMask: number
    instanceConversationTypeMaskOverride: number | null
  }
): WorkspaceAppGrant {
  const effectiveConversationTypeMask = options
    ? resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          options.workspaceConversationTypeMask,
          options.instanceConversationTypeMaskOverride
        ),
        mount.conversation_type_mask_override
      )
    : undefined
  return {
    id: mount.id,
    workspaceAppId: mount.installation_id,
    workspaceId: mount.workspace_id,
    target: installationAccessRowToTarget(mount),
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
    status: mount.status,
    source: mount.source,
    grantedByWorkspaceMemberId:
      mount.created_by_workspace_member_id || undefined,
    reason: mount.reason || undefined,
    conversationTypeMaskOverride: mount.conversation_type_mask_override ?? null,
    effectiveConversationTypeMask,
    createdAt: serializeInstant(mount.created_at),
    revokedAt: serializeOptionalInstant(mount.revoked_at),
  }
}

/** Present a stored instant as an ISO timestamp for the wire DTO. */
export function presentInstant(value: Date): IsoInstantString {
  return serializeInstant(value)
}

/** Present a nullable stored instant as an optional ISO timestamp. */
export function presentOptionalInstant(
  value: Date | null | undefined
): IsoInstantString | undefined {
  return serializeOptionalInstant(value)
}

type JsonObject = Record<string, unknown>

export type PluginCatalogRecord = {
  id: string
  orgId: string
  slug: string
  displayName: string
  displayNameI18n: Record<string, string>
  description: string
  descriptionI18n: Record<string, string>
  longDescription: string
  longDescriptionI18n: Record<string, string>
  summaryI18n: Record<string, string>
  defaultLocale: string
  iconUrl: string | null
  version: string
  transport: PluginSpecTransport
  entryPoint: string
  lifecycleScope: ReuseScope
  defaultReuseScope: ReuseScope
  defaultConversationTypeMask: number
  supportedReuseScopes: ReuseScope[]
  configSchema: Record<string, unknown>
  configFields: PluginConfigFieldDefinition[]
  defaultConfig: Record<string, unknown>
  toolsManifest: unknown[]
  validationRules: McpValidationRule[]
  setupSteps: McpSetupStep[]
  installFlow: PluginInstallFlow
  authBindings: PluginAuthBindingDefinition[]
  authorization: PluginAuthorizationView
  tags: string[]
  categories: MarketplacePluginCategoryView[]
  categorySlugs: string[]
  isActive: boolean
  isBuiltin: boolean
  downloadCount: number
  createdAt: IsoInstantString
  updatedAt: IsoInstantString
  orgSlug: string
  orgDisplayName: string
  publisher: MarketplacePluginPublisherSummary
  requiresHandshake: boolean
  metadata: Record<string, unknown>
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as JsonObject
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value
  return fallback
}

function isReuseScope(value: unknown): value is ReuseScope {
  return typeof value === "string" && REUSE_SCOPES.includes(value as ReuseScope)
}

function normalizeSupportedReuseScopes(
  value: unknown,
  defaultScope: ReuseScope
): ReuseScope[] {
  const requested = asArray<unknown>(value).filter(isReuseScope)
  const enabledScopes = new Set<ReuseScope>(requested)
  if (enabledScopes.size === 0) {
    for (const scope of REUSE_SCOPES) {
      enabledScopes.add(scope)
    }
  }
  enabledScopes.add(defaultScope)
  return REUSE_SCOPES.filter((scope) => enabledScopes.has(scope))
}

function publicReuseScope(
  scope: PluginReuseScopeV2 | null | undefined
): ReuseScope {
  return scope || "conversation"
}

function authorizationFromRuntimePermissions(
  runtimePermissions: unknown,
  specMetadata: JsonObject
) {
  const rows = asArray<JsonObject>(runtimePermissions)
  const metadataAuthorization = asObject(specMetadata.authorization)

  return {
    requiredPermissions: rows
      .filter((row) => row.isRequired !== false)
      .map((row) => String(row.permissionKey || ""))
      .filter(Boolean),
    reason:
      typeof metadataAuthorization.reason === "string"
        ? metadataAuthorization.reason
        : undefined,
  }
}

export function presentPluginCatalogRecord(
  row: PluginCatalogRow
): PluginCatalogRecord {
  const itemMetadata = asObject(row.itemMetadata)
  const specMetadata = asObject(row.specMetadata)
  const defaultReuseScope = publicReuseScope(row.specDefaultReuseScope)
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: row.specDefaultConversationTypeMask,
    overrideMask: null,
  })
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    row.specSupportedReuseScopes,
    defaultReuseScope
  )
  const authorization = authorizationFromRuntimePermissions(
    row.runtimePermissionsJson,
    specMetadata
  )
  const configFields = asArray<PluginConfigFieldDefinition>(
    specMetadata.configFields
  )
  const validationRules = asArray<McpValidationRule>(
    specMetadata.validationRules
  )
  const setupSteps = asArray<McpSetupStep>(specMetadata.setupSteps)
  const installFlow = asObject(row.specInstallFlow)
  const categories: MarketplacePluginCategoryView[] = asArray<JsonObject>(
    row.categoriesJson
  ).map((category) => ({
    id: String(category.id || ""),
    slug: String(category.slug || ""),
    displayName: String(category.display_name || ""),
    description: String(category.description || ""),
    displayNameI18n: asObject(category.display_name_i18n) as Record<
      string,
      string
    >,
    descriptionI18n: asObject(category.description_i18n) as Record<
      string,
      string
    >,
    defaultLocale:
      typeof category.default_locale === "string"
        ? category.default_locale
        : "en",
  }))

  return {
    id: row.itemId,
    orgId: row.publisherId,
    slug: row.itemSlug,
    displayName: row.itemDisplayName,
    displayNameI18n: asObject(itemMetadata.displayNameI18n) as Record<
      string,
      string
    >,
    description: row.itemSummary,
    descriptionI18n: asObject(itemMetadata.descriptionI18n) as Record<
      string,
      string
    >,
    longDescription: row.itemLongDescription,
    longDescriptionI18n: asObject(itemMetadata.longDescriptionI18n) as Record<
      string,
      string
    >,
    summaryI18n: asObject(itemMetadata.summaryI18n) as Record<string, string>,
    defaultLocale:
      typeof itemMetadata.defaultLocale === "string"
        ? itemMetadata.defaultLocale
        : "en",
    iconUrl: row.itemIconFileId ? getFileUrlById(row.itemIconFileId) : null,
    version: row.versionValue || "1.0.0",
    transport: row.specTransport || "builtin",
    entryPoint: row.specEntryPoint || "",
    lifecycleScope: defaultReuseScope,
    defaultReuseScope,
    defaultConversationTypeMask,
    supportedReuseScopes,
    configSchema: asObject(row.specConfigSchema),
    configFields,
    defaultConfig: asObject(row.specDefaultConfig),
    toolsManifest: asArray(row.specToolManifest),
    validationRules,
    setupSteps,
    installFlow: (Object.keys(installFlow).length > 0
      ? installFlow
      : { steps: setupSteps }) as unknown as PluginInstallFlow,
    authBindings: asArray<PluginAuthBindingDefinition>(row.specAuthBindings),
    authorization,
    tags: row.itemTags || [],
    categories,
    categorySlugs: categories.map((category) => category.slug),
    isActive: row.itemIsActive,
    isBuiltin: row.itemSourceKind === "builtin" || row.publisherIsBuiltin,
    downloadCount: row.itemDownloadCount || 0,
    createdAt: serializeInstant(row.itemCreatedAt),
    updatedAt: serializeInstant(row.itemUpdatedAt),
    orgSlug: row.publisherSlug,
    orgDisplayName: row.publisherDisplayName,
    publisher: {
      id: row.publisherId,
      slug: row.publisherSlug,
      displayName: row.publisherDisplayName,
      description: row.publisherDescription,
      isVerified: row.publisherIsVerified,
    },
    requiresHandshake: parseBoolean(row.specRequiresHandshake),
    metadata: specMetadata,
  }
}

export type PluginInstallationDetailRecord = {
  row: InstallationRow
  plugin: PluginCatalogRecord
  workspaceConversationTypeMask: number
}

export function presentMarketplacePlugin(
  row: PluginCatalogRow
): MarketplacePluginView {
  return presentPluginCatalogRecord(row)
}

function isSecretConfigField(
  field: PluginConfigFieldDefinition | undefined,
  schemaProperties: Record<string, unknown>,
  key: string
) {
  const property = asObject(schemaProperties[key])
  return Boolean(
    field?.secret ||
    field?.type === PLUGIN_CONFIG_FIELD_TYPE.SECRET ||
    property.sensitive === true
  )
}

function sanitizeInstallationConfig(
  installation: { configData: Record<string, unknown>; updatedAt: Date },
  configSchema: Record<string, unknown>,
  configFields: PluginConfigFieldDefinition[],
  authBindings: PluginAuthBindingDefinition[]
) {
  const schemaProperties = asObject(configSchema.properties)
  const fieldMap = new Map(configFields.map((field) => [field.key, field]))
  const bindingMap = new Map(
    authBindings.map((binding) => [binding.key, binding])
  )
  const sanitizedConfig: Record<string, unknown> = {}
  const configState: PluginConfigFieldState[] = []

  for (const [key, value] of Object.entries(installation.configData)) {
    const field = fieldMap.get(key)

    if (
      field?.type === PLUGIN_CONFIG_FIELD_TYPE.AUTH_CONNECTION &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const ref = value as Record<string, unknown>
      configState.push({
        key,
        isConfigured: Boolean(ref.connectionId),
        authConnectionId:
          typeof ref.connectionId === "string" ? ref.connectionId : undefined,
        accountDisplayName:
          typeof ref.accountDisplayName === "string"
            ? ref.accountDisplayName
            : undefined,
        updatedAt:
          typeof ref.updatedAt === "string"
            ? assertIsoInstant(ref.updatedAt)
            : serializeInstant(installation.updatedAt),
      })
      sanitizedConfig[key] = {
        bindingKey:
          typeof ref.bindingKey === "string"
            ? ref.bindingKey
            : field.authBindingKey,
        accountDisplayName:
          typeof ref.accountDisplayName === "string"
            ? ref.accountDisplayName
            : undefined,
        connectionId:
          typeof ref.connectionId === "string" ? ref.connectionId : undefined,
      }
      continue
    }

    if (isSecretConfigField(field, schemaProperties, key)) {
      const masked =
        typeof value === "string"
          ? isEncrypted(value)
            ? "••••configured"
            : value.length > 4
              ? `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`
              : "••••"
          : undefined
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== "",
        maskedValue: masked,
        updatedAt: serializeInstant(installation.updatedAt),
      })
      continue
    }

    if (field?.serverManaged) {
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== "",
        updatedAt: serializeInstant(installation.updatedAt),
      })
      continue
    }

    sanitizedConfig[key] = value
  }

  for (const field of configFields) {
    if (
      configState.find((state) => state.key === field.key) ||
      (!field.secret &&
        field.type !== PLUGIN_CONFIG_FIELD_TYPE.AUTH_CONNECTION &&
        !field.serverManaged)
    ) {
      continue
    }

    const binding = field.authBindingKey
      ? bindingMap.get(field.authBindingKey)
      : undefined
    configState.push({
      key: field.key,
      isConfigured: false,
      accountDisplayName: binding
        ? Object.values(binding.displayNameI18n || {})[0]
        : undefined,
    })
  }

  return {
    sanitizedConfig,
    configState,
  }
}

export function presentPluginInstallationDetail(
  record: PluginInstallationDetailRecord
): PluginInstallationDetailView {
  const { row, plugin, workspaceConversationTypeMask } = record
  const sourceDefaultConversationTypeMask = normalizeConversationTypeMask(
    plugin.defaultConversationTypeMask,
    DEFAULT_CONVERSATION_TYPE_MASK
  )
  const effectiveConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    row.rootConversationTypeMaskOverride
  )
  const { sanitizedConfig, configState } = sanitizeInstallationConfig(
    {
      configData: row.configData,
      updatedAt: row.installationUpdatedAt,
    },
    plugin.configSchema || {},
    plugin.configFields || [],
    plugin.authBindings || []
  )

  return {
    id: row.installationId,
    workspaceId: row.rootWorkspaceId,
    pluginId: row.catalogItemId,
    lifecycleScope: publicReuseScope(row.reuseScope),
    defaultReuseScope: plugin.defaultReuseScope,
    sourceDefaultConversationTypeMask,
    workspaceConversationTypeMask,
    conversationTypeMaskOverride: row.rootConversationTypeMaskOverride ?? null,
    effectiveConversationTypeMask,
    supportedReuseScopes: plugin.supportedReuseScopes || [],
    isEnabled: row.rootStatus === PLUGIN_INSTALLATION_STATUS.ACTIVE,
    status: row.rootStatus,
    configData: sanitizedConfig,
    configState,
    approvedRuntimePermissions: row.approvedRuntimePermissions || [],
    ownerWorkspaceMemberId: row.rootOwnerWorkspaceMemberId,
    createdAt: serializeInstant(row.installationCreatedAt),
    updatedAt: serializeInstant(row.installationUpdatedAt),
    sourceCatalogItemId: row.sourceCatalogItemId,
    sourceCatalogVersionId: row.sourceCatalogVersionId,
    sourceSyncMode: row.sourceSyncMode,
    pluginSlug: plugin.slug,
    pluginDisplayName: plugin.displayName,
    pluginDescription: plugin.description,
    pluginDisplayNameI18n: plugin.displayNameI18n,
    pluginDescriptionI18n: plugin.descriptionI18n,
    pluginLongDescriptionI18n: plugin.longDescriptionI18n,
    pluginSummaryI18n: plugin.summaryI18n,
    defaultLocale: plugin.defaultLocale,
    transport: plugin.transport,
    pluginLifecycleScope: plugin.lifecycleScope,
    pluginDefaultReuseScope: plugin.defaultReuseScope,
    pluginSupportedReuseScopes: plugin.supportedReuseScopes || [],
    toolsManifest: plugin.toolsManifest,
    pluginIconUrl: plugin.iconUrl,
    pluginCategories: plugin.categories || [],
    pluginCategorySlugs: plugin.categorySlugs || [],
    pluginVersion: plugin.version,
    configSchema: plugin.configSchema,
    configFields: plugin.configFields,
    installFlow: plugin.installFlow,
    authBindings: plugin.authBindings,
    isBuiltin: plugin.isBuiltin,
    pluginValidationRules: plugin.validationRules,
    pluginSetupSteps: plugin.setupSteps,
    orgId: plugin.orgId,
    orgSlug: plugin.orgSlug,
    orgDisplayName: plugin.orgDisplayName,
    authorization: plugin.authorization,
    revision: {
      authorization: plugin.authorization,
    },
  }
}

function getAuthChallenge(
  row: PluginAuthSessionRow
): PluginAuthSession["challenge"] | undefined {
  const challenge = asObject(row.challengePayload)
  const kind = asString(challenge.kind)
  if (!kind) return undefined
  if (!PLUGIN_AUTH_CHALLENGE_KINDS.includes(kind as PluginAuthChallengeKind)) {
    return undefined
  }
  const openMode = asString(challenge.openMode)
  return {
    kind: kind as PluginAuthChallengeKind,
    url: asString(challenge.url) || undefined,
    qrUrl: asString(challenge.qrUrl) || undefined,
    openMode:
      openMode &&
      PLUGIN_AUTH_CHALLENGE_OPEN_MODES.includes(
        openMode as PluginAuthChallengeOpenMode
      )
        ? (openMode as PluginAuthChallengeOpenMode)
        : undefined,
    expiresAt: asString(challenge.expiresAt)
      ? assertIsoInstant(asString(challenge.expiresAt)!)
      : undefined,
    metadata: asObject(challenge.metadata),
  }
}

/** Shape a plugin connection row into the app-facing PluginAuthConnection DTO. */
export function presentAuthConnection(
  row: PluginConnectionRow
): PluginAuthConnection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    packageId: row.catalogItemId,
    bindingKey: row.bindingKey,
    driver: row.driver as PluginAuthConnection["driver"],
    externalAccountId: row.externalAccountId || undefined,
    displayName: row.displayName || undefined,
    avatarUrl: row.avatarUrl || undefined,
    status: row.status as PluginAuthConnection["status"],
    expiresAt: serializeOptionalInstant(row.expiresAt),
    publicPayload: asObject(row.publicPayload),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

/** Shape a plugin auth session row into the app-facing PluginAuthSession DTO. */
export function presentAuthSession(
  row: PluginAuthSessionRow
): PluginAuthSession {
  const metadata = asObject(row.metadata)
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    packageId: row.catalogItemId,
    revisionId: row.catalogVersionId || undefined,
    bindingKey: row.bindingKey,
    driver: row.driver as PluginAuthSession["driver"],
    workspaceMemberId: row.workspaceMemberId,
    status: row.status as PluginAuthSession["status"],
    phase: (row.phase as PluginAuthSession["phase"] | null) || undefined,
    state: row.state || undefined,
    challenge: getAuthChallenge(row),
    errorCode: row.errorCode || undefined,
    errorMessage: row.errorMessage || undefined,
    resultPreview: asObject(row.resultPreview),
    authConnectionId:
      typeof metadata.consumedConnectionId === "string"
        ? metadata.consumedConnectionId
        : undefined,
    metadata,
    expiresAt: serializeInstant(row.expiresAt),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

/** Shape a publisher record into the app-facing MarketplacePublisherView DTO. */
export function presentPublisher(
  row: PublisherRecord
): MarketplacePublisherView {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description || "",
    logoUrl: row.logoFileId ? getFileUrlById(row.logoFileId) : null,
    isBuiltin: Boolean(row.isBuiltin),
    isVerified: Boolean(row.isVerified),
    ownerUserId: row.ownerUserId,
    workspaceId: row.workspaceId,
    pluginCount:
      typeof row.pluginCount === "number"
        ? row.pluginCount
        : Number(row.pluginCount || 0),
    createdAt: serializeInstant(row.createdAt),
    updatedAt: serializeInstant(row.updatedAt),
  }
}

/** Shape a plugin-category record into the app-facing PluginCategoryView DTO. */
export function presentPluginCategory(
  row: PluginCategoryRecord
): PluginCategoryView {
  const metadata = asObject(row.metadata)
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description || "",
    displayNameI18n: asObject(metadata.displayNameI18n) as Record<
      string,
      string
    >,
    descriptionI18n: asObject(metadata.descriptionI18n) as Record<
      string,
      string
    >,
    defaultLocale:
      typeof metadata.defaultLocale === "string"
        ? metadata.defaultLocale
        : "en",
    sortOrder: row.sortOrder,
  }
}
