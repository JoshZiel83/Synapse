import crypto from "node:crypto"
import fs from "node:fs/promises"
import type pg from "pg"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  FILE_ORIGIN_SYSTEMS,
  WORKSPACE_APP_GRANT_PERMISSION,
  actorRef,
  conversationRef,
  normalizeConversationTypeMask,
  parseJsonObject,
  REUSE_SCOPES,
  remoteAgentRef,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
  slugify,
  subjectScopeLabel,
  workspaceMemberRef,
  workspaceRef,
  type WorkspaceAppGrantPermission,
} from "@synapse/shared"
import { assertIsoInstant, nowIsoInstant } from "@synapse/shared/datetime"
import type {
  CapabilityAccessTarget,
  WorkspaceAppGrant,
} from "@synapse/shared/types"
import type {
  PluginAuthBindingDefinition,
  PluginConfigFieldDefinition,
  PluginConfigFieldState,
  PluginInstallFlow,
  PluginSpecTransport,
  ReuseScope,
  McpSetupStep,
  McpValidationRule,
  PluginReuseScopeV2,
  RuntimeBindingScope,
  MarketplacePluginView,
  MarketplacePluginCategoryView,
  PluginInstallationDetailView,
} from "@synapse/shared"
import { CompiledQuery, sql, type RawBuilder, type SqlBool } from "kysely"
import {
  encryptSensitiveFields,
  isEncrypted,
} from "../../infrastructure/crypto/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { getWorkspaceCapabilityConversationTypeMask } from "../capabilities/conversation-type-policies.js"
import {
  db,
  runBuilder,
  takeFirstOn,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { presentInstant, presentOptionalInstant } from "./presenter.js"
import type {
  CatalogCategoriesMetadata,
  PluginCategoryRecord,
  PluginInstallationsConfigData,
  PluginPackageVersionSpecsTransport,
  PublisherRecord,
} from "./repo.types.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { saveFromBuffer } from "../../infrastructure/storage/file-io.js"
import { buildPlatformAssetOrigin, getFileUrlById } from "../files/service.js"
import { attachAuthConnectionsToConfig } from "./plugin-auth-connections.js"
import { incrementMcpVersion } from "./runtime-version.js"
import { PLUGIN_CONNECTION_LIVE_STATUSES } from "./live-status.js"
import { builtinCapabilityCategories } from "./builtin-plugins/categories.js"
import { builtinSeeds } from "./builtin-plugins/index.js"
import {
  assertFeishuFeatureSelection,
  assertFeishuScopesForFeatures,
  normalizeFeishuFeatureKeys,
} from "./feishu/features.js"
import {} from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/root-storage.js"
import {
  insertWorkspaceAppGrant,
  revokeWorkspaceAppGrant,
  revokeWorkspaceAppGrantsForApp,
} from "../workspace-apps/grant-storage.js"
import {} from "../access/binding-storage.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
  validateConversationScopedAccessTarget,
} from "../access/policy.js"

type QueryRow = pg.QueryResultRow
type QueryResultLike<T extends QueryRow> = { rows: T[] }
type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResultLike<T>>

/**
 * Build a {@link QueryRunner} backed by an {@link Executor} (db/trx).
 *
 * CamelCasePlugin already camelCases the top-level keys of every result row
 * (including these raw `connection.*` / `RETURNING *` rows), and the only
 * consumer — {@link attachAuthConnectionsToConfig} — reads its rows as the
 * camelCase `PluginConnectionRow` (the `pluginConnections` selectable) and shapes
 * them via `presentAuthConnection`, which reads camelCase fields. So the
 * executor's rows pass straight through with no key transform, matching the
 * default `dbRunner` in plugin-auth-connections.ts.
 */
function runnerFn(executor: Executor): QueryRunner {
  return <T extends QueryRow>(text: string, params?: unknown[]) =>
    executor.executeQuery<T>(
      CompiledQuery.raw(text, params ? [...params] : [])
    ) as Promise<QueryResultLike<T>>
}

type JsonObject = Record<string, unknown>
type JsonArray = unknown[]

type PluginCatalogRow = {
  itemId: string
  itemWorkspaceId: string | null
  itemSlug: string
  itemDisplayName: string
  itemSummary: string
  itemLongDescription: string
  itemSourceKind: "builtin" | "official" | "workspace" | "user"
  itemVisibility: "public" | "workspace" | "private"
  itemTags: string[] | null
  itemIsActive: boolean
  itemDownloadCount: number
  itemIconFileId: string | null
  itemMetadata: unknown
  itemCreatedAt: Date
  itemUpdatedAt: Date
  versionId: string | null
  versionValue: string | null
  versionStatus: "draft" | "active" | "deprecated" | "archived" | null
  versionChangelog: string | null
  versionMetadata: unknown
  versionCreatedByUserId: string | null
  versionCreatedAt: Date | null
  specTransport: PluginSpecTransport | null
  specEntryPoint: string | null
  specToolManifest: unknown
  specConfigSchema: unknown
  specDefaultConfig: unknown
  specInstallFlow: unknown
  specAuthBindings: unknown
  specDefaultReuseScope: PluginReuseScopeV2 | null
  specDefaultConversationTypeMask: number | null
  specSupportedReuseScopes: unknown
  specRequiresHandshake: boolean | null
  specMetadata: unknown
  publisherId: string
  publisherSlug: string
  publisherDisplayName: string
  publisherDescription: string
  publisherWorkspaceId: string | null
  publisherIsBuiltin: boolean
  publisherIsVerified: boolean
  publisherOwnerUserId: string | null
  publisherLogoFileId: string | null
  categoriesJson: unknown
  runtimePermissionsJson: unknown
}

type InstallationRow = {
  installationId: string
  rootWorkspaceId: string
  catalogItemId: string
  catalogVersionId: string
  rootDisplayName: string
  configData: unknown
  approvedRuntimePermissions: string[] | null
  reuseScope: PluginReuseScopeV2
  rootConversationTypeMaskOverride: number | null
  rootStatus: "active" | "disabled" | "error" | "archived"
  rootOwnerWorkspaceMemberId: string | null
  installationCreatedAt: Date
  installationUpdatedAt: Date
  sourceCatalogItemId: string | null
  sourceCatalogVersionId: string | null
  sourceSyncMode:
    | "notify"
    | "manual_merge"
    | "follow_upstream"
    | "detached"
    | null
}

type InstallationAccessRow = {
  id: string
  workspace_id: string
  installation_id: string
  access_target_type: RuntimeBindingScope
  conversation_id: string | null
  actor_id: string | null
  // Round 9 review (P2): include remote_agent_id so dedup discriminates
  // remote_agent targets from workspace/actor.
  remote_agent_id: string | null
  workspace_member_id: string | null
  conversation_type_mask_override: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  created_by_workspace_member_id: string | null
  reason: string | null
  created_at: Date
  revoked_at: Date | null
}

const PLUGIN_CATALOG_SELECT = `
  SELECT
    item.id AS "itemId",
    item.workspace_id AS "itemWorkspaceId",
    item.slug AS "itemSlug",
    item.display_name AS "itemDisplayName",
    item.summary AS "itemSummary",
    item.long_description AS "itemLongDescription",
    item.source_kind AS "itemSourceKind",
    item.visibility AS "itemVisibility",
    item.tags AS "itemTags",
    item.is_active AS "itemIsActive",
    item.download_count AS "itemDownloadCount",
    item.icon_file_id AS "itemIconFileId",
    item.metadata AS "itemMetadata",
    item.created_at AS "itemCreatedAt",
    item.updated_at AS "itemUpdatedAt",
    version.id AS "versionId",
    version.version AS "versionValue",
    version.status AS "versionStatus",
    version.changelog AS "versionChangelog",
    version.metadata AS "versionMetadata",
    version.created_by_user_id AS "versionCreatedByUserId",
    version.created_at AS "versionCreatedAt",
    spec.transport AS "specTransport",
    spec.entry_point AS "specEntryPoint",
    spec.tool_manifest AS "specToolManifest",
    spec.config_schema AS "specConfigSchema",
    spec.default_config AS "specDefaultConfig",
    spec.install_flow AS "specInstallFlow",
    spec.auth_bindings AS "specAuthBindings",
    spec.default_reuse_scope AS "specDefaultReuseScope",
    spec.default_conversation_type_mask AS "specDefaultConversationTypeMask",
    spec.supported_reuse_scopes AS "specSupportedReuseScopes",
    spec.requires_handshake AS "specRequiresHandshake",
    spec.metadata AS "specMetadata",
    publisher.id AS "publisherId",
    publisher.slug AS "publisherSlug",
    publisher.display_name AS "publisherDisplayName",
    publisher.description AS "publisherDescription",
    publisher.workspace_id AS "publisherWorkspaceId",
    publisher.is_builtin AS "publisherIsBuiltin",
    publisher.is_verified AS "publisherIsVerified",
    publisher.owner_user_id AS "publisherOwnerUserId",
    publisher.logo_file_id AS "publisherLogoFileId",
    COALESCE(categories.categories_json, '[]'::jsonb) AS "categoriesJson",
    COALESCE(runtime_permissions.runtime_permissions_json, '[]'::jsonb) AS "runtimePermissionsJson"
  FROM catalog_items item
  JOIN publishers publisher
    ON publisher.id = item.publisher_id
  JOIN catalog_versions version
    ON version.catalog_item_id = item.id
  LEFT JOIN plugin_package_version_specs spec
    ON spec.catalog_version_id = version.id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', category.id,
        'slug', category.slug,
        'display_name', category.display_name,
        'description', category.description,
        'display_name_i18n', COALESCE(category.metadata->'displayNameI18n', '{}'::jsonb),
        'description_i18n', COALESCE(category.metadata->'descriptionI18n', '{}'::jsonb),
        'default_locale', COALESCE(category.metadata->>'defaultLocale', 'en')
      )
      ORDER BY category.sort_order ASC, category.display_name ASC
    ) AS categories_json
    FROM catalog_item_categories item_category
    JOIN catalog_categories category
      ON category.id = item_category.category_id
    WHERE item_category.catalog_item_id = item.id
      AND category.item_kind = 'plugin_package'
  ) categories ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'permissionKey', permission_key,
        'isRequired', is_required,
        'rationale', rationale
      )
      ORDER BY permission_key ASC
    ) AS runtime_permissions_json
    FROM plugin_version_runtime_permissions permission_row
    WHERE permission_row.catalog_version_id = version.id
  ) runtime_permissions ON TRUE
  WHERE item.item_kind = 'plugin_package'
`

