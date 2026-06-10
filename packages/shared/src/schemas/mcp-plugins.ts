import { z } from "zod"
import { PLUGIN_SPEC_TRANSPORTS, REUSE_SCOPES } from "../constants/enums.js"
import type {
  McpSetupStep,
  McpValidationRule,
  PluginAuthBindingDefinition,
  PluginConfigFieldDefinition,
  PluginConfigFieldState,
  PluginInstallFlow,
} from "../types/index.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the MCP plugin marketplace + installations.
 *
 * Source of truth for the responses of the mcp marketplace / categories /
 * organizations / installations endpoints; the api presenter (service.ts)
 * builds these from DB rows, web parses them. camelCase end-to-end (Phase 6
 * §8.1). See docs/architecture-boundary-refactor-master-plan.md.
 *
 * Complex nested shapes (config fields, auth bindings, validation rules, setup
 * steps, install flow, config state) reuse the shared interfaces via
 * `z.custom<T>()` — their values are produced verbatim by the presenter and
 * already carry those types; re-deriving full nested zod schemas here would
 * duplicate large definitions without adding wire-level guarantees.
 */

const localizedTextSchema = z.record(z.string(), z.string())

/** Authorization summary derived from a plugin version's runtime permissions. */
export const PluginAuthorizationViewSchema = z.strictObject({
  requiredPermissions: z.array(z.string()),
  reason: z.string().optional(),
})
export type PluginAuthorizationView = z.infer<
  typeof PluginAuthorizationViewSchema
>

/** A plugin category as surfaced inside a marketplace plugin view. */
export const MarketplacePluginCategoryViewSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  displayNameI18n: localizedTextSchema,
  descriptionI18n: localizedTextSchema,
  defaultLocale: z.string(),
})
export type MarketplacePluginCategoryView = z.infer<
  typeof MarketplacePluginCategoryViewSchema
>

/** Inline publisher summary embedded in a marketplace plugin view. */
export const MarketplacePluginPublisherSummarySchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  isVerified: z.boolean(),
})
export type MarketplacePluginPublisherSummary = z.infer<
  typeof MarketplacePluginPublisherSummarySchema
>

/**
 * App-facing contract for a marketplace plugin package (catalog item + its
 * latest version spec, publisher, categories).
 */
