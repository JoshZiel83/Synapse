import { z } from "zod"
import {
  CAPABILITY_ACCESS_TARGET_TYPES,
  MARKETPLACE_REQUIREMENT_KINDS,
  MARKETPLACE_REQUIREMENT_STATUSES,
  MARKETPLACE_SYNC_MODES,
  MCP_VALIDATION_RULE_KINDS,
  PLUGIN_AUTH_BINDING_DRIVER_KINDS,
  PLUGIN_AUTH_CHALLENGE_KINDS,
  PLUGIN_AUTH_CHALLENGE_OPEN_MODES,
  PLUGIN_AUTH_DERIVED_VALUE_NAMES,
  PLUGIN_AUTH_SESSION_STATUSES,
  PLUGIN_AUTH_SESSION_PHASES,
  PLUGIN_AUTH_VALUE_SOURCE_KINDS,
  PLUGIN_CONFIG_FIELD_TYPES,
  PLUGIN_INSTALLATION_STATUSES,
  PLUGIN_INSTALL_ACTION_KINDS,
  PLUGIN_INSTALL_STEP_KINDS,
  PLUGIN_INSTALL_STEP_SCOPES,
  PLUGIN_SPEC_TRANSPORTS,
  REUSE_SCOPES,
} from "../constants/enums.js"
import { IsoInstantStringSchema } from "./datetime.js"

/**
 * App-facing contracts for the MCP plugin marketplace + installations.
 *
 * Source of truth for the responses of the mcp marketplace / categories /
 * organizations / installations endpoints; the api presenter (service.ts)
 * builds these from DB rows, web parses them. camelCase end-to-end (Phase 6
 * §8.1). See docs/architecture-boundary-refactor-master-plan.md.
 *
 * The nested shapes we own (config fields, options, auth bindings, validation
 * rules, setup/install steps, install flow, config state) are validated with
 * real zod schemas below; their inferred types are the single source of truth
 * for the corresponding shared interfaces. Genuinely open / third-party-opaque
 * payloads (config schema, default config, tool manifests, provider metadata)
 * stay permissive (`z.record(z.string(), z.unknown())` / `z.array(z.unknown())`)
 * — see the inline comments on each.
 */

const localizedTextSchema = z.record(z.string(), z.string())

/**
 * Nested object shapes below intentionally use `z.object` (not `z.strictObject`)
 * because the presenter forwards these values verbatim from stored jsonb
 * (`spec_install_flow`, `spec_auth_bindings`, `specMetadata.configFields`, …);
 * unknown keys are stripped rather than rejected so a forward-compatible row
 * never trips a consumer parse. Known fields are still validated strictly.
 */

/** A single selectable option for a `select` / `multiselect` config field. */
export const PluginConfigFieldOptionSchema = z.object({
  value: z.string(),
  labelI18n: localizedTextSchema,
  descriptionI18n: localizedTextSchema.optional(),
})
export type PluginConfigFieldOption = z.infer<
  typeof PluginConfigFieldOptionSchema
>