export class McpPluginError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

const log = createLogger("mcp.service")

function sanitizeSlug(value: string) {
  return slugify(value, { maxLength: 120 })
}

// Business JSON decode → shared parseJsonObject (object-only, array-reject). r6 P1-8.
const asObject = parseJsonObject

function asArray<T>(value: unknown): T[] {
  if (!value) return []
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[]
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? (value as T[]) : []
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  )
}

function isConfigValueMissing(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  )
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

function assertSupportedReuseScope(
  supportedScopes: readonly ReuseScope[],
  lifecycleScope: ReuseScope,
  pluginLabel: string
) {
  if (!supportedScopes.includes(lifecycleScope)) {
    throw new McpPluginError(
      400,
      `Reuse scope '${lifecycleScope}' is not supported by plugin '${pluginLabel}'`
    )
  }
}

function publicReuseScope(
  scope: PluginReuseScopeV2 | null | undefined
): ReuseScope {
  return scope || "conversation"
}

function internalReuseScope(scope: ReuseScope): PluginReuseScopeV2 {
  return scope
}

function inferMimeTypeForAsset(assetPath: string) {
  const lower = assetPath.toLowerCase()
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".webp")) return "image/webp"
  return "application/octet-stream"
}

let builtinPluginIconFilesTableAvailable: boolean | null = null

async function hasBuiltinPluginFilesTable() {
  if (builtinPluginIconFilesTableAvailable !== null) {
    return builtinPluginIconFilesTableAvailable
  }

  const result = await db.executeQuery(
    sql<{ exists: boolean }>`SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'files'
    ) AS exists`.compile(db)
  )

  builtinPluginIconFilesTableAvailable = result.rows[0]?.exists === true
  return builtinPluginIconFilesTableAvailable
}

