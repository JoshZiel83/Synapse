import crypto from "node:crypto"
import fs from "node:fs/promises"
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  FILE_ORIGIN_SYSTEMS,
  ACCESS_BINDING_STATUS,
  MARKETPLACE_ITEM_KIND,
  MCP_VALIDATION_RULE_KIND,
  PLUGIN_INSTALLATION_STATUS,
  WORKSPACE_APP_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_STATUS,
  actorRef,
  conversationRef,
  normalizeConversationTypeMask,
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
import { nowIsoInstant } from "@synapse/shared/datetime"
import type {
  CapabilityAccessTarget,
  WorkspaceAppGrant,
  WorkspaceAppGrantTargetInput,
} from "@synapse/shared/types"
import type {
  AccessBindingStatus,
  PluginAuthBindingDefinition,
  PluginConfigFieldDefinition,
  PluginInstallFlow,
  PluginSpecTransport,
  ReuseScope,
  McpSetupStep,
  McpValidationRule,
  PluginReuseScopeV2,
  RuntimeBindingScope,
  WorkspaceAppGrantSource,
} from "@synapse/shared"
import { encryptSensitiveFields } from "../../infrastructure/crypto/index.js"
import { createLogger } from "../../infrastructure/logger/index.js"
import { getWorkspaceCapabilityConversationTypeMask } from "../capabilities/conversation-type-policies.js"
import { type Executor } from "../../infrastructure/database/kysely.js"
import {
  presentInstant,
  presentOptionalInstant,
  presentInstallationAccessGrant,
  presentPluginCatalogRecord,
  type PluginCatalogRecord,
  type PluginInstallationDetailRecord,
} from "./presenter.js"
import {
  createMcpPluginQueryRunner,
  createPluginPublisherRecord,
  assignPluginCategories,
  ensureCatalogItem,
  findBuiltinPluginIconFileAsset,
  findPluginInstallationWorkspace,
  getPluginCatalogRowByItemId,
  getPluginPublisherRecord,
  getPluginPublisherRecordBySlug,
  getActivePluginConnectionPublicPayload,
  hasBuiltinPluginFilesTable,
  incrementPluginCatalogDownloadCount,
  insertPluginInstallationRecord,
  insertPluginSourceRefRecord,
  listPluginCategoryRecords,
  listPluginCatalogRowsByVersionIds,
  listPluginInstallationAccessRows as listAccessRows,
  listPluginPublisherRecords,
  listPublicPluginCatalogRows,
  loadInstallationRows,
  revokePluginConnectionsForInstallation,
  revokePluginWorkspaceAppGrant,
  updatePluginInstallationConfigData,
  updatePluginInstallationGrantConversationTypeMask,
  updatePluginInstallationReuseScope,
  upsertBuiltinPluginCategory,
  upsertPluginVersion,
  validateMcpPluginConversationScopedAccessTarget,
  withMcpPluginTransaction,
  type InstallationAccessRow,
  type InstallationRow,
  type PluginCatalogRow,
} from "./repo.js"
import type {
  CatalogCategoriesMetadata,
  PluginCategoryRecord,
  PublisherRecord,
} from "./repo.types.js"
import { emitEvent } from "../../infrastructure/events/index.js"
import { saveFromBuffer } from "../../infrastructure/storage/file-io.js"
import { buildPlatformAssetOrigin } from "../files/service.js"
import { attachAuthConnectionsToConfig } from "./plugin-auth-connections.js"
import { incrementMcpVersion } from "./runtime-version.js"
import { builtinCapabilityCategories } from "./builtin-plugins/categories.js"
import { builtinSeeds } from "./builtin-plugins/index.js"
import {
  assertFeishuFeatureSelection,
  assertFeishuScopesForFeatures,
  normalizeFeishuFeatureKeys,
} from "./feishu/features.js"
import { parseFeishuAuthConnectionRef } from "./feishu/config.js"
import {} from "../access/bindings.js"
import { resolveAccessGrantTarget } from "../access/access-target-resolver.js"
import {
  insertWorkspaceAppRoot,
  updateWorkspaceAppRoot,
} from "../workspace-apps/repo.js"
import {
  insertWorkspaceAppGrant,
  revokeWorkspaceAppGrantsForApp,
} from "../workspace-apps/grant-storage.js"
import {} from "../access/binding-storage.js"
import {
  assertConversationTypeMaskWithinParent,
  assertGrantConversationTypeOverrideAllowed,
} from "../access/policy.js"