/** Declarative definition of one plugin config field (form input). */
export const PluginConfigFieldDefinitionSchema = z.object({
  key: z.string(),
  type: z.enum(PLUGIN_CONFIG_FIELD_TYPES),
  titleI18n: localizedTextSchema,
  descriptionI18n: localizedTextSchema.optional(),
  placeholderI18n: localizedTextSchema.optional(),
  required: z.boolean().optional(),
  // Field default; type depends on `type` (string/number/boolean/array). Opaque.
  defaultValue: z.unknown().optional(),
  options: z.array(PluginConfigFieldOptionSchema).optional(),
  secret: z.boolean().optional(),
  serverManaged: z.boolean().optional(),
  authBindingKey: z.string().optional(),
  // Open validation descriptor map owned by the plugin author. Opaque.
  validation: z.record(z.string(), z.unknown()).optional(),
  // Open author-supplied metadata. Opaque.
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type PluginConfigFieldDefinition = z.infer<
  typeof PluginConfigFieldDefinitionSchema
>

/** Action attached to an install step (e.g. start an auth flow / open a link). */
export const PluginInstallActionSchema = z.object({
  kind: z.enum(PLUGIN_INSTALL_ACTION_KINDS),
  bindingKey: z.string().optional(),
  url: z.string().optional(),
  buttonLabelI18n: localizedTextSchema.optional(),
  // Open author-supplied metadata. Opaque.
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type PluginInstallAction = z.infer<typeof PluginInstallActionSchema>

/** One step in a plugin's guided install flow. */
export const PluginInstallStepSchema = z.object({
  id: z.string(),
  kind: z.enum(PLUGIN_INSTALL_STEP_KINDS),
  titleI18n: localizedTextSchema,
  descriptionI18n: localizedTextSchema.optional(),
  scope: z.enum(PLUGIN_INSTALL_STEP_SCOPES),
  fields: z.array(z.string()),
  optional: z.boolean().optional(),
  helpUrl: z.string().optional(),
  helpTextI18n: localizedTextSchema.optional(),
  action: PluginInstallActionSchema.optional(),
  // Open author-supplied metadata. Opaque.
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type PluginInstallStep = z.infer<typeof PluginInstallStepSchema>

/** The full guided install flow (ordered steps) for a plugin. */
export const PluginInstallFlowSchema = z.object({
  steps: z.array(PluginInstallStepSchema),
})
export type PluginInstallFlow = z.infer<typeof PluginInstallFlowSchema>

/**
 * Where an auth binding draws an input value from (config field, env var,
 * literal, or a server-derived value such as the OAuth callback URL).
 */
export const PluginAuthValueSourceSchema = z.object({
  source: z.enum(PLUGIN_AUTH_VALUE_SOURCE_KINDS),
  field: z.string().optional(),
  env: z.string().optional(),
  // Literal value; type depends on the binding input. Opaque.
  value: z.unknown().optional(),
  name: z.enum(PLUGIN_AUTH_DERIVED_VALUE_NAMES).optional(),
})
export type PluginAuthValueSource = z.infer<typeof PluginAuthValueSourceSchema>

/** Definition of an auth binding (OAuth / QR / CLI driver) for a plugin. */
export const PluginAuthBindingDefinitionSchema = z.object({
  key: z.string(),
  driver: z.enum(PLUGIN_AUTH_BINDING_DRIVER_KINDS),
  fieldKey: z.string(),
  displayNameI18n: localizedTextSchema,
  descriptionI18n: localizedTextSchema.optional(),
  prerequisiteFields: z.array(z.string()).optional(),
  authorizeUrl: z.string().optional(),
  tokenUrl: z.string().optional(),
  userInfoUrl: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  extraAuthorizeParams: z.record(z.string(), z.string()).optional(),
  extraTokenParams: z.record(z.string(), z.string()).optional(),
  profileIdPath: z.string().optional(),
  profileDisplayNamePath: z.string().optional(),
  profileAvatarUrlPath: z.string().optional(),
  reusable: z.boolean().optional(),
  inputs: z.record(z.string(), PluginAuthValueSourceSchema).optional(),
  // Open author-supplied metadata. Opaque.
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type PluginAuthBindingDefinition = z.infer<
  typeof PluginAuthBindingDefinitionSchema
>

/** A server-side validation rule applied to a plugin config field. */
export const McpValidationRuleSchema = z.object({
  field: z.string(),
  rule: z.enum(MCP_VALIDATION_RULE_KINDS),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  message: z.string(),
})
export type McpValidationRule = z.infer<typeof McpValidationRuleSchema>

/**
 * A setup step surfaced to the install UI. Looser than {@link PluginInstallStep}
 * (kind/title are optional and plain-text title/description/help are allowed)
 * because setup steps can be authored without i18n bundles.
 */
export const McpSetupStepSchema = z.object({
  id: z.string(),
  kind: z.enum(PLUGIN_INSTALL_STEP_KINDS).optional(),
  title: z.string().optional(),
  titleI18n: localizedTextSchema.optional(),
  description: z.string().optional(),
  descriptionI18n: localizedTextSchema.optional(),
  scope: z.enum(PLUGIN_INSTALL_STEP_SCOPES),
  fields: z.array(z.string()),
  optional: z.boolean().optional(),
  helpUrl: z.string().optional(),
  helpText: z.string().optional(),
  helpTextI18n: localizedTextSchema.optional(),
  action: PluginInstallActionSchema.optional(),
  // Open author-supplied metadata. Opaque.
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type McpSetupStep = z.infer<typeof McpSetupStepSchema>

/** Per-field configured/state summary for an installed plugin. */
export const PluginConfigFieldStateSchema = z.object({
  key: z.string(),
  isConfigured: z.boolean(),
  maskedValue: z.string().optional(),
  authConnectionId: z.string().optional(),
  accountDisplayName: z.string().optional(),
  updatedAt: IsoInstantStringSchema.optional(),
})
export type PluginConfigFieldState = z.infer<
  typeof PluginConfigFieldStateSchema
>

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
  // Plugin-author-owned JSON-Schema document describing the config form; its
  // structure is defined by the plugin, not us — kept opaque deliberately. The
  // structured, app-owned view of the form is `configFields` below.
  configSchema: z.record(z.string(), z.unknown()),
  configFields: z.array(PluginConfigFieldDefinitionSchema),
  // Config VALUES keyed by author-defined field names — varies per plugin.
  defaultConfig: z.record(z.string(), z.unknown()),
  // Raw MCP tool definitions (MCP protocol shape, author-supplied). No
  // app-owned contract; passed through opaque.
  toolsManifest: z.array(z.unknown()),
  validationRules: z.array(McpValidationRuleSchema),
  setupSteps: z.array(McpSetupStepSchema),
  installFlow: PluginInstallFlowSchema,
  authBindings: z.array(PluginAuthBindingDefinitionSchema),
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

/** App-facing contract for marketplace plugin list responses. */
export const MarketplacePluginListViewSchema = z.array(
  MarketplacePluginViewSchema
)
export type MarketplacePluginListView = z.infer<
  typeof MarketplacePluginListViewSchema
>

/** App-facing contract for top-level plugin category list responses. */
export const PluginCategoryListViewSchema = z.array(PluginCategoryViewSchema)
export type PluginCategoryListView = z.infer<
  typeof PluginCategoryListViewSchema
>

/** App-facing contract for marketplace publisher list responses. */
export const MarketplacePublisherListViewSchema = z.array(
  MarketplacePublisherViewSchema
)
export type MarketplacePublisherListView = z.infer<
  typeof MarketplacePublisherListViewSchema
>

/** App-facing contract for a publisher detail plus its marketplace plugins. */
export const MarketplacePublisherDetailViewSchema =
  MarketplacePublisherViewSchema.extend({
    plugins: MarketplacePluginListViewSchema,
  })
export type MarketplacePublisherDetailView = z.infer<
  typeof MarketplacePublisherDetailViewSchema
>

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
  status: z.enum(PLUGIN_INSTALLATION_STATUSES),
  // Sanitized config VALUES keyed by author-defined field names — varies per
  // plugin. The structured, app-owned per-field state is `configState` below.
  configData: z.record(z.string(), z.unknown()),
  configState: z.array(PluginConfigFieldStateSchema),
  approvedRuntimePermissions: z.array(z.string()),
  ownerWorkspaceMemberId: z.string().nullable(),
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
  sourceCatalogItemId: z.string().nullable(),
  sourceCatalogVersionId: z.string().nullable(),
  sourceSyncMode: z.enum(MARKETPLACE_SYNC_MODES).nullable(),
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
  // Raw MCP tool definitions (author-supplied MCP protocol shape) — opaque.
  toolsManifest: z.array(z.unknown()),
  pluginIconUrl: z.string().nullable(),
  pluginCategories: z.array(MarketplacePluginCategoryViewSchema),
  pluginCategorySlugs: z.array(z.string()),
  pluginVersion: z.string(),
  // Plugin-author-owned JSON-Schema document — opaque (see configFields for the
  // structured, app-owned form contract).
  configSchema: z.record(z.string(), z.unknown()),
  configFields: z.array(PluginConfigFieldDefinitionSchema),
  installFlow: PluginInstallFlowSchema,
  authBindings: z.array(PluginAuthBindingDefinitionSchema),
  isBuiltin: z.boolean(),
  pluginValidationRules: z.array(McpValidationRuleSchema),
  pluginSetupSteps: z.array(McpSetupStepSchema),
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

/** App-facing contract for installed plugin list responses. */
export const PluginInstallationListViewSchema = z.array(
  PluginInstallationDetailViewSchema
)
export type PluginInstallationListView = z.infer<
  typeof PluginInstallationListViewSchema
>

// ── Auxiliary plugin procedure-flow contracts (auth session / install plan) ──
// These are app-facing (web install-dialog consumes the auth session), so per
// master plan §5.1/§7 (Tier C app surface) they return `{ data }` via sendData.
// The shapes mirror the PluginAuthSession / install-plan domain types in
// ../types/index.ts. Author-owned opaque sub-objects (challenge metadata,
// resultPreview) stay as open records — see the inline notes.

export const PluginAuthChallengeViewSchema = z.strictObject({
  kind: z.enum(PLUGIN_AUTH_CHALLENGE_KINDS),
  url: z.string().optional(),
  qrUrl: z.string().optional(),
  openMode: z.enum(PLUGIN_AUTH_CHALLENGE_OPEN_MODES).optional(),
  expiresAt: IsoInstantStringSchema.optional(),
  // driver-defined challenge metadata; opaque.
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const PluginAuthSessionViewSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  packageId: z.string(),
  revisionId: z.string().optional(),
  bindingKey: z.string(),
  driver: z.enum(PLUGIN_AUTH_BINDING_DRIVER_KINDS),
  workspaceMemberId: z.string(),
  status: z.enum(PLUGIN_AUTH_SESSION_STATUSES),
  phase: z.enum(PLUGIN_AUTH_SESSION_PHASES).optional(),
  state: z.string().optional(),
  challenge: PluginAuthChallengeViewSchema.optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  // driver result snapshot surfaced to the UI (e.g. displayName); opaque.
  resultPreview: z.record(z.string(), z.unknown()),
  authConnectionId: z.string().optional(),
  // author-supplied session metadata; opaque.
  metadata: z.record(z.string(), z.unknown()),
  expiresAt: IsoInstantStringSchema,
  createdAt: IsoInstantStringSchema,
  updatedAt: IsoInstantStringSchema,
})
export type PluginAuthSessionView = z.infer<typeof PluginAuthSessionViewSchema>

/** Wrapper payload of the auth-session endpoints (`{ session }`). */
export const PluginAuthSessionEnvelopeSchema = z.strictObject({
  session: PluginAuthSessionViewSchema,
})
export type PluginAuthSessionEnvelope = z.infer<
  typeof PluginAuthSessionEnvelopeSchema
>

/** Plan returned by POST .../install-plan (checks + derived grant plan). */
export const MarketplaceRequirementCheckSchema = z.strictObject({
  requirementId: z.string(),
  requirementKind: z.enum(MARKETPLACE_REQUIREMENT_KINDS),
  status: z.enum(MARKETPLACE_REQUIREMENT_STATUSES),
  message: z.string(),
  matchedInstanceIds: z.array(z.string()),
  missingPublisherSlug: z.string().optional(),
  missingPackageSlug: z.string().optional(),
  missingTag: z.string().optional(),
})
export type MarketplaceRequirementCheck = z.infer<
  typeof MarketplaceRequirementCheckSchema
>

export const PluginInstallGrantPlanSchema = z.strictObject({
  requiresGrant: z.boolean(),
  requiredPermissions: z.array(z.string()),
  suggestedAccessTargetType: z.enum(CAPABILITY_ACCESS_TARGET_TYPES).optional(),
  reason: z.string().optional(),
})
export type PluginInstallGrantPlan = z.infer<
  typeof PluginInstallGrantPlanSchema
>

export const PluginInstallPlanViewSchema = z.strictObject({
  packageId: z.string(),
  revisionId: z.string().nullable(),
  workspaceId: z.string(),
  checks: z.array(MarketplaceRequirementCheckSchema),
  grantPlan: PluginInstallGrantPlanSchema,
})
export type PluginInstallPlanView = z.infer<typeof PluginInstallPlanViewSchema>

/** Wrapper payload of the install-plan endpoint (`{ plan }`). */
export const PluginInstallPlanEnvelopeSchema = z.strictObject({
  plan: PluginInstallPlanViewSchema,
})
export type PluginInstallPlanEnvelope = z.infer<
  typeof PluginInstallPlanEnvelopeSchema
>

/**
 * Plugin audit-log list (tool-calls / events). The row shape is DB-derived and
 * filter-dependent (observability surface, no app-side typed consumer), so the
 * entries stay opaque; the wrapper exists only to give these app-facing reads
 * the uniform `{ data }` envelope via sendData (§7 Tier C app surface).
 */
export const PluginAuditLogListSchema = z.array(
  z.record(z.string(), z.unknown())
)
export type PluginAuditLogList = z.infer<typeof PluginAuditLogListSchema>

// ───────────────────────────── request DTOs (§5.1.1) ─────────────────────────
// App-facing request bodies / queries for the mcp-plugins APP routes.
// Single-sourced here so the API parser and the web/mobile clients share one
// definition.

const commaSeparatedQueryListSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (typeof value === "undefined") return undefined
    const rawValues = Array.isArray(value) ? value : value.split(",")
    const values = rawValues.map((item) => item.trim()).filter(Boolean)
    return values.length > 0 ? values : undefined
  })

const auditLimitQuerySchema = z.coerce
  .number()
  .int()
  .positive()
  .max(200)
  .optional()

/** Query for GET /mcp/marketplace. */
export const McpMarketplaceListQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  tags: commaSeparatedQueryListSchema,
  categories: commaSeparatedQueryListSchema,
  transport: z.enum(PLUGIN_SPEC_TRANSPORTS).optional(),
})
export type McpMarketplaceListQuery = z.input<
  typeof McpMarketplaceListQuerySchema
>
export type McpMarketplaceListParsedQuery = z.output<
  typeof McpMarketplaceListQuerySchema
>

/** Query for GET /workspaces/:workspaceId/mcp/installations. */
export const McpPluginInstallationListQuerySchema = z.object({
  pluginId: z.uuid().optional(),
})
export type McpPluginInstallationListQuery = z.infer<
  typeof McpPluginInstallationListQuerySchema
>

/** Query for GET /workspaces/:workspaceId/mcp/audit/tool-calls. */
export const McpPluginToolCallAuditLogListQuerySchema = z.object({
  pluginId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  limit: auditLimitQuerySchema,
  before: IsoInstantStringSchema.optional(),
})
export type McpPluginToolCallAuditLogListQuery = z.output<
  typeof McpPluginToolCallAuditLogListQuerySchema
>

/** Query for GET /workspaces/:workspaceId/mcp/audit/events. */
export const McpPluginEventAuditLogListQuerySchema = z.object({
  eventType: z.string().trim().min(1).optional(),
  pluginId: z.uuid().optional(),
  limit: auditLimitQuerySchema,
  before: IsoInstantStringSchema.optional(),
})
export type McpPluginEventAuditLogListQuery = z.output<
  typeof McpPluginEventAuditLogListQuerySchema
>

/** Body for POST .../mcp/plugins/:pluginId/install-plan. */
export const PluginInstallPlanInputSchema = z.object({})
export type PluginInstallPlanInput = z.infer<
  typeof PluginInstallPlanInputSchema
>

/**
 * Body for POST .../mcp/plugins/:pluginId/auth/:bindingKey/start. draftConfig /
 * metadata are passthrough config objects the plugin-auth flow owns.
 */
export const StartPluginAuthInputSchema = z.object({
  installationId: z.uuid().optional(),
  draftConfig: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type StartPluginAuthInput = z.infer<typeof StartPluginAuthInputSchema>