async function ensureBuiltinPluginIcon(
  seedSlug: string,
  pluginSlug: string,
  relativeAssetPath: string
) {
  if (!(await hasBuiltinPluginFilesTable())) {
    return null
  }

  const assetUrl = new URL(
    `./builtin-plugins/${relativeAssetPath}`,
    import.meta.url
  )
  const buffer = await fs.readFile(assetUrl)
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex")
  const key = `${seedSlug}/${pluginSlug}`

  const existing = await db
    .selectFrom("fileAssets as f")
    .select("f.id")
    .where("f.workspaceId", "is", null)
    .where("f.sourceFamily", "=", "platform_asset")
    .where("f.sourceSystem", "=", FILE_ORIGIN_SYSTEMS.BUILTIN_PLUGIN_ICON)
    .where(sql<boolean>`f.details_json->>'builtinPluginIconKey' = ${key}`)
    .where("f.contentSha256", "=", sha256)
    .limit(1)
    .executeTakeFirst()

  if (existing) {
    return {
      id: existing.id,
    }
  }

  const originalName = relativeAssetPath.split("/").pop() || `${pluginSlug}.svg`
  const file = await saveFromBuffer(
    buffer,
    originalName,
    inferMimeTypeForAsset(relativeAssetPath),
    null,
    null,
    buildPlatformAssetOrigin({
      system: FILE_ORIGIN_SYSTEMS.BUILTIN_PLUGIN_ICON,
      details: {
        builtinPluginIconKey: key,
        sha256,
        source: "builtin_plugin_icon",
      },
    })
  )

  return {
    id: file.id,
  }
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

function mapPluginView(row: PluginCatalogRow): MarketplacePluginView {
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
    defaultReuseScope: defaultReuseScope,
    defaultConversationTypeMask: defaultConversationTypeMask,
    supportedReuseScopes: supportedReuseScopes,
    configSchema: asObject(row.specConfigSchema),
    configFields: configFields,
    defaultConfig: asObject(row.specDefaultConfig),
    toolsManifest: asArray(row.specToolManifest),
    validationRules: validationRules,
    setupSteps: setupSteps,
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
    createdAt: presentInstant(row.itemCreatedAt),
    updatedAt: presentInstant(row.itemUpdatedAt),
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

function isSecretConfigField(
  field: PluginConfigFieldDefinition | undefined,
  schemaProperties: Record<string, unknown>,
  key: string
) {
  const property = asObject(schemaProperties[key])
  return Boolean(
    field?.secret || field?.type === "secret" || property.sensitive === true
  )
}

function sanitizeInstallationConfig(
  installation: { config_data: unknown; updated_at: Date },
  configSchema: Record<string, unknown>,
  configFields: PluginConfigFieldDefinition[],
  authBindings: PluginAuthBindingDefinition[]
) {
  const rawConfig = asObject(installation.config_data)
  const schemaProperties = asObject(configSchema.properties)
  const fieldMap = new Map(configFields.map((field) => [field.key, field]))
  const bindingMap = new Map(
    authBindings.map((binding) => [binding.key, binding])
  )
  const sanitizedConfig: Record<string, unknown> = {}
  const configState: PluginConfigFieldState[] = []

  for (const [key, value] of Object.entries(rawConfig)) {
    const field = fieldMap.get(key)

    if (
      field?.type === "auth_connection" &&
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
            : presentInstant(installation.updated_at),
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
        updatedAt: presentInstant(installation.updated_at),
      })
      continue
    }

    if (field?.serverManaged) {
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== "",
        updatedAt: presentInstant(installation.updated_at),
      })
      continue
    }

    sanitizedConfig[key] = value
  }

  for (const field of configFields) {
    if (
      configState.find((state) => state.key === field.key) ||
      (!field.secret &&
        field.type !== "auth_connection" &&
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

function mergeConfigForUpdate(
  existingConfig: Record<string, unknown>,
  incomingConfig: Record<string, unknown>,
  configFields: PluginConfigFieldDefinition[]
) {
  const merged: Record<string, unknown> = {
    ...existingConfig,
    ...incomingConfig,
  }

  for (const field of configFields) {
    if (!field.secret) continue
    const incoming = incomingConfig[field.key]
    if (
      (incoming === undefined || incoming === null || incoming === "") &&
      existingConfig[field.key] !== undefined
    ) {
      merged[field.key] = existingConfig[field.key]
    }
  }

  return merged
}

/**
 * D3: collapse a stored InstallationAccessRow back into the canonical
 * ScopedSubjectTarget shape, for handing off to policy / write helpers.
 *
 * Decode the plugin-installation grant row back into a canonical
 * ScopedSubjectTarget-like shape for policy validation and UI mapping.
 */
function installationAccessRowToTarget(
  row: InstallationAccessRow
): CapabilityAccessTarget {
  switch (row.access_target_type) {
    case "workspace":
      return { subject: workspaceRef(row.workspace_id) }
    case "workspace_member":
      return row.workspace_member_id
        ? { subject: workspaceMemberRef(row.workspace_member_id) }
        : { subject: workspaceRef(row.workspace_id) }
    case "conversation":
      return row.conversation_id
        ? { subject: conversationRef(row.conversation_id) }
        : { subject: workspaceRef(row.workspace_id) }
    case "actor":
      return row.actor_id
        ? {
            subject: actorRef(row.actor_id),
            ...(row.conversation_id
              ? { scope: conversationRef(row.conversation_id) }
              : {}),
          }
        : { subject: workspaceRef(row.workspace_id) }
    case "remote_agent":
      return row.remote_agent_id
        ? {
            subject: remoteAgentRef(row.remote_agent_id),
            ...(row.conversation_id
              ? { scope: conversationRef(row.conversation_id) }
              : {}),
          }
        : { subject: workspaceRef(row.workspace_id) }
  }
}

function buildInstallationAccessRow(input: {
  id: string
  workspaceId: string
  installationId: string
  target: CapabilityAccessTarget
  conversationTypeMaskOverride: number | null
  status: "active" | "revoked"
  source: "manual" | "approval" | "system"
  createdByWorkspaceMemberId: string | null
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}): InstallationAccessRow {
  const target = input.target
  const label = subjectScopeLabel(target)
  let accessTargetType: RuntimeBindingScope
  switch (label) {
    case "workspace":
    case "workspace_member":
    case "conversation":
    case "actor":
    case "remote_agent":
      accessTargetType = label
      break
    default:
      accessTargetType = "workspace"
  }
  const actorId =
    target.subject.kind === "actor"
      ? (target.subject as { actorId: string }).actorId
      : null
  const remoteAgentId =
    target.subject.kind === "remote_agent"
      ? (target.subject as { remoteAgentId: string }).remoteAgentId
      : null
  const conversationId =
    target.scope?.kind === "conversation"
      ? (target.scope as { conversationId: string }).conversationId
      : target.subject.kind === "conversation"
        ? (target.subject as { conversationId: string }).conversationId
        : null
  const workspaceMemberId =
    target.subject.kind === "workspace_member"
      ? (target.subject as { memberId: string }).memberId
      : null
  return {
    id: input.id,
    workspace_id: input.workspaceId,
    installation_id: input.installationId,
    access_target_type: accessTargetType,
    actor_id: actorId,
    remote_agent_id: remoteAgentId,
    conversation_id: conversationId,
    workspace_member_id: workspaceMemberId,
    conversation_type_mask_override: input.conversationTypeMaskOverride,
    status: input.status,
    source: input.source,
    created_by_workspace_member_id: input.createdByWorkspaceMemberId,
    reason: input.reason,
    created_at: input.createdAt,
    revoked_at: input.revokedAt,
  }
}

async function loadPluginCatalogRows(whereClause: RawBuilder<unknown>) {
  const result = await db.executeQuery(
    sql<PluginCatalogRow>`
      ${sql.raw(PLUGIN_CATALOG_SELECT)}
      ${whereClause}
    `.compile(db)
  )
  // PLUGIN_CATALOG_SELECT projects camelCase-quoted aliases, so CamelCasePlugin
  // leaves the top-level keys untouched and the rows already match
  // PluginCatalogRow + mapPluginView.
  return result.rows
}

async function loadPluginCatalogMapByVersionIds(versionIds: string[]) {
  if (versionIds.length === 0) {
    return new Map<string, ReturnType<typeof mapPluginView>>()
  }

  const rows = await loadPluginCatalogRows(
    sql`AND version.id = ANY(${versionIds}::uuid[])`
  )

  return new Map(rows.map((row) => [row.versionId!, mapPluginView(row)]))
}

async function getPluginCatalogRowByItemId(itemId: string) {
  const rows = await loadPluginCatalogRows(
    sql`AND item.id = ${itemId}
       AND version.id = item.latest_version_id
       LIMIT 1`
  )

  return rows[0] || null
}

async function loadInstallationRows(
  workspaceId: string,
  filters?: {
    installationIds?: string[]
    pluginId?: string
    installationId?: string
  }
) {
  const conditions: RawBuilder<unknown>[] = [
    sql`app.workspace_id = ${workspaceId}`,
  ]

  if (filters?.pluginId) {
    conditions.push(sql`installation.catalog_item_id = ${filters.pluginId}`)
  }

  if (filters?.installationId) {
    conditions.push(sql`installation.id = ${filters.installationId}`)
  }
  if (filters?.installationIds?.length) {
    conditions.push(
      sql`installation.id = ANY(${filters.installationIds}::uuid[])`
    )
  }

  const result = await db.executeQuery(
    sql<InstallationRow>`SELECT
        installation.id AS "installationId",
        app.workspace_id AS "rootWorkspaceId",
        installation.catalog_item_id AS "catalogItemId",
        installation.catalog_version_id AS "catalogVersionId",
        app.display_name AS "rootDisplayName",
        installation.config_data AS "configData",
        installation.approved_runtime_permissions AS "approvedRuntimePermissions",
        installation.reuse_scope AS "reuseScope",
        app.conversation_type_mask_override AS "rootConversationTypeMaskOverride",
        app.status AS "rootStatus",
        app.owner_workspace_member_id AS "rootOwnerWorkspaceMemberId",
        app.created_at AS "installationCreatedAt",
        app.updated_at AS "installationUpdatedAt",
        source_ref.source_catalog_item_id AS "sourceCatalogItemId",
        source_ref.source_catalog_version_id AS "sourceCatalogVersionId",
        source_ref.sync_mode AS "sourceSyncMode"
      -- Soft-delete (review F9/F16): read the live surface — excludes both
      -- tombstoned (deleted_at) AND non-live status (archived) installations,
      -- the same definition as plugin_installations manifest liveValues.
      FROM plugin_installations installation
      INNER JOIN workspace_apps_live app
        ON app.id = installation.id
      LEFT JOIN plugin_source_refs source_ref
        ON source_ref.installation_id = installation.id
      WHERE app.deleted_at IS NULL
        AND app.status IN ('active', 'disabled', 'error')
        AND ${sql.join(conditions, sql` AND `)}
      ORDER BY installation.created_at DESC`.compile(db)
  )

  // PLUGIN installation rows project camelCase-quoted aliases, so
  // CamelCasePlugin leaves them as-is and they already match InstallationRow.
  return result.rows
}

async function listAccessRows(installationId: string, includeRevoked = false) {
  let query = db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .leftJoin("accessSubjects as scope", "scope.id", "app_grant.scopeSubjectId")
    .select([
      "app_grant.id",
      "app_grant.workspaceId as workspace_id",
      "app_grant.workspaceAppId as installation_id",
      sql<RuntimeBindingScope>`
        CASE subj.kind
          WHEN 'workspace' THEN 'workspace'
          WHEN 'workspace_member' THEN 'workspace_member'
          WHEN 'conversation' THEN 'conversation'
          WHEN 'actor' THEN 'actor'
          WHEN 'remote_agent' THEN 'remote_agent'
        END
      `.as("access_target_type"),
      "subj.actorId as actor_id",
      "subj.remoteAgentId as remote_agent_id",
      "subj.workspaceMemberId as workspace_member_id",
      "scope.conversationId as conversation_id",
      "app_grant.conversationTypeMaskOverride as conversation_type_mask_override",
      "app_grant.status",
      "app_grant.source",
      "app_grant.createdByWorkspaceMemberId as created_by_workspace_member_id",
      "app_grant.reason",
      "app_grant.createdAt as created_at",
      "app_grant.revokedAt as revoked_at",
    ])
    .where("app_grant.workspaceAppId", "=", installationId)
    .where(
      sql<boolean>`'use'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .orderBy("app_grant.createdAt", "desc")

  if (!includeRevoked) {
    query = query.where("app_grant.status", "=", "active")
  }

  return (await query.execute()).map((row) => ({
    ...row,
    created_at: row.created_at || new Date(0),
  }))
}

function buildPluginGrantPlan(input: {
  authorization: {
    requiredPermissions: string[]
    reason?: string
  }
}) {
  const requiredPermissions = input.authorization.requiredPermissions || []
  if (requiredPermissions.length === 0) {
    return {
      requiresGrant: false,
      requiredPermissions: [],
    }
  }

  return {
    requiresGrant: true,
    requiredPermissions,
    reason: input.authorization.reason,
  }
}

function suggestedAccessTargetType(
  target: CapabilityAccessTarget
): RuntimeBindingScope | "actor_conversation" | "remote_agent_conversation" {
  if (
    target.subject.kind === "actor" &&
    target.scope?.kind === "conversation"
  ) {
    return "actor_conversation"
  }
  if (
    target.subject.kind === "remote_agent" &&
    target.scope?.kind === "conversation"
  ) {
    return "remote_agent_conversation"
  }
  return subjectScopeLabel(target) as RuntimeBindingScope
}

function mapAccessRowToGrant(
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
    createdAt: presentInstant(mount.created_at),
    revokedAt: presentOptionalInstant(mount.revoked_at),
  }
}

function buildInstallationPayload(
  row: InstallationRow,
  plugin: ReturnType<typeof mapPluginView>,
  workspaceConversationTypeMask: number
): PluginInstallationDetailView {
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
      config_data: row.configData,
      updated_at: row.installationUpdatedAt,
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
    sourceDefaultConversationTypeMask: sourceDefaultConversationTypeMask,
    workspaceConversationTypeMask: workspaceConversationTypeMask,
    conversationTypeMaskOverride: row.rootConversationTypeMaskOverride ?? null,
    effectiveConversationTypeMask: effectiveConversationTypeMask,
    supportedReuseScopes: plugin.supportedReuseScopes || [],
    isEnabled: row.rootStatus === "active",
    status: row.rootStatus,
    configData: sanitizedConfig,
    configState: configState,
    approvedRuntimePermissions: row.approvedRuntimePermissions || [],
    ownerWorkspaceMemberId: row.rootOwnerWorkspaceMemberId,
    createdAt: presentInstant(row.installationCreatedAt),
    updatedAt: presentInstant(row.installationUpdatedAt),
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

async function getInstallationPayload(
  workspaceId: string,
  installationId: string
) {
  const rows = await loadInstallationRows(workspaceId, {
    installationId,
  })
  const row = rows[0]
  if (!row) {
    throw new McpPluginError(404, "Installation not found")
  }

  const pluginsByVersionId = await loadPluginCatalogMapByVersionIds([
    row.catalogVersionId,
  ])
  const plugin = pluginsByVersionId.get(row.catalogVersionId)
  if (!plugin) {
    throw new McpPluginError(404, "Plugin not found")
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      row.rootWorkspaceId,
      "plugin_installation"
    )

  return {
    row,
    plugin,
    workspaceConversationTypeMask,
    installation: buildInstallationPayload(
      row,
      plugin,
      workspaceConversationTypeMask
    ),
  }
}

async function ensureCatalogItem(
  ex: Executor,
  input: {
    orgId: string
    workspaceId?: string
    slug: string
    displayName: string
    description?: string
    longDescription?: string
    iconFileId?: string
    tags?: string[]
    isBuiltin?: boolean
    transport: PluginSpecTransport
    displayNameI18n?: Record<string, string>
    descriptionI18n?: Record<string, string>
    longDescriptionI18n?: Record<string, string>
    summaryI18n?: Record<string, string>
    defaultLocale?: string
  }
) {
  const normalizedSlug = sanitizeSlug(input.slug)
  const existing = await runBuilder(
    ex,
    ex
      .selectFrom("catalogItems")
      .select("id")
      .where("publisherId", "=", input.orgId)
      .where("itemKind", "=", "plugin_package")
      .where("slug", "=", normalizedSlug)
      .where(
        sql<SqlBool>`${sql.ref("workspaceId")} is not distinct from ${
          input.workspaceId || null
        }`
      )
      .limit(1)
  )

  const metadata = {
    displayNameI18n: input.displayNameI18n || { en: input.displayName },
    descriptionI18n: input.descriptionI18n || { en: input.description || "" },
    longDescriptionI18n:
      input.longDescriptionI18n ||
      (input.longDescription ? { en: input.longDescription } : undefined),
    summaryI18n: input.summaryI18n,
    defaultLocale: input.defaultLocale || "en",
  }

  if (existing.rows.length > 0) {
    const itemId = existing.rows[0]!.id
    await ex
      .updateTable("catalogItems")
      .set({
        displayName: input.displayName,
        summary: input.description || "",
        longDescription: input.longDescription || "",
        sourceKind: input.isBuiltin ? "builtin" : "official",
        visibility: "public",
        tags: input.tags || [],
        isActive: true,
        iconFileId: input.iconFileId || null,
        metadata: sql`${JSON.stringify(metadata)}::jsonb`,
      })
      .where("id", "=", itemId)
      .execute()
    return itemId
  }

  const inserted = await runBuilder(
    ex,
    ex
      .insertInto("catalogItems")
      .values({
        publisherId: input.orgId,
        workspaceId: input.workspaceId || null,
        itemKind: "plugin_package",
        slug: normalizedSlug,
        displayName: input.displayName,
        summary: input.description || "",
        longDescription: input.longDescription || "",
        iconFileId: input.iconFileId || null,
        sourceKind: input.isBuiltin ? "builtin" : "official",
        visibility: "public",
        tags: input.tags || [],
        isActive: true,
        metadata: sql`${JSON.stringify(metadata)}::jsonb`,
      })
      .returning("id")
  )

  return inserted.rows[0]!.id
}

async function upsertPluginVersion(
  ex: Executor,
  itemId: string,
  input: {
    version?: string
    transport: PluginSpecTransport
    entryPoint?: string
    lifecycleScope?: ReuseScope
    supportedReuseScopes?: ReuseScope[]
    defaultConversationTypeMask?: number
    requiresHandshake?: boolean
    toolsManifest?: unknown[]
    configSchema?: Record<string, unknown>
    defaultConfig?: Record<string, unknown>
    installFlow?: PluginInstallFlow
    authBindings?: PluginAuthBindingDefinition[]
    configFields?: PluginConfigFieldDefinition[]
    validationRules?: McpValidationRule[]
    setupSteps?: McpSetupStep[]
    authorization?: {
      requiredPermissions?: string[]
      reason?: string
    }
  }
) {
  const versionValue = input.version || "1.0.0"
  const upsertedVersion = await runBuilder(
    ex,
    ex
      .insertInto("catalogVersions")
      .values({
        catalogItemId: itemId,
        version: versionValue,
        status: "active",
        changelog: "",
        metadata: sql`'{}'::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(["catalogItemId", "version"]).doUpdateSet({
          status: "active",
        })
      )
      .returning("id")
  )
  const versionId = upsertedVersion.rows[0]!.id

  const metadata = {
    configFields: input.configFields || [],
    validationRules: input.validationRules || [],
    setupSteps: input.setupSteps || [],
    authorization: {
      reason: input.authorization?.reason || undefined,
    },
  }
  const defaultReuseScope = input.lifecycleScope || "conversation"
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: input.defaultConversationTypeMask,
    overrideMask: null,
  })
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    input.supportedReuseScopes,
    defaultReuseScope
  )

  await ex
    .insertInto("pluginPackageVersionSpecs")
    .values({
      catalogVersionId: versionId,
      transport: input.transport as PluginPackageVersionSpecsTransport,
      entryPoint: input.entryPoint || null,
      toolManifest: sql`${JSON.stringify(input.toolsManifest || [])}::jsonb`,
      configSchema: sql`${JSON.stringify(input.configSchema || {})}::jsonb`,
      defaultConfig: sql`${JSON.stringify(input.defaultConfig || {})}::jsonb`,
      installFlow: sql`${JSON.stringify(
        input.installFlow || { steps: input.setupSteps || [] }
      )}::jsonb`,
      authBindings: sql`${JSON.stringify(input.authBindings || [])}::jsonb`,
      defaultReuseScope: internalReuseScope(defaultReuseScope),
      defaultConversationTypeMask: defaultConversationTypeMask,
      supportedReuseScopes: supportedReuseScopes.map((scope) =>
        internalReuseScope(scope)
      ),
      requiresHandshake:
        input.requiresHandshake ?? input.transport !== "builtin",
      metadata: sql`${JSON.stringify(metadata)}::jsonb`,
    })
    .onConflict((oc) =>
      oc.column("catalogVersionId").doUpdateSet({
        transport: sql`excluded.transport`,
        entryPoint: sql`excluded.entry_point`,
        toolManifest: sql`excluded.tool_manifest`,
        configSchema: sql`excluded.config_schema`,
        defaultConfig: sql`excluded.default_config`,
        installFlow: sql`excluded.install_flow`,
        authBindings: sql`excluded.auth_bindings`,
        defaultReuseScope: sql`excluded.default_reuse_scope`,
        defaultConversationTypeMask: sql`excluded.default_conversation_type_mask`,
        supportedReuseScopes: sql`excluded.supported_reuse_scopes`,
        requiresHandshake: sql`excluded.requires_handshake`,
        metadata: sql`excluded.metadata`,
      })
    )
    .execute()

  // set-replace of a derived config table → SECURITY DEFINER fn (naked DELETE
  // forbidden by sd_reject_delete; design §7.5).
  await sql`SELECT sd_replace_plugin_runtime_permissions(${versionId}::uuid)`.execute(
    ex
  )

  for (const permissionKey of input.authorization?.requiredPermissions || []) {
    await ex
      .insertInto("pluginVersionRuntimePermissions")
      .values({
        catalogVersionId: versionId,
        permissionKey: permissionKey,
        isRequired: true,
        rationale: "",
      })
      .execute()
  }

  await ex
    .updateTable("catalogItems")
    .set({
      latestVersionId: versionId,
    })
    .where("id", "=", itemId)
    .execute()

  return versionId
}