export type { InstallationAccessRow } from "./repo.js"

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

function asArray<T>(value: unknown): T[] {
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

  const existing = await findBuiltinPluginIconFileAsset({ key, sha256 })
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
export function installationAccessRowToTarget(
  row: InstallationAccessRow
): WorkspaceAppGrantTargetInput {
  switch (row.accessTargetType) {
    case "workspace":
      return { subject: workspaceRef(row.workspaceId) }
    case "workspace_member":
      return row.workspaceMemberId
        ? { subject: workspaceMemberRef(row.workspaceMemberId) }
        : { subject: workspaceRef(row.workspaceId) }
    case "conversation":
      return row.conversationId
        ? { subject: conversationRef(row.conversationId) }
        : { subject: workspaceRef(row.workspaceId) }
    case "actor":
      return row.actorId
        ? {
            subject: actorRef(row.actorId),
            ...(row.conversationId
              ? { scope: conversationRef(row.conversationId) }
              : {}),
          }
        : { subject: workspaceRef(row.workspaceId) }
    case "remote_agent":
      return row.remoteAgentId
        ? {
            subject: remoteAgentRef(row.remoteAgentId),
            ...(row.conversationId
              ? { scope: conversationRef(row.conversationId) }
              : {}),
          }
        : { subject: workspaceRef(row.workspaceId) }
  }
}

function buildInstallationAccessRow(input: {
  id: string
  workspaceId: string
  installationId: string
  target: CapabilityAccessTarget
  conversationTypeMaskOverride: number | null
  status: AccessBindingStatus
  source: WorkspaceAppGrantSource
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
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    accessTargetType,
    actorId,
    remoteAgentId,
    conversationId,
    workspaceMemberId,
    conversationTypeMaskOverride: input.conversationTypeMaskOverride,
    status: input.status,
    source: input.source,
    createdByWorkspaceMemberId: input.createdByWorkspaceMemberId,
    reason: input.reason,
    createdAt: input.createdAt,
    revokedAt: input.revokedAt,
  }
}

async function loadPluginCatalogMapByVersionIds(versionIds: string[]) {
  const rows = await listPluginCatalogRowsByVersionIds(versionIds)
  return new Map(
    rows.map((row) => [row.versionId!, presentPluginCatalogRecord(row)])
  )
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

// Row→WorkspaceAppGrant View builder lives in ./presenter.ts as
// presentInstallationAccessGrant (it serializes Date→ISO + is a row→DTO mapper —
// guard r3/r4 confine that to the presenter); called directly at its 6 sites
// below. round-6 P1-7.

async function getInstallationPayload(
  workspaceId: string,
  installationId: string
): Promise<PluginInstallationDetailRecord> {
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
      WORKSPACE_APP_KIND.PLUGIN_INSTALLATION
    )

  return {
    row,
    plugin,
    workspaceConversationTypeMask,
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
  return createPluginPublisherRecord({
    ...data,
    slug: normalizedSlug,
  })
}

export async function listOrganizations(): Promise<PublisherRecord[]> {
  return listPluginPublisherRecords()
}

export async function getOrganization(
  id: string
): Promise<PublisherRecord | null> {
  const row = await getPluginPublisherRecord(id)
  if (!row) {
    throw new McpPluginError(404, "Publisher not found")
  }

  return row
}

export async function getOrganizationBySlug(
  slug: string
): Promise<PublisherRecord | null> {
  return getPluginPublisherRecordBySlug(sanitizeSlug(slug))
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
}): Promise<PluginCatalogRow> {
  const itemId = await withMcpPluginTransaction(async (client) => {
    const catalogItemId = await ensureCatalogItem(client, data)
    await upsertPluginVersion(client, catalogItemId, data)
    await assignPluginCategories(
      client,
      catalogItemId,
      data.categorySlugs || []
    )
    return catalogItemId
  })

  return getPluginRecord(itemId)
}

export async function listPluginRecords(filters?: {
  orgId?: string
  transport?: string
  search?: string
  tags?: string[]
  categorySlugs?: string[]
}): Promise<PluginCatalogRow[]> {
  return listPublicPluginCatalogRows(filters)
}

export async function listPluginCategories(): Promise<PluginCategoryRecord[]> {
  return listPluginCategoryRecords()
}

export async function getPluginRecord(id: string): Promise<PluginCatalogRow> {
  const row = await getPluginCatalogRowByItemId(id)
  if (!row) {
    throw new McpPluginError(404, "Plugin not found")
  }

  return row
}

async function getPluginCatalogRecordForService(
  id: string
): Promise<PluginCatalogRecord> {
  return presentPluginCatalogRecord(await getPluginRecord(id))
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
}): Promise<PluginInstallationDetailRecord> {
  const plugin = await getPluginCatalogRecordForService(data.pluginId)
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

    const connectionRef = parseFeishuAuthConnectionRef(config.feishuAccount)
    if (!connectionRef) {
      throw new McpPluginError(400, "Feishu account authorization is required.")
    }

    const publicPayload = await getActivePluginConnectionPublicPayload(
      ex,
      connectionRef.connectionId
    )
    if (!publicPayload) {
      throw new McpPluginError(400, "Feishu auth connection not found.")
    }

    try {
      assertFeishuScopesForFeatures(features, publicPayload.scopes)
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error
          ? error.message
          : "Feishu scopes do not match the selected features."
      )
    }
  }

  const result = await withMcpPluginTransaction(async (client) => {
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
      kind: WORKSPACE_APP_KIND.PLUGIN_INSTALLATION,
      displayName: plugin.displayName,
      ownerWorkspaceMemberId: data.installedByWorkspaceMemberId || null,
      status: WORKSPACE_APP_STATUS.ACTIVE,
      conversationTypeMaskOverride: plugin.defaultConversationTypeMask ?? null,
    })
    const insertedInstallationId = await insertPluginInstallationRecord(
      client,
      {
        id: installationId,
        catalogItemId: plugin.id,
        catalogVersionId: catalogVersionId,
        configData: {},
        approvedRuntimePermissions,
        reuseScope: internalReuseScope(lifecycleScope),
      }
    )
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
      run: createMcpPluginQueryRunner(client),
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

    await updatePluginInstallationConfigData(
      client,
      installationId,
      encryptedConfig
    )

    await insertPluginSourceRefRecord(client, {
      installationId: installationId,
      sourceCatalogItemId: plugin.id,
      sourceCatalogVersionId: catalogVersionId,
      syncMode: "manual_merge",
    })

    await incrementPluginCatalogDownloadCount(client, plugin.id)

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
  await revokePluginConnectionsForInstallation(client, installId)
  await updateWorkspaceAppRoot(client, {
    id: installId,
    status: WORKSPACE_APP_STATUS.ARCHIVED,
    deletedAt: new Date(),
  })

  // Root lifecycle lives on workspace_apps. The detail row stays until purge.
}