export const MarketplacePluginViewSchema = z.strictObject({
  id: z.string(),
  orgId: z.string(),
  slug: z.string(),
  displayName: z.string(),
  displayNameI18n: localizedTextSchema,
  description: z.string(),
  descriptionI18n: localizedTextSchema,
  longDescription: z.string(),
  longDescriptionI18n: localizedTextSchema,
  summaryI18n: localizedTextSchema,
  defaultLocale: z.string(),
  iconUrl: z.string().nullable(),
  version: z.string(),
  transport: z.enum(PLUGIN_SPEC_TRANSPORTS),
  entryPoint: z.string(),
  lifecycleScope: z.enum(REUSE_SCOPES),
  defaultReuseScope: z.enum(REUSE_SCOPES),
  defaultConversationTypeMask: z.number().int(),
  supportedReuseScopes: z.array(z.enum(REUSE_SCOPES)),
  configSchema: z.record(z.string(), z.unknown()),
  configFields: z.array(z.custom<PluginConfigFieldDefinition>()),
  defaultConfig: z.record(z.string(), z.unknown()),
  toolsManifest: z.array(z.unknown()),
  validationRules: z.array(z.custom<McpValidationRule>()),
  setupSteps: z.array(z.custom<McpSetupStep>()),
  installFlow: z.custom<PluginInstallFlow>(),
  authBindings: z.array(z.custom<PluginAuthBindingDefinition>()),
  authorization: PluginAuthorizationViewSchema,
  tags: z.array(z.string()),
  categories: z.array(MarketplacePluginCategoryViewSchema),
  categorySlugs: z.array(z.string()),
  isActive: z.boolean(),
  isBuiltin: z.boolean(),
  downloadCount: z.number().int(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  orgSlug: z.string(),
  orgDisplayName: z.string(),
  publisher: MarketplacePluginPublisherSummarySchema,
  requiresHandshake: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
})
export type MarketplacePluginView = z.infer<typeof MarketplacePluginViewSchema>

/** App-facing contract for a marketplace publisher / organization. */
export const MarketplacePublisherViewSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  logoUrl: z.string().nullable(),
  isBuiltin: z.boolean(),
  isVerified: z.boolean(),
  ownerUserId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  pluginCount: z.number().int(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type MarketplacePublisherView = z.infer<
  typeof MarketplacePublisherViewSchema
>

/** App-facing contract for a top-level plugin category (catalog listing). */
export const PluginCategoryViewSchema = z.strictObject({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  description: z.string(),
  displayNameI18n: localizedTextSchema,
  descriptionI18n: localizedTextSchema,
  defaultLocale: z.string(),
  sortOrder: z.number().int(),
})
export type PluginCategoryView = z.infer<typeof PluginCategoryViewSchema>

/**
 * App-facing contract for an installed plugin (root + resolved plugin metadata,
 * sanitized config + per-field config state).
 */
export const PluginInstallationDetailViewSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  pluginId: z.string(),
  lifecycleScope: z.enum(REUSE_SCOPES),
  defaultReuseScope: z.enum(REUSE_SCOPES),
  sourceDefaultConversationTypeMask: z.number().int(),
  workspaceConversationTypeMask: z.number().int(),
  conversationTypeMaskOverride: z.number().int().nullable(),
  effectiveConversationTypeMask: z.number().int(),
  supportedReuseScopes: z.array(z.enum(REUSE_SCOPES)),
  isEnabled: z.boolean(),
  status: z.enum(["active", "disabled", "error", "archived"]),
  configData: z.record(z.string(), z.unknown()),
  configState: z.array(z.custom<PluginConfigFieldState>()),
  approvedRuntimePermissions: z.array(z.string()),
  ownerWorkspaceMemberId: z.string().nullable(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  sourceCatalogItemId: z.string().nullable(),
  sourceCatalogVersionId: z.string().nullable(),
  sourceSyncMode: z
    .enum(["notify", "manual_merge", "follow_upstream", "detached"])
    .nullable(),
  pluginSlug: z.string(),
  pluginDisplayName: z.string(),
  pluginDescription: z.string(),
  pluginDisplayNameI18n: localizedTextSchema,
  pluginDescriptionI18n: localizedTextSchema,
  pluginLongDescriptionI18n: localizedTextSchema,
  pluginSummaryI18n: localizedTextSchema,
  defaultLocale: z.string(),
  transport: z.enum(PLUGIN_SPEC_TRANSPORTS),
  pluginLifecycleScope: z.enum(REUSE_SCOPES),
  pluginDefaultReuseScope: z.enum(REUSE_SCOPES),
  pluginSupportedReuseScopes: z.array(z.enum(REUSE_SCOPES)),
  toolsManifest: z.array(z.unknown()),
  pluginIconUrl: z.string().nullable(),
  pluginCategories: z.array(MarketplacePluginCategoryViewSchema),
  pluginCategorySlugs: z.array(z.string()),
  pluginVersion: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  configFields: z.array(z.custom<PluginConfigFieldDefinition>()),
  installFlow: z.custom<PluginInstallFlow>(),
  authBindings: z.array(z.custom<PluginAuthBindingDefinition>()),
  isBuiltin: z.boolean(),
  pluginValidationRules: z.array(z.custom<McpValidationRule>()),
  pluginSetupSteps: z.array(z.custom<McpSetupStep>()),
  orgId: z.string(),
  orgSlug: z.string(),
  orgDisplayName: z.string(),
  authorization: PluginAuthorizationViewSchema,
  revision: z.strictObject({
    authorization: PluginAuthorizationViewSchema,
  }),
})
export type PluginInstallationDetailView = z.infer<
  typeof PluginInstallationDetailViewSchema
>