async function assignPluginCategories(
  ex: Executor,
  itemId: string,
  categorySlugs: string[]
) {
  // set-replace of a derived join table → SECURITY DEFINER fn (design §7.5).
  await sql`SELECT sd_replace_catalog_item_categories(${itemId}::uuid)`.execute(
    ex
  )

  if (categorySlugs.length === 0) return

  const result = await runBuilder(
    ex,
    ex
      .selectFrom("catalogCategories")
      .select("id")
      .where("itemKind", "=", "plugin_package")
      .where("slug", "in", categorySlugs)
  )

  for (const row of result.rows) {
    await ex
      .insertInto("catalogItemCategories")
      .values({
        catalogItemId: itemId,
        categoryId: row.id,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()
  }
}

export async function createOrganization(data: {
  slug: string
  displayName: string
  description?: string
  logoFileId?: string
  isBuiltin?: boolean
  isVerified?: boolean
  ownerUserId?: string
}): Promise<PublisherRecord> {
  const normalizedSlug = sanitizeSlug(data.slug)
  const row = await db
    .insertInto("publishers")
    .values({
      slug: normalizedSlug,
      displayName: data.displayName,
      description: data.description || "",
      logoFileId: data.logoFileId || null,
      ownerUserId: data.ownerUserId || null,
      workspaceId: null,
      isBuiltin: data.isBuiltin === true,
      isVerified: data.isVerified === true,
    })
    .onConflict((oc) =>
      oc
        .column("slug")
        .where("deletedAt", "is", null)
        .doUpdateSet({
          displayName: data.displayName,
          description: data.description || "",
          logoFileId: data.logoFileId || null,
          ownerUserId: sql`COALESCE(publishers.owner_user_id, excluded.owner_user_id)`,
          isBuiltin: data.isBuiltin === true,
          isVerified: data.isVerified === true,
        })
    )
    .returningAll()
    .executeTakeFirstOrThrow()

  return row
}

export async function listOrganizations(): Promise<PublisherRecord[]> {
  const rows = await db
    .selectFrom("publishers as publisher")
    .leftJoin("catalogItems as item", (join) =>
      join
        .onRef("item.publisherId", "=", "publisher.id")
        .on("item.itemKind", "=", "plugin_package")
        .on("item.isActive", "=", true)
        .on("item.workspaceId", "is", null)
    )
    .selectAll("publisher")
    .select(sql<number>`COUNT(item.id)::int`.as("pluginCount"))
    .groupBy("publisher.id")
    .orderBy("publisher.isVerified", "desc")
    .orderBy("publisher.displayName", "asc")
    .execute()

  return rows
}

export async function getOrganization(
  id: string
): Promise<PublisherRecord | null> {
  const row = await db
    .selectFrom("publishers")
    .selectAll()
    .select(sql<number>`0::int`.as("pluginCount"))
    .limit(1)
    .executeTakeFirst()

  if (!row) {
    throw new McpPluginError(404, "Publisher not found")
  }

  return row
}

export async function getOrganizationBySlug(
  slug: string
): Promise<PublisherRecord | null> {
  const row = await db
    .selectFrom("publishers")
    .selectAll()
    .select(sql<number>`0::int`.as("pluginCount"))
    .where("slug", "=", sanitizeSlug(slug))
    .limit(1)
    .executeTakeFirst()

  return row ?? null
}

export async function createPlugin(data: {
  orgId: string
  workspaceId?: string
  slug: string
  displayName: string
  description?: string
  longDescription?: string
  iconFileId?: string
  version?: string
  transport: PluginSpecTransport
  entryPoint?: string
  lifecycleScope?: ReuseScope
  configSchema?: Record<string, unknown>
  configFields?: PluginConfigFieldDefinition[]
  defaultConfig?: Record<string, unknown>
  toolsManifest?: unknown[]
  tags?: string[]
  categorySlugs?: string[]
  isBuiltin?: boolean
  validationRules?: McpValidationRule[]
  setupSteps?: McpSetupStep[]
  installFlow?: PluginInstallFlow
  authBindings?: PluginAuthBindingDefinition[]
  displayNameI18n?: Record<string, string>
  descriptionI18n?: Record<string, string>
  longDescriptionI18n?: Record<string, string>
  summaryI18n?: Record<string, string>
  defaultLocale?: string
  supportedReuseScopes?: ReuseScope[]
  requiresHandshake?: boolean
  authorization?: {
    requiredPermissions?: string[]
    reason?: string
  }
}): Promise<MarketplacePluginView> {
  const itemId = await withDbTransaction(async (client) => {
    const catalogItemId = await ensureCatalogItem(client, data)
    await upsertPluginVersion(client, catalogItemId, data)
    await assignPluginCategories(
      client,
      catalogItemId,
      data.categorySlugs || []
    )
    return catalogItemId
  })

  return getPlugin(itemId)
}

export async function listPlugins(filters?: {
  orgId?: string
  transport?: string
  search?: string
  tags?: string[]
  categorySlugs?: string[]
}): Promise<MarketplacePluginView[]> {
  const conditions: RawBuilder<unknown>[] = [
    sql`version.id = item.latest_version_id`,
    sql`item.is_active = TRUE`,
    sql`item.workspace_id IS NULL`,
  ]

  if (filters?.orgId) {
    conditions.push(sql`item.publisher_id = ${filters.orgId}`)
  }

  if (filters?.transport) {
    conditions.push(sql`spec.transport = ${filters.transport}`)
  }

  if (filters?.search) {
    conditions.push(
      sql`(item.display_name ILIKE ${`%${filters.search.trim()}%`} OR item.summary ILIKE ${`%${filters.search.trim()}%`} OR item.long_description ILIKE ${`%${filters.search.trim()}%`} OR EXISTS (
         SELECT 1
         FROM unnest(COALESCE(item.tags, ARRAY[]::text[])) tag
         WHERE tag ILIKE ${`%${filters.search.trim()}%`}
       ))`
    )
  }

  if (filters?.tags && filters.tags.length > 0) {
    conditions.push(sql`item.tags && ${filters.tags}::text[]`)
  }

  if (filters?.categorySlugs && filters.categorySlugs.length > 0) {
    conditions.push(
      sql`EXISTS (
         SELECT 1
         FROM catalog_item_categories item_category
         JOIN catalog_categories category
           ON category.id = item_category.category_id
         WHERE item_category.catalog_item_id = item.id
           AND category.item_kind = 'plugin_package'
           AND category.slug = ANY(${filters.categorySlugs}::text[])
       )`
    )
  }

  const rows = await loadPluginCatalogRows(
    sql`AND ${sql.join(conditions, sql` AND `)}
       ORDER BY item.download_count DESC, item.created_at DESC`
  )

  return rows.map(mapPluginView)
}

export async function listPluginCategories(): Promise<PluginCategoryRecord[]> {
  const rows = await db
    .selectFrom("catalogCategories")
    .selectAll()
    .where("itemKind", "=", "plugin_package")
    .orderBy("sortOrder", "asc")
    .orderBy("displayName", "asc")
    .execute()

  return rows
}

export async function getPlugin(id: string): Promise<MarketplacePluginView> {
  const row = await getPluginCatalogRowByItemId(id)
  if (!row) {
    throw new McpPluginError(404, "Plugin not found")
  }

  return mapPluginView(row)
}

export function validateSupportedLifecycleScope(
  supportedScopes: readonly ReuseScope[],
  lifecycleScope: ReuseScope
) {
  return supportedScopes.includes(lifecycleScope)
}

export async function installPluginUnified(data: {
  workspaceId: string
  pluginId: string
  lifecycleScope?: ReuseScope
  configData?: Record<string, unknown>
  authSessionIds?: Record<string, string>
  installedByWorkspaceMemberId?: string
  grants?: Array<{
    target: CapabilityAccessTarget
    permissions: WorkspaceAppGrantPermission[]
    conversationTypeMaskOverride?: number | null
    reason?: string
  }>
}): Promise<PluginInstallationDetailView> {
  const plugin = await getPlugin(data.pluginId)
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    plugin.supportedReuseScopes,
    plugin.defaultReuseScope || "conversation"
  )
  const lifecycleScope =
    data.lifecycleScope || plugin.defaultReuseScope || "conversation"
  assertSupportedReuseScope(supportedReuseScopes, lifecycleScope, plugin.slug)
  const approvedRuntimePermissions =
    plugin.authorization?.requiredPermissions || []

  async function validateResolvedConfigForInstall(
    config: Record<string, unknown>,
    ex: Executor
  ) {
    if (plugin.entryPoint !== "feishu/app") {
      return
    }

    const features = normalizeFeishuFeatureKeys(config.features)
    try {
      assertFeishuFeatureSelection(features)
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error
          ? error.message
          : "Invalid Feishu feature selection."
      )
    }

    const rawConnection = asObject(config.feishuAccount)
    if (
      rawConnection.__kind !== "auth_connection_ref" ||
      typeof rawConnection.connectionId !== "string"
    ) {
      throw new McpPluginError(400, "Feishu account authorization is required.")
    }

    const connectionResult = await runBuilder(
      ex,
      ex
        .selectFrom("pluginConnections")
        .select("publicPayload")
        .where("id", "=", rawConnection.connectionId)
        .where("deletedAt", "is", null)
        .where("status", "in", PLUGIN_CONNECTION_LIVE_STATUSES)
        .limit(1)
    )
    if (connectionResult.rows.length === 0) {
      throw new McpPluginError(400, "Feishu auth connection not found.")
    }

    try {
      assertFeishuScopesForFeatures(
        features,
        asObject(connectionResult.rows[0]!.publicPayload).scopes
      )
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error
          ? error.message
          : "Feishu scopes do not match the selected features."
      )
    }
  }

  const result = await withDbTransaction(async (client) => {
    const catalogRow = await getPluginCatalogRowByItemId(plugin.id)
    const catalogVersionId = catalogRow?.versionId
    if (!catalogVersionId) {
      throw new McpPluginError(
        500,
        "Plugin catalog is missing its latest version"
      )
    }

    const installationId = crypto.randomUUID()
    await insertWorkspaceAppRoot(client, {
      id: installationId,
      workspaceId: data.workspaceId,
      kind: "plugin_installation",
      displayName: plugin.displayName,
      ownerWorkspaceMemberId: data.installedByWorkspaceMemberId || null,
      status: "active",
      conversationTypeMaskOverride: plugin.defaultConversationTypeMask ?? null,
    })
    const insertedInstallation = await takeFirstOn<{ id: string }>(
      client,
      db
        .insertInto("pluginInstallations")
        .values({
          id: installationId,
          catalogItemId: plugin.id,
          catalogVersionId: catalogVersionId,
          configData: {} as PluginInstallationsConfigData,
          approvedRuntimePermissions: approvedRuntimePermissions,
          reuseScope: internalReuseScope(lifecycleScope),
        })
        .returning("id")
    )
    const insertedInstallationId = insertedInstallation!.id
    if (insertedInstallationId !== installationId) {
      throw new McpPluginError(500, "Plugin installation id mismatch")
    }

    const resolvedConfigBase = data.configData || {}
    const resolvedConfig = await attachAuthConnectionsToConfig({
      installationId,
      workspaceId: data.workspaceId,
      workspaceMemberId: data.installedByWorkspaceMemberId || "",
      configFields: plugin.configFields || [],
      authBindings: plugin.authBindings || [],
      configData: resolvedConfigBase,
      authSessionIds: data.authSessionIds,
      run: runnerFn(client),
    })
    const validation = validateConfig(
      resolvedConfig,
      plugin.validationRules || []
    )
    if (!validation.valid) {
      throw new McpPluginError(
        400,
        validation.errors.map((item) => item.message).join("; ")
      )
    }
    await validateResolvedConfigForInstall(resolvedConfig, client)
    const encryptedConfig = encryptSensitiveFields(
      resolvedConfig,
      plugin.configSchema || {}
    )

    await runBuilder(
      client,
      db
        .updateTable("pluginInstallations")
        .set({
          configData: encryptedConfig as PluginInstallationsConfigData,
        })
        .where("id", "=", installationId)
    )

    await runBuilder(
      client,
      db.insertInto("pluginSourceRefs").values({
        installationId: installationId,
        sourceCatalogItemId: plugin.id,
        sourceCatalogVersionId: catalogVersionId,
        syncMode: "manual_merge",
      })
    )

    await runBuilder(
      client,
      db
        .updateTable("catalogItems")
        .set({
          downloadCount: sql`download_count + 1`,
        })
        .where("id", "=", plugin.id)
    )

    for (const grant of data.grants || []) {
      await insertWorkspaceAppGrant(client as any, {
        workspaceId: data.workspaceId,
        workspaceAppId: installationId,
        target: await resolveAccessGrantTarget({
          workspaceId: data.workspaceId,
          target: grant.target,
        }),
        permissions: grant.permissions,
        conversationTypeMaskOverride:
          grant.conversationTypeMaskOverride ?? null,
        createdByWorkspaceMemberId: data.installedByWorkspaceMemberId || null,
        reason: grant.reason ?? null,
      })
    }

    return {
      installationId,
    }
  })

  await incrementMcpVersion(data.workspaceId)

  const installed = await getInstallation(
    data.workspaceId,
    result.installationId
  )
  return installed
}