export async function uninstallPluginUnified(installId: string) {
  const installation = await findPluginInstallationWorkspace(installId)
  if (!installation) {
    throw new McpPluginError(404, "Installation not found")
  }
  await withMcpPluginTransaction((client) =>
    tearDownPluginInstallationOn(client, installId)
  )

  await incrementMcpVersion(installation.workspaceId)

  return {
    id: installId,
    workspace_id: installation.workspaceId,
  }
}

export async function getInstallations(
  workspaceId: string,
  filters?: {
    installationIds?: string[]
    pluginId?: string
  }
): Promise<PluginInstallationDetailRecord[]> {
  const rows = await loadInstallationRows(workspaceId, filters)
  const pluginsByVersionId = await loadPluginCatalogMapByVersionIds(
    Array.from(new Set(rows.map((row) => row.catalogVersionId)))
  )
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      workspaceId,
      WORKSPACE_APP_KIND.PLUGIN_INSTALLATION
    )

  return rows.flatMap((row) => {
    const plugin = pluginsByVersionId.get(row.catalogVersionId)
    return plugin ? [{ row, plugin, workspaceConversationTypeMask }] : []
  })
}

export async function getInstallation(
  workspaceId: string,
  installId: string
): Promise<PluginInstallationDetailRecord> {
  return getInstallationPayload(workspaceId, installId)
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
): Promise<PluginInstallationDetailRecord> {
  const currentRow = await findPluginInstallationWorkspace(installId)
  if (!currentRow) {
    throw new McpPluginError(404, "Installation not found")
  }

  const workspaceId = currentRow.workspaceId
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
        row.configData,
        data.configData,
        plugin.configFields || []
      )
    : row.configData

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
      await validateMcpPluginConversationScopedAccessTarget({
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

    const connectionRef = parseFeishuAuthConnectionRef(config.feishuAccount)
    if (!connectionRef) {
      throw new McpPluginError(400, "Feishu account authorization is required.")
    }

    const publicPayload = await getActivePluginConnectionPublicPayload(
      ex,
      connectionRef.connectionId
    )
    if (!publicPayload) {
      throw new McpPluginError(400, "Feishu auth connection not found.")
    }

    try {
      assertFeishuScopesForFeatures(features, publicPayload.scopes)
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error
          ? error.message
          : "Feishu scopes do not match the selected features."
      )
    }
  }

  await withMcpPluginTransaction(async (client) => {
    const run = createMcpPluginQueryRunner(client)

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
      await updatePluginInstallationConfigData(
        client,
        installId,
        encryptedConfig
      )
    }

    if (data.isEnabled !== undefined) {
      // root-only status source; no detail-table status update remains
    }

    if (data.lifecycleScope) {
      await updatePluginInstallationReuseScope(
        client,
        installId,
        internalReuseScope(nextLifecycleScope)
      )
    }

    if (data.conversationTypeMaskOverride !== undefined) {
      // root-only conversation-type policy source; no detail-table override update remains
    }

    await updateWorkspaceAppRoot(client, {
      id: installId,
      displayName: row.rootDisplayName,
      status:
        data.isEnabled === undefined
          ? row.rootStatus === PLUGIN_INSTALLATION_STATUS.ACTIVE
            ? WORKSPACE_APP_STATUS.ACTIVE
            : row.rootStatus === PLUGIN_INSTALLATION_STATUS.DISABLED
              ? WORKSPACE_APP_STATUS.DISABLED
              : WORKSPACE_APP_STATUS.ERROR
          : data.isEnabled
            ? WORKSPACE_APP_STATUS.ACTIVE
            : WORKSPACE_APP_STATUS.DISABLED,
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
  const { row, plugin, workspaceConversationTypeMask } =
    await getInstallationPayload(workspaceId, installationId)
  const conversationTypeMaskOverride =
    row.rootConversationTypeMaskOverride ?? null
  const sourceDefaultConversationTypeMask = normalizeConversationTypeMask(
    plugin.defaultConversationTypeMask,
    DEFAULT_CONVERSATION_TYPE_MASK
  )
  const effectiveConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    conversationTypeMaskOverride
  )
  const accessRows = await listAccessRows(installationId)
  const grants = accessRows
    .filter((binding) => binding.status === ACCESS_BINDING_STATUS.ACTIVE)
    .map((binding) =>
      presentInstallationAccessGrant(binding, {
        workspaceConversationTypeMask,
        instanceConversationTypeMaskOverride: conversationTypeMaskOverride,
      })
    )

  return {
    grants,
    summary: {
      requiredPermissions: plugin.authorization?.requiredPermissions || [],
      suggestedAccessTargetType: "workspace",
      sourceDefaultConversationTypeMask,
      workspaceConversationTypeMask,
      conversationTypeMaskOverride,
      effectiveConversationTypeMask,
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
  const { row, plugin, workspaceConversationTypeMask } =
    await getInstallationPayload(input.workspaceId, input.installationId)
  const conversationTypeMaskOverride =
    row.rootConversationTypeMaskOverride ?? null
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
    conversationTypeMaskOverride
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
  await validateMcpPluginConversationScopedAccessTarget({
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
      entry.status === ACCESS_BINDING_STATUS.ACTIVE &&
      entry.accessTargetType === accessTargetLabel &&
      entry.actorId === accessTargetActorId &&
      entry.remoteAgentId === accessTargetRemoteAgentId &&
      entry.conversationId === accessTargetConversationId &&
      entry.workspaceMemberId === accessTargetWorkspaceMemberId
  )
  if (existing) {
    return presentInstallationAccessGrant(existing, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride: conversationTypeMaskOverride,
    })
  }

  const result = await withMcpPluginTransaction(async (client) => {
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
      createdAt: inserted.createdAt,
      revokedAt: inserted.revokedAt,
    })
    return {
      accessRow,
    }
  })

  await incrementMcpVersion(input.workspaceId)

  return presentInstallationAccessGrant(result.accessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride: conversationTypeMaskOverride,
  })
}