/**
 * Soft-delete teardown for a plugin installation, executor-scoped so it can run
 * inside any transaction (the real service wraps it in withDbTransaction; tests
 * call it on a rolled-back trx). Revokes the installation's access bindings,
 * soft-deletes its child plugin_connections (review F5), then soft-deletes the
 * installation itself. Idempotent (deleted_at IS NULL guards). Single source of
 * truth for uninstall semantics — do NOT re-implement these SQL flips elsewhere.
 */
export async function tearDownPluginInstallationOn(
  client: Executor,
  installId: string
): Promise<void> {
  await revokeWorkspaceAppGrantsForApp(client as any, installId)

  // Soft delete the installation's connections too (review F5): plugin_connections
  // is its own soft-delete root, so uninstalling the parent must close the child
  // OAuth/token connections — otherwise they stay live and their secrets remain
  // resolvable. Flip both deleted_at and status so status-aware reads also drop
  // them. Done before the parent flip (a child deleted_at flip is always allowed
  // by the FK-liveness trigger).
  await runBuilder(
    client,
    db
      .updateTable("pluginConnections")
      .set({
        deletedAt: sql`NOW()`,
        status: "revoked",
      })
      .where("installationId", "=", installId)
      .where("deletedAt", "is", null)
  )
  await updateWorkspaceAppRoot(client, {
    id: installId,
    status: "archived",
    deletedAt: new Date(),
  })

  // Root lifecycle lives on workspace_apps. The detail row stays until purge.
}

export async function uninstallPluginUnified(installId: string) {
  const installation = await db
    .selectFrom("pluginInstallations as installation")
    .innerJoin("workspaceApps as app", "app.id", "installation.id")
    .select([
      "installation.id as installation_id",
      "app.workspaceId as workspace_id",
    ])
    .where("installation.id", "=", installId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!installation) {
    throw new McpPluginError(404, "Installation not found")
  }
  await withDbTransaction((client) =>
    tearDownPluginInstallationOn(client, installId)
  )

  await incrementMcpVersion(installation.workspace_id)

  return {
    id: installId,
    workspace_id: installation.workspace_id,
  }
}

export async function getInstallations(
  workspaceId: string,
  filters?: {
    installationIds?: string[]
    pluginId?: string
  }
): Promise<PluginInstallationDetailView[]> {
  const rows = await loadInstallationRows(workspaceId, filters)
  const pluginsByVersionId = await loadPluginCatalogMapByVersionIds(
    Array.from(new Set(rows.map((row) => row.catalogVersionId)))
  )
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      workspaceId,
      "plugin_installation"
    )

  return rows
    .map((row) => {
      const plugin = pluginsByVersionId.get(row.catalogVersionId)
      return plugin
        ? buildInstallationPayload(row, plugin, workspaceConversationTypeMask)
        : null
    })
    .filter((view): view is PluginInstallationDetailView => view !== null)
}

export async function getInstallation(
  workspaceId: string,
  installId: string
): Promise<PluginInstallationDetailView> {
  const { installation } = await getInstallationPayload(workspaceId, installId)
  return installation
}