export async function updatePluginInstallationGrant(input: {
  workspaceId: string
  installationId: string
  grantId: string
  conversationTypeMaskOverride?: number | null
}) {
  if (input.conversationTypeMaskOverride === undefined) {
    const { row, workspaceConversationTypeMask } = await getInstallationPayload(
      input.workspaceId,
      input.installationId
    )
    const conversationTypeMaskOverride =
      row.rootConversationTypeMaskOverride ?? null
    const accessRows = await listAccessRows(input.installationId)
    const accessRow = accessRows.find((entry) => entry.id === input.grantId)
    if (!accessRow || accessRow.workspaceId !== input.workspaceId) {
      throw new McpPluginError(404, "Access grant not found")
    }
    return presentInstallationAccessGrant(accessRow, {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride: conversationTypeMaskOverride,
    })
  }

  const { row, workspaceConversationTypeMask } = await getInstallationPayload(
    input.workspaceId,
    input.installationId
  )
  const conversationTypeMaskOverride =
    row.rootConversationTypeMaskOverride ?? null
  const accessRows = await listAccessRows(input.installationId, true)
  const accessRow = accessRows.find((entry) => entry.id === input.grantId)
  if (!accessRow || accessRow.workspaceId !== input.workspaceId) {
    throw new McpPluginError(404, "Access grant not found")
  }
  const instanceConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    conversationTypeMaskOverride
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
  await validateMcpPluginConversationScopedAccessTarget({
    target: accessRowTarget,
    effectiveConversationTypeMask,
    buildError: (message) => new McpPluginError(400, message),
  })

  await updatePluginInstallationGrantConversationTypeMask({
    workspaceId: input.workspaceId,
    grantId: input.grantId,
    conversationTypeMaskOverride: input.conversationTypeMaskOverride ?? null,
  })

  const updatedAccessRows = await listAccessRows(input.installationId)
  const updatedAccessRow = updatedAccessRows.find(
    (entry) => entry.id === input.grantId
  )
  if (!updatedAccessRow) {
    throw new McpPluginError(404, "Access grant not found")
  }

  return presentInstallationAccessGrant(updatedAccessRow, {
    workspaceConversationTypeMask,
    instanceConversationTypeMaskOverride: conversationTypeMaskOverride,
  })
}