export async function updateInstallation(
  installId: string,
  data: {
    isEnabled?: boolean
    configData?: Record<string, unknown>
    authSessionIds?: Record<string, string>
    lifecycleScope?: ReuseScope
    conversationTypeMaskOverride?: number | null
    updatedByWorkspaceMemberId?: string
  }
): Promise<PluginInstallationDetailView> {
  const currentRow = await db
    .selectFrom("pluginInstallations as installation")
    .innerJoin("workspaceApps as app", "app.id", "installation.id")
    .select("app.workspaceId as workspace_id")
    .where("installation.id", "=", installId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  if (!currentRow) {
    throw new McpPluginError(404, "Installation not found")
  }

  const workspaceId = currentRow.workspace_id
  const { row, plugin, workspaceConversationTypeMask } =
    await getInstallationPayload(workspaceId, installId)

  const nextLifecycleScope =
    data.lifecycleScope || publicReuseScope(row.reuseScope)
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    plugin.supportedReuseScopes,
    plugin.defaultReuseScope || "conversation"
  )
  assertSupportedReuseScope(
    supportedReuseScopes,
    nextLifecycleScope,
    plugin.slug
  )

  const mergedConfig = data.configData
    ? mergeConfigForUpdate(
        asObject(row.configData),
        data.configData,
        plugin.configFields || []
      )
    : asObject(row.configData)

  if (data.conversationTypeMaskOverride !== undefined) {
    const nextInstanceConversationTypeMask =
      assertConversationTypeMaskWithinParent({
        parentConversationTypeMask: workspaceConversationTypeMask,
        conversationTypeMaskOverride: data.conversationTypeMaskOverride,
        buildError: (message) => new McpPluginError(400, message),
        invalidMaskMessage:
          "Plugin installation conversation policy must allow at least one workspace conversation type.",
      })
    const accessRows = await listAccessRows(installId)
    for (const accessRow of accessRows) {
      await validateConversationScopedAccessTarget({
        db,
        target: installationAccessRowToTarget(accessRow),
        effectiveConversationTypeMask: nextInstanceConversationTypeMask,
        buildError: (message) => new McpPluginError(400, message),
      })
    }
  }

  async function validateResolvedConfigForUpdate(
    config: Record<string, unknown>,
    ex: Executor
  ) {
    if (plugin.entryPoint !== "feishu/app") {
      return
    }

    const features = normalizeFeishuFeatureKeys(config.features)
    try {
      assertFeishuFeatureSelection(features)
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error
          ? error.message
          : "Invalid Feishu feature selection."
      )
    }

    const rawConnection = asObject(config.feishuAccount)
    if (
      rawConnection.__kind !== "auth_connection_ref" ||
      typeof rawConnection.connectionId !== "string"
    ) {
      throw new McpPluginError(400, "Feishu account authorization is required.")
    }

    const connectionResult = await runBuilder(
      ex,
      ex
        .selectFrom("pluginConnections")
        .select("publicPayload")
        .where("id", "=", rawConnection.connectionId)
        .where("deletedAt", "is", null)
        .where("status", "in", PLUGIN_CONNECTION_LIVE_STATUSES)
        .limit(1)
    )
    if (connectionResult.rows.length === 0) {
      throw new McpPluginError(400, "Feishu auth connection not found.")
    }

    try {
      assertFeishuScopesForFeatures(
        features,
        asObject(connectionResult.rows[0]!.publicPayload).scopes
      )
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error
          ? error.message
          : "Feishu scopes do not match the selected features."
      )
    }
  }

  await withDbTransaction(async (client) => {
    const run = runnerFn(client)

    const resolvedConfig =
      data.configData || data.authSessionIds
        ? await attachAuthConnectionsToConfig({
            installationId: installId,
            workspaceId,
            workspaceMemberId:
              data.updatedByWorkspaceMemberId ||
              row.rootOwnerWorkspaceMemberId ||
              "",
            configFields: plugin.configFields || [],
            authBindings: plugin.authBindings || [],
            configData: mergedConfig,
            authSessionIds: data.authSessionIds,
            run,
          })
        : mergedConfig

    if (data.configData || data.authSessionIds) {
      const validation = validateConfig(
        resolvedConfig,
        plugin.validationRules || []
      )
      if (!validation.valid) {
        throw new McpPluginError(
          400,
          validation.errors.map((item) => item.message).join("; ")
        )
      }
    }

    if (data.configData || data.authSessionIds) {
      await validateResolvedConfigForUpdate(resolvedConfig, client)
    }

    if (data.configData || data.authSessionIds) {
      const encryptedConfig = encryptSensitiveFields(
        resolvedConfig,
        plugin.configSchema || {}
      )
      await client
        .updateTable("pluginInstallations")
        .set({
          configData: sql`${JSON.stringify(encryptedConfig)}::jsonb`,
        })
        .where("id", "=", installId)
        .execute()
    }

    if (data.isEnabled !== undefined) {
      // root-only status source; no detail-table status update remains
    }

    if (data.lifecycleScope) {
      await client
        .updateTable("pluginInstallations")
        .set({
          reuseScope: internalReuseScope(nextLifecycleScope),
        })
        .where("id", "=", installId)
        .execute()
    }

    if (data.conversationTypeMaskOverride !== undefined) {
      // root-only conversation-type policy source; no detail-table override update remains
    }

    await updateWorkspaceAppRoot(client, {
      id: installId,
      displayName: row.rootDisplayName,
      status:
        data.isEnabled === undefined
          ? row.rootStatus === "active"
            ? "active"
            : row.rootStatus === "disabled"
              ? "disabled"
              : "error"
          : data.isEnabled
            ? "active"
            : "disabled",
      conversationTypeMaskOverride:
        data.conversationTypeMaskOverride === undefined
          ? row.rootConversationTypeMaskOverride
          : data.conversationTypeMaskOverride,
    })
  })

  await incrementMcpVersion(workspaceId)

  if (data.configData || data.authSessionIds) {
    await emitEvent({
      type: "mcp.config.changed",
      workspaceId,
      payload: { pluginId: row.catalogItemId, workspaceId },
      timestamp: nowIsoInstant(),
    })
  }

  return getInstallation(workspaceId, installId)
}

export async function getPluginInstallationGrantState(
  workspaceId: string,
  installationId: string
) {
  const { installation, plugin, workspaceConversationTypeMask } =
    await getInstallationPayload(workspaceId, installationId)
  const accessRows = await listAccessRows(installationId)
  const grants = accessRows
    .filter((binding) => binding.status === "active")
    .map((binding) =>
      mapAccessRowToGrant(binding, {
        workspaceConversationTypeMask,
        instanceConversationTypeMaskOverride:
          installation.conversationTypeMaskOverride ?? null,
      })
    )

  return {
    grants,
    summary: {
      requiredPermissions: plugin.authorization?.requiredPermissions || [],
      suggestedAccessTargetType: "workspace",
      sourceDefaultConversationTypeMask:
        installation.sourceDefaultConversationTypeMask ||
        DEFAULT_CONVERSATION_TYPE_MASK,
      workspaceConversationTypeMask,
      conversationTypeMaskOverride:
        installation.conversationTypeMaskOverride ?? null,
      effectiveConversationTypeMask: installation.effectiveConversationTypeMask,
      reason: plugin.authorization?.reason,
      effectivePermissions:
        grants.length > 0
          ? plugin.authorization?.requiredPermissions || []
          : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  }
}

export async function createPluginInstallationGrant(input: {
  workspaceId: string
  installationId: string
  accessTarget?: CapabilityAccessTarget
  conversationTypeMaskOverride?: number | null
  grantedByWorkspaceMemberId?: string
  reason?: string
}) {
  const { plugin, installation, workspaceConversationTypeMask } =
    await getInstallationPayload(input.workspaceId, input.installationId)
  const accessRows = await listAccessRows(input.installationId)

  const resolvedAccessTarget = input.accessTarget || {
    subject: workspaceRef(input.workspaceId),
  }
  const accessTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: resolvedAccessTarget,
  })
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    installation.conversationTypeMaskOverride ?? null
  )
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      target: accessTarget,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new McpPluginError(400, message),
      invalidMaskMessage:
        "Plugin access grant conversation policy must allow at least one conversation type from the installation policy.",
    })
  await validateConversationScopedAccessTarget({
    db,
    target: accessTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new McpPluginError(400, message),
  })

  // Round 9 review (P2): include remote_agent_id in the dedupe key.
  // Without it, two remote_agent grants for different remote agents
  // both have access_target_type="remote_agent" and were silently
  // collapsed against each other.
  const accessTargetLabel = subjectScopeLabel(accessTarget)
  const accessTargetActorId =
    accessTarget.subject.kind === "actor"
      ? (accessTarget.subject as { actorId: string }).actorId
      : null
  const accessTargetRemoteAgentId =
    accessTarget.subject.kind === "remote_agent"
      ? (accessTarget.subject as { remoteAgentId: string }).remoteAgentId
      : null
  const accessTargetConversationId =
    accessTarget.scope?.kind === "conversation"
      ? (accessTarget.scope as { conversationId: string }).conversationId
      : accessTarget.subject.kind === "conversation"
        ? (accessTarget.subject as { conversationId: string }).conversationId
        : null
  const accessTargetWorkspaceMemberId =
    accessTarget.subject.kind === "workspace_member"
      ? (accessTarget.subject as { memberId: string }).memberId
      : null
  const existing = accessRows.find(
    (entry) =>
      entry.status === "active" &&
      entry.access_target_type === accessTargetLabel &&
      entry.actor_id === accessTargetActorId &&
      entry.remote_agent_id === accessTargetRemoteAgentId &&
      entry.conversation_id === accessTargetConversationId &&
      entry.workspace_member_id === accessTargetWorkspaceMemberId
  )
  if (existing) {
    return mapAccessRowToGrant(existing, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        installation.conversationTypeMaskOverride ?? null,
    })
  }

  const result = await withDbTransaction(async (client) => {
    const inserted = await insertWorkspaceAppGrant(client as any, {
      workspaceId: input.workspaceId,
      workspaceAppId: input.installationId,
      target: accessTarget,
      permissions: [WORKSPACE_APP_GRANT_PERMISSION.USE],
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
      createdByWorkspaceMemberId: input.grantedByWorkspaceMemberId || null,
      reason: input.reason || plugin.authorization?.reason || null,
    })

    const accessRow = buildInstallationAccessRow({
      id: inserted.id,
      workspaceId: inserted.workspaceId,
      installationId: inserted.workspaceAppId,
      target: accessTarget,
      conversationTypeMaskOverride: inserted.conversationTypeMaskOverride,
      status: inserted.status,
      source: inserted.source,
      createdByWorkspaceMemberId: inserted.createdByWorkspaceMemberId,
      reason: inserted.reason,
      createdAt: inserted.createdAt || new Date(0),
      revokedAt: inserted.revokedAt,
    })
    return {
      accessRow,
    }
  })

  await incrementMcpVersion(input.workspaceId)

  return mapAccessRowToGrant(result.accessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      installation.conversationTypeMaskOverride ?? null,
  })
}

export async function updatePluginInstallationGrant(input: {
  workspaceId: string
  installationId: string
  grantId: string
  conversationTypeMaskOverride?: number | null
}) {
  if (input.conversationTypeMaskOverride === undefined) {
    const { plugin, installation, workspaceConversationTypeMask } =
      await getInstallationPayload(input.workspaceId, input.installationId)
    const accessRows = await listAccessRows(input.installationId)
    const accessRow = accessRows.find((entry) => entry.id === input.grantId)
    if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
      throw new McpPluginError(404, "Access grant not found")
    }
    return mapAccessRowToGrant(accessRow, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        installation.conversationTypeMaskOverride ?? null,
    })
  }

  const { plugin, installation, workspaceConversationTypeMask } =
    await getInstallationPayload(input.workspaceId, input.installationId)
  const accessRows = await listAccessRows(input.installationId, true)
  const accessRow = accessRows.find((entry) => entry.id === input.grantId)
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new McpPluginError(404, "Access grant not found")
  }
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    installation.conversationTypeMaskOverride ?? null
  )
  const accessRowTarget = installationAccessRowToTarget(accessRow)
  const effectiveConversationTypeMask =
    assertGrantConversationTypeOverrideAllowed({
      target: accessRowTarget,
      parentConversationTypeMask: instanceConversationTypeMask,
      conversationTypeMaskOverride: input.conversationTypeMaskOverride,
      buildError: (message) => new McpPluginError(400, message),
      invalidMaskMessage:
        "Plugin access grant conversation policy must allow at least one conversation type from the installation policy.",
    })
  await validateConversationScopedAccessTarget({
    db,
    target: accessRowTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new McpPluginError(400, message),
  })

  await db
    .updateTable("workspaceAppGrants")
    .set({
      conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
    } as any)
    .where("id", "=", input.grantId)
    .where("workspaceId", "=", input.workspaceId)
    .execute()

  const updatedAccessRows = await listAccessRows(input.installationId)
  const updatedAccessRow = updatedAccessRows.find(
    (entry) => entry.id === input.grantId
  )
  if (!updatedAccessRow) {
    throw new McpPluginError(404, "Access grant not found")
  }

  return mapAccessRowToGrant(updatedAccessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride:
      installation.conversationTypeMaskOverride ?? null,
  })
}

export async function revokePluginInstallationGrant(input: {
  workspaceId: string
  installationId: string
  grantId: string
}) {
  const accessRows = await listAccessRows(input.installationId, true)
  const accessRow = accessRows.find((entry) => entry.id === input.grantId)
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new McpPluginError(404, "Access grant not found")
  }
  if (accessRow.status === "revoked") {
    return mapAccessRowToGrant(accessRow)
  }

  await revokeWorkspaceAppGrant(db as any, accessRow.id)

  await incrementMcpVersion(input.workspaceId)

  return {
    id: accessRow.id,
    revoked: true,
  }
}

export async function createPluginInstallPlan(input: {
  workspaceId: string
  pluginId: string
}) {
  const plugin = await getPlugin(input.pluginId)
  return {
    packageId: plugin.id,
    revisionId: (await getPluginCatalogRowByItemId(plugin.id))!.versionId,
    workspaceId: input.workspaceId,
    checks: [],
    grantPlan: buildPluginGrantPlan({
      authorization: plugin.authorization,
    }),
  }
}

export function validateConfig(
  config: Record<string, unknown>,
  rules: McpValidationRule[]
) {
  const errors: { field: string; message: string }[] = []

  for (const rule of rules) {
    const value = config[rule.field]
    switch (rule.rule) {
      case "required":
        if (isConfigValueMissing(value)) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case "pattern":
        if (
          typeof value === "string" &&
          rule.value &&
          !new RegExp(rule.value as string).test(value)
        ) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case "url":
        if (typeof value === "string" && value) {
          try {
            new URL(value)
          } catch {
            errors.push({ field: rule.field, message: rule.message })
          }
        }
        break
      case "min_length":
        if (typeof value === "string" && value.length < Number(rule.value)) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case "max_length":
        if (typeof value === "string" && value.length > Number(rule.value)) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case "prefix":
        if (
          typeof value === "string" &&
          !value.startsWith(String(rule.value || ""))
        ) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case "enum":
        if (
          Array.isArray(rule.value) &&
          !rule.value.includes(value as string)
        ) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
    }
  }

  return { valid: errors.length === 0, errors }
}

export async function seedBuiltinMcpPlugins() {
  await seedBuiltinPluginCategories()

  for (const seed of builtinSeeds) {
    const publisher = await createOrganization({
      slug: seed.slug,
      displayName: seed.displayName,
      description: seed.description,
      isBuiltin: true,
      isVerified: true,
    })

    for (const pluginSeed of seed.plugins) {
      let icon: { id: string } | null = null
      if (pluginSeed.iconAssetPath) {
        try {
          icon = await ensureBuiltinPluginIcon(
            seed.slug,
            pluginSeed.slug,
            pluginSeed.iconAssetPath
          )
        } catch (error) {
          log.warn(
            { err: error },
            `[builtin-mcp] Failed to persist icon for ${seed.slug}/${pluginSeed.slug}; continuing without icon`
          )
        }
      }

      await createPlugin({
        orgId: publisher.id,
        slug: pluginSeed.slug,
        displayName: pluginSeed.displayName,
        description: pluginSeed.description,
        longDescription: pluginSeed.longDescription,
        iconFileId: icon?.id,
        transport: pluginSeed.transport,
        entryPoint: pluginSeed.entryPoint,
        lifecycleScope: pluginSeed.defaultReuseScope,
        supportedReuseScopes: pluginSeed.supportedReuseScopes,
        requiresHandshake: pluginSeed.requiresHandshake,
        tags: pluginSeed.tags,
        categorySlugs: pluginSeed.categorySlugs,
        isBuiltin: true,
        toolsManifest: pluginSeed.toolsManifest,
        configSchema: pluginSeed.configSchema,
        configFields: pluginSeed.configFields,
        defaultConfig: pluginSeed.defaultConfig,
        validationRules: pluginSeed.validationRules,
        setupSteps: pluginSeed.setupSteps,
        installFlow: pluginSeed.installFlow,
        authBindings: pluginSeed.authBindings,
        displayNameI18n: pluginSeed.displayNameI18n,
        descriptionI18n: pluginSeed.descriptionI18n,
        longDescriptionI18n: pluginSeed.longDescriptionI18n,
        summaryI18n: pluginSeed.summaryI18n,
        defaultLocale: pluginSeed.defaultLocale,
        authorization: pluginSeed.authorization,
      })
    }
  }
}

export async function seedBuiltinPluginCategories() {
  for (const category of builtinCapabilityCategories) {
    if (category.targetKind !== "plugin") continue
    await db
      .insertInto("catalogCategories")
      .values({
        slug: category.slug,
        itemKind: "plugin_package",
        displayName: category.displayName,
        description: category.description || "",
        sortOrder: category.sortOrder,
        metadata: {
          displayNameI18n: category.displayNameI18n || {
            en: category.displayName,
          },
          descriptionI18n: category.descriptionI18n || {
            en: category.description || "",
          },
          defaultLocale: category.defaultLocale || "en",
        } as CatalogCategoriesMetadata,
      })
      .onConflict((oc) =>
        oc.columns(["itemKind", "slug"]).doUpdateSet({
          displayName: category.displayName,
          description: category.description || "",
          sortOrder: category.sortOrder,
          metadata: {
            displayNameI18n: category.displayNameI18n || {
              en: category.displayName,
            },
            descriptionI18n: category.descriptionI18n || {
              en: category.description || "",
            },
            defaultLocale: category.defaultLocale || "en",
          } as CatalogCategoriesMetadata,
        })
      )
      .execute()
  }
}