export async function revokePluginInstallationGrant(input: {
  workspaceId: string
  installationId: string
  grantId: string
}) {
  const accessRows = await listAccessRows(input.installationId, true)
  const accessRow = accessRows.find((entry) => entry.id === input.grantId)
  if (!accessRow || accessRow.workspaceId !== input.workspaceId) {
    throw new McpPluginError(404, "Access grant not found")
  }
  if (accessRow.status === ACCESS_BINDING_STATUS.REVOKED) {
    return presentInstallationAccessGrant(accessRow)
  }

  await revokePluginWorkspaceAppGrant(accessRow.id)

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
  const plugin = await getPluginCatalogRecordForService(input.pluginId)
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
      case MCP_VALIDATION_RULE_KIND.REQUIRED:
        if (isConfigValueMissing(value)) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case MCP_VALIDATION_RULE_KIND.PATTERN:
        if (
          typeof value === "string" &&
          rule.value &&
          !new RegExp(rule.value as string).test(value)
        ) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case MCP_VALIDATION_RULE_KIND.URL:
        if (typeof value === "string" && value) {
          try {
            new URL(value)
          } catch {
            errors.push({ field: rule.field, message: rule.message })
          }
        }
        break
      case MCP_VALIDATION_RULE_KIND.MIN_LENGTH:
        if (typeof value === "string" && value.length < Number(rule.value)) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case MCP_VALIDATION_RULE_KIND.MAX_LENGTH:
        if (typeof value === "string" && value.length > Number(rule.value)) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case MCP_VALIDATION_RULE_KIND.PREFIX:
        if (
          typeof value === "string" &&
          !value.startsWith(String(rule.value || ""))
        ) {
          errors.push({ field: rule.field, message: rule.message })
        }
        break
      case MCP_VALIDATION_RULE_KIND.ENUM:
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
    if (category.targetKind !== MARKETPLACE_ITEM_KIND.PLUGIN) continue
    const metadata = {
      displayNameI18n: category.displayNameI18n || {
        en: category.displayName,
      },
      descriptionI18n: category.descriptionI18n || {
        en: category.description || "",
      },
      defaultLocale: category.defaultLocale || "en",
    } as CatalogCategoriesMetadata
    await upsertBuiltinPluginCategory({
      slug: category.slug,
      displayName: category.displayName,
      description: category.description,
      sortOrder: category.sortOrder,
      metadata,
    })
  }
}
