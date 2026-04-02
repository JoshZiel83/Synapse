import crypto from "node:crypto";
import fs from "node:fs/promises";
import type pg from "pg";
import {
  DEFAULT_CONVERSATION_TYPE_MASK,
  normalizeConversationTypeMask,
  nowISO,
  REUSE_SCOPES,
  resolveEffectiveConversationTypeMask,
  resolveNarrowedConversationTypeMask,
} from "@synapse/shared";
import type {
  AccessGrant,
  AttachmentTarget,
  AttachmentTargetType,
  CapabilityAccessTarget,
  CapabilityAccessTargetType,
} from "@synapse/shared/types";
import type {
  PluginAuthBindingDefinition,
  PluginConfigFieldDefinition,
  PluginConfigFieldState,
  PluginInstallFlow,
  ReuseScope,
  McpSetupStep,
  McpValidationRule,
  PluginReuseScopeV2,
  RuntimeBindingScope,
} from "@synapse/shared";
import { sql, type RawBuilder } from "kysely";
import { encryptSensitiveFields, isEncrypted } from "../../infrastructure/crypto/index.js";
import {
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";
import { query, transaction } from "../../infrastructure/database/index.js";
import {
  getWorkspaceCapabilityConversationTypeMask,
} from "../capabilities/conversation-type-policies.js";
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";
import { emitEvent } from "../../infrastructure/events/index.js";
import { saveFromBuffer } from "../../infrastructure/storage/file-io.js";
import { getFileUrlById } from "../files/service.js";
import {
  attachAuthConnectionsToConfig,
} from "./auth-service.js";
import { incrementMcpVersion } from "./runtime-version.js";
import { builtinCapabilityCategories } from "./builtin-plugins/categories.js";
import { builtinSeeds } from "./builtin-plugins/index.js";
import {
  assertFeishuFeatureSelection,
  assertFeishuScopesForFeatures,
  normalizeFeishuFeatureKeys,
} from "./feishu/features.js";
import {
  buildResourceAccessAuthzMutations,
  mapAccessBindingToGrant,
  readAccessBindingTarget,
  resolveAccessGrantTarget,
  type AccessBindingRow,
} from "../access/bindings.js";

type QueryRow = pg.QueryResultRow;
type QueryResultLike<T extends QueryRow> = { rows: T[] };
type QueryRunner = <T extends QueryRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResultLike<T>>;

type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

type PluginCatalogRow = {
  item_id: string;
  item_workspace_id: string | null;
  item_slug: string;
  item_display_name: string;
  item_summary: string;
  item_long_description: string;
  item_source_kind: "builtin" | "official" | "workspace" | "user" | "relay";
  item_visibility: "public" | "workspace" | "private";
  item_tags: string[] | null;
  item_is_active: boolean;
  item_download_count: number;
  item_icon_file_id: string | null;
  item_metadata: unknown;
  item_created_at: string;
  item_updated_at: string;
  version_id: string | null;
  version_value: string | null;
  version_status: "draft" | "active" | "deprecated" | "archived" | null;
  version_changelog: string | null;
  version_metadata: unknown;
  version_created_by_user_id: string | null;
  version_created_at: string | null;
  spec_transport: "builtin" | "stdio" | "http" | "relay" | null;
  spec_entry_point: string | null;
  spec_tool_manifest: unknown;
  spec_config_schema: unknown;
  spec_default_config: unknown;
  spec_install_flow: unknown;
  spec_auth_bindings: unknown;
  spec_default_mount_scope: AttachmentTargetType | null;
  spec_default_reuse_scope: PluginReuseScopeV2 | null;
  spec_default_conversation_type_mask: number | null;
  spec_supported_reuse_scopes: unknown;
  spec_requires_handshake: boolean | null;
  spec_metadata: unknown;
  publisher_id: string;
  publisher_slug: string;
  publisher_display_name: string;
  publisher_description: string;
  publisher_workspace_id: string | null;
  publisher_is_builtin: boolean;
  publisher_is_verified: boolean;
  publisher_owner_user_id: string | null;
  publisher_logo_file_id: string | null;
  publisher_metadata: unknown;
  categories_json: unknown;
  runtime_permissions_json: unknown;
};

type PluginCategoryRow = {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  sort_order: number;
  metadata: unknown;
};

type PublisherRow = {
  id: string;
  slug: string;
  display_name: string;
  description: string;
  logo_file_id: string | null;
  owner_user_id: string | null;
  workspace_id: string | null;
  is_builtin: boolean;
  is_verified: boolean;
  metadata: unknown;
  created_at: string;
  updated_at: string;
  plugin_count?: string | number | null;
};

type InstallationRow = {
  installation_id: string;
  workspace_id: string;
  catalog_item_id: string;
  catalog_version_id: string;
  installation_display_name: string;
  attachment_target_type: AttachmentTargetType;
  attachment_conversation_id: string | null;
  attachment_actor_id: string | null;
  attachment_workspace_member_id: string | null;
  config_data: unknown;
  approved_runtime_permissions: string[] | null;
  reuse_scope: PluginReuseScopeV2;
  conversation_type_mask_override: number | null;
  installation_status: "active" | "disabled" | "error" | "archived";
  installed_by_workspace_member_id: string | null;
  installation_metadata: unknown;
  installation_created_at: string;
  installation_updated_at: string;
  source_catalog_item_id: string | null;
  source_catalog_version_id: string | null;
  source_sync_mode: "notify" | "manual_merge" | "follow_upstream" | "detached" | null;
};

type InstallationAccessRow = AccessBindingRow & {
  installation_id: string;
  access_target_type: RuntimeBindingScope;
  conversation_id: string | null;
  actor_id: string | null;
  workspace_member_id: string | null;
};

const PLUGIN_CATALOG_SELECT = `
  SELECT
    item.id AS item_id,
    item.workspace_id AS item_workspace_id,
    item.slug AS item_slug,
    item.display_name AS item_display_name,
    item.summary AS item_summary,
    item.long_description AS item_long_description,
    item.source_kind AS item_source_kind,
    item.visibility AS item_visibility,
    item.tags AS item_tags,
    item.is_active AS item_is_active,
    item.download_count AS item_download_count,
    item.icon_file_id AS item_icon_file_id,
    item.metadata AS item_metadata,
    item.created_at AS item_created_at,
    item.updated_at AS item_updated_at,
    version.id AS version_id,
    version.version AS version_value,
    version.status AS version_status,
    version.changelog AS version_changelog,
    version.metadata AS version_metadata,
    version.created_by_user_id AS version_created_by_user_id,
    version.created_at AS version_created_at,
    spec.transport AS spec_transport,
    spec.entry_point AS spec_entry_point,
    spec.tool_manifest AS spec_tool_manifest,
    spec.config_schema AS spec_config_schema,
    spec.default_config AS spec_default_config,
    spec.install_flow AS spec_install_flow,
    spec.auth_bindings AS spec_auth_bindings,
    spec.default_mount_scope AS spec_default_mount_scope,
    spec.default_reuse_scope AS spec_default_reuse_scope,
    spec.default_conversation_type_mask AS spec_default_conversation_type_mask,
    spec.supported_reuse_scopes AS spec_supported_reuse_scopes,
    spec.requires_handshake AS spec_requires_handshake,
    spec.metadata AS spec_metadata,
    publisher.id AS publisher_id,
    publisher.slug AS publisher_slug,
    publisher.display_name AS publisher_display_name,
    publisher.description AS publisher_description,
    publisher.workspace_id AS publisher_workspace_id,
    publisher.is_builtin AS publisher_is_builtin,
    publisher.is_verified AS publisher_is_verified,
    publisher.owner_user_id AS publisher_owner_user_id,
    publisher.logo_file_id AS publisher_logo_file_id,
    publisher.metadata AS publisher_metadata,
    COALESCE(categories.categories_json, '[]'::jsonb) AS categories_json,
    COALESCE(runtime_permissions.runtime_permissions_json, '[]'::jsonb) AS runtime_permissions_json
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
        'rationale', rationale,
        'metadata', metadata
      )
      ORDER BY permission_key ASC
    ) AS runtime_permissions_json
    FROM plugin_version_runtime_permissions permission_row
    WHERE permission_row.catalog_version_id = version.id
  ) runtime_permissions ON TRUE
  WHERE item.item_kind = 'plugin_package'
`;

export class McpPluginError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sanitizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function asObject(value: unknown): JsonObject {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as JsonObject;
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asArray<T>(value: unknown): T[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

function isConfigValueMissing(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function isReuseScope(value: unknown): value is ReuseScope {
  return typeof value === "string" && REUSE_SCOPES.includes(value as ReuseScope);
}

function normalizeSupportedReuseScopes(
  value: unknown,
  defaultScope: ReuseScope,
): ReuseScope[] {
  const requested = asArray<unknown>(value).filter(isReuseScope);
  const enabledScopes = new Set<ReuseScope>(requested);
  if (enabledScopes.size === 0) {
    for (const scope of REUSE_SCOPES) {
      enabledScopes.add(scope);
    }
  }
  enabledScopes.add(defaultScope);
  return REUSE_SCOPES.filter((scope) => enabledScopes.has(scope));
}

function assertSupportedReuseScope(
  supportedScopes: readonly ReuseScope[],
  lifecycleScope: ReuseScope,
  pluginLabel: string,
) {
  if (!supportedScopes.includes(lifecycleScope)) {
    throw new McpPluginError(
      400,
      `Reuse scope '${lifecycleScope}' is not supported by plugin '${pluginLabel}'`,
    );
  }
}

function publicAttachmentScope(
  scope: AttachmentTargetType | null | undefined,
): AttachmentTargetType {
  return scope || "workspace";
}

function internalAttachmentScope(
  scope: AttachmentTargetType,
): AttachmentTargetType {
  return scope;
}

function publicReuseScope(
  scope: PluginReuseScopeV2 | null | undefined,
): ReuseScope {
  return scope || "conversation";
}

function internalReuseScope(
  scope: ReuseScope,
): PluginReuseScopeV2 {
  return scope;
}

function inferMimeTypeForAsset(assetPath: string) {
  const lower = assetPath.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

let builtinPluginIconFilesTableAvailable: boolean | null = null;

async function hasBuiltinPluginFilesTable() {
  if (builtinPluginIconFilesTableAvailable !== null) {
    return builtinPluginIconFilesTableAvailable;
  }

  const result = await db.executeQuery(
    sql<{ exists: boolean }>`SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'files'
    ) AS exists`.compile(db),
  );

  builtinPluginIconFilesTableAvailable = result.rows[0]?.exists === true;
  return builtinPluginIconFilesTableAvailable;
}

async function ensureBuiltinPluginIcon(
  seedSlug: string,
  pluginSlug: string,
  relativeAssetPath: string,
) {
  if (!(await hasBuiltinPluginFilesTable())) {
    return null;
  }

  const assetUrl = new URL(`./builtin-plugins/${relativeAssetPath}`, import.meta.url);
  const buffer = await fs.readFile(assetUrl);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const key = `${seedSlug}/${pluginSlug}`;

  const existing = await db
    .selectFrom("files")
    .select("id")
    .where("workspace_id", "is", null)
    .where("category", "=", "plugin_asset")
    .where(sql<boolean>`metadata->>'builtin_plugin_icon_key' = ${key}`)
    .where(sql<boolean>`metadata->>'sha256' = ${sha256}`)
    .limit(1)
    .executeTakeFirst();

  if (existing) {
    return {
      id: existing.id,
    };
  }

  const originalName = relativeAssetPath.split("/").pop() || `${pluginSlug}.svg`;
  const file = await saveFromBuffer(
    buffer,
    originalName,
    inferMimeTypeForAsset(relativeAssetPath),
    null,
    null,
    "plugin_asset",
    {
      builtin_plugin_icon_key: key,
      sha256,
      source: "builtin_plugin_icon",
    },
  );

  return {
    id: file.id,
  };
}

function authorizationFromRuntimePermissions(
  runtimePermissions: unknown,
  defaultScope: AttachmentTargetType,
  specMetadata: JsonObject,
) {
  const rows = asArray<JsonObject>(runtimePermissions);
  const metadataAuthorization = asObject(specMetadata.authorization);
  const rawDefaultAccessTargetType =
    (metadataAuthorization.defaultAccessTargetType as
      | CapabilityAccessTargetType
      | "conversation"
      | undefined) ||
    defaultAccessTargetForAttachment({
      type: defaultScope,
    }).type;

  return {
    requiredPermissions: rows
      .filter((row) => row.isRequired !== false)
      .map((row) => String(row.permissionKey || ""))
      .filter(Boolean),
    defaultAccessTargetType: rawDefaultAccessTargetType,
    reason:
      typeof metadataAuthorization.reason === "string"
        ? metadataAuthorization.reason
        : undefined,
  };
}

function mapPluginView(row: PluginCatalogRow) {
  const itemMetadata = asObject(row.item_metadata);
  const specMetadata = asObject(row.spec_metadata);
  const defaultInstanceScope = publicAttachmentScope(row.spec_default_mount_scope);
  const defaultReuseScope = publicReuseScope(row.spec_default_reuse_scope);
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: row.spec_default_conversation_type_mask,
    overrideMask: null,
  });
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    row.spec_supported_reuse_scopes,
    defaultReuseScope,
  );
  const authorization = authorizationFromRuntimePermissions(
    row.runtime_permissions_json,
    defaultInstanceScope,
    specMetadata,
  );
  const configFields = asArray<PluginConfigFieldDefinition>(specMetadata.configFields);
  const validationRules = asArray<McpValidationRule>(specMetadata.validationRules);
  const setupSteps = asArray<McpSetupStep>(specMetadata.setupSteps);
  const installFlow = asObject(row.spec_install_flow);
  const categories = asArray<JsonObject>(row.categories_json).map((category) => ({
    id: String(category.id || ""),
    slug: String(category.slug || ""),
    display_name: String(category.display_name || ""),
    description: String(category.description || ""),
    display_name_i18n: asObject(category.display_name_i18n),
    description_i18n: asObject(category.description_i18n),
    default_locale: typeof category.default_locale === "string" ? category.default_locale : "en",
  }));

  return {
    id: row.item_id,
    org_id: row.publisher_id,
    slug: row.item_slug,
    display_name: row.item_display_name,
    display_name_i18n: asObject(itemMetadata.displayNameI18n),
    description: row.item_summary,
    description_i18n: asObject(itemMetadata.descriptionI18n),
    long_description: row.item_long_description,
    long_description_i18n: asObject(itemMetadata.longDescriptionI18n),
    summary_i18n: asObject(itemMetadata.summaryI18n),
    default_locale:
      typeof itemMetadata.defaultLocale === "string"
        ? itemMetadata.defaultLocale
        : "en",
    icon_url: row.item_icon_file_id ? getFileUrlById(row.item_icon_file_id) : null,
    version: row.version_value || "1.0.0",
    transport: row.spec_transport || "builtin",
    entry_point: row.spec_entry_point || "",
    lifecycle_scope: defaultReuseScope,
    default_reuse_scope: defaultReuseScope,
    default_conversation_type_mask: defaultConversationTypeMask,
    supported_reuse_scopes: supportedReuseScopes,
    default_instance_scope: defaultInstanceScope,
    config_schema: asObject(row.spec_config_schema),
    config_fields: configFields,
    default_config: asObject(row.spec_default_config),
    tools_manifest: asArray(row.spec_tool_manifest),
    validation_rules: validationRules,
    setup_steps: setupSteps,
    install_flow:
      Object.keys(installFlow).length > 0
        ? installFlow
        : { steps: setupSteps },
    auth_bindings: asArray<PluginAuthBindingDefinition>(row.spec_auth_bindings),
    authorization,
    tags: row.item_tags || [],
    categories,
    category_slugs: categories.map((category) => category.slug),
    is_active: row.item_is_active,
    is_builtin: row.item_source_kind === "builtin" || row.publisher_is_builtin,
    download_count: row.item_download_count || 0,
    created_at: row.item_created_at,
    updated_at: row.item_updated_at,
    org_slug: row.publisher_slug,
    org_display_name: row.publisher_display_name,
    publisher: {
      id: row.publisher_id,
      slug: row.publisher_slug,
      display_name: row.publisher_display_name,
      description: row.publisher_description,
      is_verified: row.publisher_is_verified,
    },
    requires_handshake: parseBoolean(row.spec_requires_handshake),
    metadata: specMetadata,
  };
}

function mapPublisherView(row: PublisherRow) {
  const metadata = asObject(row.metadata);
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    description: row.description,
    logo_url: row.logo_file_id ? getFileUrlById(row.logo_file_id) : null,
    is_builtin: row.is_builtin,
    is_verified: row.is_verified,
    owner_user_id: row.owner_user_id,
    workspace_id: row.workspace_id,
    metadata,
    plugin_count:
      typeof row.plugin_count === "number"
        ? row.plugin_count
        : Number(row.plugin_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isSecretConfigField(
  field: PluginConfigFieldDefinition | undefined,
  schemaProperties: Record<string, unknown>,
  key: string,
) {
  const property = asObject(schemaProperties[key]);
  return Boolean(
    field?.secret ||
      field?.type === "secret" ||
      property.sensitive === true,
  );
}

function sanitizeInstallationConfig(
  installation: { config_data: unknown; updated_at: string },
  configSchema: Record<string, unknown>,
  configFields: PluginConfigFieldDefinition[],
  authBindings: PluginAuthBindingDefinition[],
) {
  const rawConfig = asObject(installation.config_data);
  const schemaProperties = asObject(configSchema.properties);
  const fieldMap = new Map(configFields.map((field) => [field.key, field]));
  const bindingMap = new Map(authBindings.map((binding) => [binding.key, binding]));
  const sanitizedConfig: Record<string, unknown> = {};
  const configState: PluginConfigFieldState[] = [];

  for (const [key, value] of Object.entries(rawConfig)) {
    const field = fieldMap.get(key);

    if (
      field?.type === "auth_connection" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const ref = value as Record<string, unknown>;
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
            ? ref.updatedAt
            : installation.updated_at,
      });
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
      };
      continue;
    }

    if (isSecretConfigField(field, schemaProperties, key)) {
      const masked =
        typeof value === "string"
          ? isEncrypted(value)
            ? "••••configured"
            : value.length > 4
              ? `${"•".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`
              : "••••"
          : undefined;
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== "",
        maskedValue: masked,
        updatedAt: installation.updated_at,
      });
      continue;
    }

    if (field?.serverManaged) {
      configState.push({
        key,
        isConfigured: value !== undefined && value !== null && value !== "",
        updatedAt: installation.updated_at,
      });
      continue;
    }

    sanitizedConfig[key] = value;
  }

  for (const field of configFields) {
    if (
      configState.find((state) => state.key === field.key) ||
      (!field.secret &&
        field.type !== "auth_connection" &&
        !field.serverManaged)
    ) {
      continue;
    }

    const binding = field.authBindingKey
      ? bindingMap.get(field.authBindingKey)
      : undefined;
    configState.push({
      key: field.key,
      isConfigured: false,
      accountDisplayName: binding
        ? Object.values(binding.displayNameI18n || {})[0]
        : undefined,
    });
  }

  return {
    sanitizedConfig,
    configState,
  };
}

function mergeConfigForUpdate(
  existingConfig: Record<string, unknown>,
  incomingConfig: Record<string, unknown>,
  configFields: PluginConfigFieldDefinition[],
) {
  const merged: Record<string, unknown> = {
    ...existingConfig,
    ...incomingConfig,
  };

  for (const field of configFields) {
    if (!field.secret) continue;
    const incoming = incomingConfig[field.key];
    if (
      (incoming === undefined || incoming === null || incoming === "") &&
      existingConfig[field.key] !== undefined
    ) {
      merged[field.key] = existingConfig[field.key];
    }
  }

  return merged;
}

function normalizeAttachmentTarget(input: {
  attachmentTarget: AttachmentTarget;
}) {
  switch (input.attachmentTarget.type) {
    case "workspace":
      return {
        mountScope: "workspace" as const,
        actorId: null,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "conversation":
      if (!input.attachmentTarget.conversationId) {
        throw new McpPluginError(
          400,
          "conversationId is required for conversation attachment",
        );
      }
      return {
        mountScope: "conversation" as const,
        actorId: null,
        conversationId: input.attachmentTarget.conversationId,
        workspaceMemberId: null,
      };
    case "actor":
      if (!input.attachmentTarget.actorId) {
        throw new McpPluginError(
          400,
          "actorId is required for actor attachment",
        );
      }
      return {
        mountScope: "actor" as const,
        actorId: input.attachmentTarget.actorId,
        conversationId: null,
        workspaceMemberId: null,
      };
    case "workspace_member":
      if (!input.attachmentTarget.workspaceMemberId) {
        throw new McpPluginError(
          400,
          "workspaceMemberId is required for workspace_member attachment",
        );
      }
      return {
        mountScope: "workspace_member" as const,
        actorId: null,
        conversationId: null,
        workspaceMemberId: input.attachmentTarget.workspaceMemberId,
      };
    default:
      throw new McpPluginError(
        400,
        `Unsupported attachment type: ${String(input.attachmentTarget.type)}`,
      );
  }
}

function buildPluginInstallationAuthzMutations(params: {
  installationId: string;
  workspaceId: string;
  ownerWorkspaceMemberId?: string | null;
  operation: "touch" | "delete";
}) {
  const mutate = params.operation === "delete" ? deleteRelation : touchRelation;
  const relations: AuthzRelationMutation[] = [
    mutate(
      "plugin_installation",
      params.installationId,
      "workspace",
      "workspace",
      params.workspaceId,
    ),
  ];

  if (params.ownerWorkspaceMemberId) {
    relations.push(
      mutate(
        "plugin_installation",
        params.installationId,
        "owner",
        "workspace_member",
        params.ownerWorkspaceMemberId,
      ),
    );
  }

  return relations;
}

function buildInstallationAccessRow(row: AccessBindingRow): InstallationAccessRow {
  const target = readAccessBindingTarget(row);
  return {
    ...row,
    installation_id: row.resource_id,
    access_target_type: target.bindScope,
    actor_id: target.actorId,
    conversation_id: target.conversationId,
    workspace_member_id: target.workspaceMemberId,
  };
}

async function flushQueuedAuthzEntries(entryIds: string[], source: string) {
  if (entryIds.length === 0) return;
  try {
    await flushAuthzOutboxEntries(entryIds);
  } catch (error) {
    console.error(`[authz] Failed to flush ${source}:`, error);
  }
}

async function loadPluginCatalogRows(
  whereClause: RawBuilder<unknown>,
) {
  const result = await db.executeQuery(
    sql<PluginCatalogRow>`
      ${sql.raw(PLUGIN_CATALOG_SELECT)}
      ${whereClause}
    `.compile(db),
  );
  return result.rows;
}

async function loadPluginCatalogMapByVersionIds(versionIds: string[]) {
  if (versionIds.length === 0) {
    return new Map<string, ReturnType<typeof mapPluginView>>();
  }

  const rows = await loadPluginCatalogRows(
    sql`AND version.id = ANY(${versionIds}::uuid[])`,
  );

  return new Map(rows.map((row) => [row.version_id!, mapPluginView(row)]));
}

async function getPluginCatalogRowByItemId(itemId: string) {
  const rows = await loadPluginCatalogRows(
    sql`AND item.id = ${itemId}
       AND version.id = item.latest_version_id
       LIMIT 1`,
  );

  return rows[0] || null;
}

async function loadInstallationRows(
  workspaceId: string,
  filters?: {
    attachmentType?: AttachmentTargetType;
    conversationId?: string;
    actorId?: string;
    workspaceMemberId?: string;
    pluginId?: string;
    installationId?: string;
  },
) {
  const conditions: RawBuilder<unknown>[] = [sql`installation.workspace_id = ${workspaceId}`];

  if (filters?.pluginId) {
    conditions.push(sql`installation.catalog_item_id = ${filters.pluginId}`);
  }

  if (filters?.installationId) {
    conditions.push(sql`installation.id = ${filters.installationId}`);
  }

  const result = await db.executeQuery(
    sql<InstallationRow>`SELECT
        installation.id AS installation_id,
        installation.workspace_id,
        installation.catalog_item_id,
        installation.catalog_version_id,
        installation.display_name AS installation_display_name,
        installation.attachment_target_type,
        installation.attachment_conversation_id,
        installation.attachment_actor_id,
        installation.attachment_workspace_member_id,
        installation.config_data,
        installation.approved_runtime_permissions,
        installation.reuse_scope,
        installation.conversation_type_mask_override,
        installation.status AS installation_status,
        installation.installed_by_workspace_member_id,
        installation.metadata AS installation_metadata,
        installation.created_at AS installation_created_at,
        installation.updated_at AS installation_updated_at,
        source_ref.source_catalog_item_id,
        source_ref.source_catalog_version_id,
        source_ref.sync_mode AS source_sync_mode
      FROM plugin_installations installation
      LEFT JOIN plugin_source_refs source_ref
        ON source_ref.installation_id = installation.id
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY installation.created_at DESC`.compile(db),
  );

  return result.rows.filter((row) => {
    const attachmentTargetType = publicAttachmentScope(
      row.attachment_target_type || "workspace",
    );
    if (filters?.attachmentType && attachmentTargetType !== filters.attachmentType) {
      return false;
    }
    if (
      filters?.conversationId &&
      row.attachment_conversation_id !== filters.conversationId
    ) {
      return false;
    }
    if (filters?.actorId && row.attachment_actor_id !== filters.actorId) {
      return false;
    }
    if (
      filters?.workspaceMemberId
      && row.attachment_workspace_member_id !== filters.workspaceMemberId
    ) {
      return false;
    }
    return true;
  });
}

async function listAccessRows(installationId: string, includeRevoked = false) {
  let builder = db
    .selectFrom("access_bindings as binding")
    .leftJoin(
      "conversation_actor_contexts as cac",
      "cac.id",
      "binding.subject_conversation_actor_context_id",
    )
    .select([
      "binding.id",
      "binding.workspace_id",
      "binding.resource_type",
      "binding.resource_id",
      "binding.target_type",
      "binding.relation",
      "binding.subject_workspace_id",
      "binding.subject_workspace_member_id",
      sql<string | null>`COALESCE(binding.subject_actor_id, cac.actor_id)`.as(
        "subject_actor_id",
      ),
      sql<string | null>`COALESCE(binding.subject_conversation_id, cac.conversation_id)`.as(
        "subject_conversation_id",
      ),
      "binding.subject_conversation_actor_context_id",
      "binding.conversation_type_mask_override",
      "binding.granted_permissions",
      "binding.status",
      "binding.created_by_workspace_member_id",
      "binding.reason",
      "binding.metadata",
      "binding.created_at",
      "binding.revoked_at",
    ])
    .where("binding.resource_type", "=", "plugin_installation")
    .where("binding.resource_id", "=", installationId);

  if (!includeRevoked) {
    builder = builder.where("binding.status", "=", "active");
  }

  const rows = await builder.orderBy("binding.created_at", "asc").execute();
  return rows.map((row) =>
    buildInstallationAccessRow(row as unknown as AccessBindingRow),
  );
}

function buildPluginGrantPlan(input: {
  authorization: {
    requiredPermissions: string[];
    defaultAccessTargetType?: CapabilityAccessTargetType;
    reason?: string;
  };
  attachmentTarget: AttachmentTarget;
}) {
  const requiredPermissions = input.authorization.requiredPermissions || [];
  if (requiredPermissions.length === 0) {
    return {
      requiresGrant: false,
      requiredPermissions: [],
    };
  }

  return {
    requiresGrant: true,
    requiredPermissions,
    suggestedAccessTargetType: defaultAccessTargetForAttachment(
      input.attachmentTarget,
    ).type,
    reason: input.authorization.reason,
  };
}

function defaultAccessTargetForAttachment(
  attachmentTarget: AttachmentTarget,
): CapabilityAccessTarget {
  switch (attachmentTarget.type) {
    case "workspace":
      return { type: "workspace" };
    case "conversation":
      return {
        type: "conversation",
        conversationId: attachmentTarget.conversationId,
      };
    case "actor":
      return {
        type: "actor",
        actorId: attachmentTarget.actorId,
      };
    case "workspace_member":
      return { type: "workspace" };
  }
}

function capabilityAccessTargetFromStored(input: {
  targetType: RuntimeBindingScope | null | undefined;
  actorId?: string | null;
  conversationId?: string | null;
}): CapabilityAccessTarget {
  switch (input.targetType || "workspace") {
    case "workspace":
      return { type: "workspace" };
    case "actor":
      return {
        type: "actor",
        actorId: input.actorId || undefined,
      };
    case "conversation":
      return {
        type: "conversation",
        conversationId: input.conversationId || undefined,
      };
    case "actor_in_conversation":
      return {
        type: "actor_in_conversation",
        actorId: input.actorId || undefined,
        conversationId: input.conversationId || undefined,
      };
  }
}

function mapAccessRowToGrant(
  mount: InstallationAccessRow,
  requiredPermissions: string[],
  reason?: string,
  options?: {
    workspaceConversationTypeMask: number;
    instanceConversationTypeMaskOverride: number | null;
  },
): AccessGrant {
  const effectiveConversationTypeMask = options
    ? resolveNarrowedConversationTypeMask(
        resolveNarrowedConversationTypeMask(
          options.workspaceConversationTypeMask,
          options.instanceConversationTypeMaskOverride,
        ),
        mount.conversation_type_mask_override,
      )
    : undefined;
  return mapAccessBindingToGrant(mount, requiredPermissions, reason, {
    effectiveConversationTypeMask,
  });
}

function buildInstallationPayload(
  row: InstallationRow,
  plugin: ReturnType<typeof mapPluginView>,
  workspaceConversationTypeMask: number,
) {
  const sourceDefaultConversationTypeMask = normalizeConversationTypeMask(
    plugin.default_conversation_type_mask,
    DEFAULT_CONVERSATION_TYPE_MASK,
  );
  const effectiveConversationTypeMask = resolveNarrowedConversationTypeMask(
    workspaceConversationTypeMask,
    row.conversation_type_mask_override,
  );
  const { sanitizedConfig, configState } = sanitizeInstallationConfig(
    {
      config_data: row.config_data,
      updated_at: row.installation_updated_at,
    },
    plugin.config_schema || {},
    plugin.config_fields || [],
    plugin.auth_bindings || [],
  );

  const attachmentTarget: AttachmentTarget = {
    type: publicAttachmentScope(row.attachment_target_type),
    actorId: row.attachment_actor_id || undefined,
    conversationId: row.attachment_conversation_id || undefined,
    workspaceMemberId: row.attachment_workspace_member_id || undefined,
  };
  const accessTarget = defaultAccessTargetForAttachment(attachmentTarget);

  return {
    id: row.installation_id,
    workspace_id: row.workspace_id,
    plugin_id: row.catalog_item_id,
    attachment_target: attachmentTarget,
    access_target: accessTarget,
    lifecycle_scope: publicReuseScope(row.reuse_scope),
    default_reuse_scope: plugin.default_reuse_scope,
    source_default_conversation_type_mask: sourceDefaultConversationTypeMask,
    workspace_conversation_type_mask: workspaceConversationTypeMask,
    conversation_type_mask_override:
      row.conversation_type_mask_override ?? null,
    effective_conversation_type_mask: effectiveConversationTypeMask,
    supported_reuse_scopes: plugin.supported_reuse_scopes || [],
    is_enabled: row.installation_status === "active",
    status: row.installation_status,
    config_data: sanitizedConfig,
    config_state: configState,
    approved_runtime_permissions: row.approved_runtime_permissions || [],
    installed_by_workspace_member_id: row.installed_by_workspace_member_id,
    metadata: asObject(row.installation_metadata),
    created_at: row.installation_created_at,
    updated_at: row.installation_updated_at,
    source_catalog_item_id: row.source_catalog_item_id,
    source_catalog_version_id: row.source_catalog_version_id,
    source_sync_mode: row.source_sync_mode,
    plugin_slug: plugin.slug,
    plugin_display_name: plugin.display_name,
    plugin_description: plugin.description,
    plugin_display_name_i18n: plugin.display_name_i18n,
    plugin_description_i18n: plugin.description_i18n,
    plugin_long_description_i18n: plugin.long_description_i18n,
    plugin_summary_i18n: plugin.summary_i18n,
    default_locale: plugin.default_locale,
    transport: plugin.transport,
    plugin_lifecycle_scope: plugin.lifecycle_scope,
    plugin_default_reuse_scope: plugin.default_reuse_scope,
    plugin_supported_reuse_scopes: plugin.supported_reuse_scopes || [],
    tools_manifest: plugin.tools_manifest,
    plugin_icon_url: plugin.icon_url,
    plugin_categories: plugin.categories || [],
    plugin_category_slugs: plugin.category_slugs || [],
    plugin_version: plugin.version,
    config_schema: plugin.config_schema,
    config_fields: plugin.config_fields,
    install_flow: plugin.install_flow,
    auth_bindings: plugin.auth_bindings,
    is_builtin: plugin.is_builtin,
    plugin_validation_rules: plugin.validation_rules,
    plugin_setup_steps: plugin.setup_steps,
    org_id: plugin.org_id,
    org_slug: plugin.org_slug,
    org_display_name: plugin.org_display_name,
    authorization: plugin.authorization,
    revision: {
      authorization: plugin.authorization,
    },
  };
}

async function getInstallationPayload(workspaceId: string, installationId: string) {
  const rows = await loadInstallationRows(workspaceId, {
    installationId,
  });
  const row = rows[0];
  if (!row) {
    throw new McpPluginError(404, "Installation not found");
  }

  const pluginsByVersionId = await loadPluginCatalogMapByVersionIds([
    row.catalog_version_id,
  ]);
  const plugin = pluginsByVersionId.get(row.catalog_version_id);
  if (!plugin) {
    throw new McpPluginError(404, "Plugin not found");
  }
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      row.workspace_id,
      "plugin_installation",
    );

  return {
    row,
    plugin,
    workspaceConversationTypeMask,
    installation: buildInstallationPayload(
      row,
      plugin,
      workspaceConversationTypeMask,
    ),
  };
}

async function ensureCatalogItem(
  run: QueryRunner,
  input: {
    orgId: string;
    workspaceId?: string;
    slug: string;
    displayName: string;
    description?: string;
    longDescription?: string;
    iconFileId?: string;
    tags?: string[];
    isBuiltin?: boolean;
    transport: string;
    displayNameI18n?: Record<string, string>;
    descriptionI18n?: Record<string, string>;
    longDescriptionI18n?: Record<string, string>;
    summaryI18n?: Record<string, string>;
    defaultLocale?: string;
  },
) {
  const normalizedSlug = sanitizeSlug(input.slug);
  const existing = await run<{ id: string }>(
    `SELECT id
     FROM catalog_items
     WHERE publisher_id = $1
       AND item_kind = 'plugin_package'
       AND slug = $2
       AND workspace_id IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [input.orgId, normalizedSlug, input.workspaceId || null],
  );

  const metadata = {
    displayNameI18n: input.displayNameI18n || { en: input.displayName },
    descriptionI18n: input.descriptionI18n || { en: input.description || "" },
    longDescriptionI18n:
      input.longDescriptionI18n ||
      (input.longDescription ? { en: input.longDescription } : undefined),
    summaryI18n: input.summaryI18n,
    defaultLocale: input.defaultLocale || "en",
  };

  if (existing.rows.length > 0) {
    const itemId = existing.rows[0]!.id;
    await run(
      `UPDATE catalog_items
       SET display_name = $2,
           summary = $3,
           long_description = $4,
           source_kind = $5,
           visibility = 'public',
           tags = $6,
           is_active = TRUE,
           icon_file_id = $7,
           metadata = $8::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [
        itemId,
        input.displayName,
        input.description || "",
        input.longDescription || "",
        input.transport === "relay"
          ? "relay"
          : input.isBuiltin
            ? "builtin"
            : "official",
        input.tags || [],
        input.iconFileId || null,
        JSON.stringify(metadata),
      ],
    );
    return itemId;
  }

  const inserted = await run<{ id: string }>(
    `INSERT INTO catalog_items (
       publisher_id,
       workspace_id,
       item_kind,
       slug,
       display_name,
       summary,
       long_description,
       icon_file_id,
       source_kind,
       visibility,
       tags,
       is_active,
       metadata
     )
     VALUES (
       $1, $2, 'plugin_package', $3, $4, $5, $6, $7, $8, 'public', $9, TRUE, $10::jsonb
     )
     RETURNING id`,
    [
      input.orgId,
      input.workspaceId || null,
      normalizedSlug,
      input.displayName,
      input.description || "",
      input.longDescription || "",
      input.iconFileId || null,
      input.transport === "relay"
        ? "relay"
        : input.isBuiltin
          ? "builtin"
          : "official",
      input.tags || [],
      JSON.stringify(metadata),
    ],
  );

  return inserted.rows[0]!.id;
}

async function upsertPluginVersion(
  run: QueryRunner,
  itemId: string,
  input: {
    version?: string;
    transport: string;
    entryPoint?: string;
    lifecycleScope?: ReuseScope;
    supportedReuseScopes?: ReuseScope[];
    defaultInstanceScope?: AttachmentTargetType;
    defaultConversationTypeMask?: number;
    requiresHandshake?: boolean;
    toolsManifest?: unknown[];
    configSchema?: Record<string, unknown>;
    defaultConfig?: Record<string, unknown>;
    installFlow?: PluginInstallFlow;
    authBindings?: PluginAuthBindingDefinition[];
    configFields?: PluginConfigFieldDefinition[];
    validationRules?: McpValidationRule[];
    setupSteps?: McpSetupStep[];
    authorization?: {
      requiredPermissions?: string[];
      defaultAccessTargetType?: CapabilityAccessTargetType;
      reason?: string;
    };
  },
) {
  const versionValue = input.version || "1.0.0";
  const upsertedVersion = await run<{ id: string }>(
    `INSERT INTO catalog_versions (
       catalog_item_id,
       version,
       status,
       changelog,
       metadata
     )
     VALUES ($1, $2, 'active', '', '{}'::jsonb)
     ON CONFLICT (catalog_item_id, version) DO UPDATE
       SET status = 'active'
     RETURNING id`,
    [itemId, versionValue],
  );
  const versionId = upsertedVersion.rows[0]!.id;

  const metadata = {
    configFields: input.configFields || [],
    validationRules: input.validationRules || [],
    setupSteps: input.setupSteps || [],
    authorization: {
      defaultAccessTargetType:
        input.authorization?.defaultAccessTargetType || undefined,
      reason: input.authorization?.reason || undefined,
    },
  };
  const defaultReuseScope = input.lifecycleScope || "conversation";
  const defaultConversationTypeMask = resolveEffectiveConversationTypeMask({
    defaultMask: input.defaultConversationTypeMask,
    overrideMask: null,
  });
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    input.supportedReuseScopes,
    defaultReuseScope,
  );

  await run(
    `INSERT INTO plugin_package_version_specs (
       catalog_version_id,
       transport,
       entry_point,
       tool_manifest,
       config_schema,
       default_config,
       install_flow,
       auth_bindings,
       default_mount_scope,
       default_reuse_scope,
       default_conversation_type_mask,
       supported_reuse_scopes,
       requires_handshake,
       metadata
     )
     VALUES (
       $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
       $9, $10, $11, $12, $13, $14::jsonb
     )
     ON CONFLICT (catalog_version_id) DO UPDATE
       SET transport = EXCLUDED.transport,
           entry_point = EXCLUDED.entry_point,
           tool_manifest = EXCLUDED.tool_manifest,
           config_schema = EXCLUDED.config_schema,
           default_config = EXCLUDED.default_config,
           install_flow = EXCLUDED.install_flow,
           auth_bindings = EXCLUDED.auth_bindings,
           default_mount_scope = EXCLUDED.default_mount_scope,
           default_reuse_scope = EXCLUDED.default_reuse_scope,
           default_conversation_type_mask = EXCLUDED.default_conversation_type_mask,
           supported_reuse_scopes = EXCLUDED.supported_reuse_scopes,
           requires_handshake = EXCLUDED.requires_handshake,
           metadata = EXCLUDED.metadata`,
    [
      versionId,
      input.transport,
      input.entryPoint || null,
      JSON.stringify(input.toolsManifest || []),
      JSON.stringify(input.configSchema || {}),
      JSON.stringify(input.defaultConfig || {}),
      JSON.stringify(input.installFlow || { steps: input.setupSteps || [] }),
      JSON.stringify(input.authBindings || []),
      internalAttachmentScope(input.defaultInstanceScope || "workspace"),
      internalReuseScope(defaultReuseScope),
      defaultConversationTypeMask,
      supportedReuseScopes.map((scope) => internalReuseScope(scope)),
      input.requiresHandshake ?? input.transport !== "builtin",
      JSON.stringify(metadata),
    ],
  );

  await run(
    `DELETE FROM plugin_version_runtime_permissions
     WHERE catalog_version_id = $1`,
    [versionId],
  );

  for (const permissionKey of input.authorization?.requiredPermissions || []) {
    await run(
      `INSERT INTO plugin_version_runtime_permissions (
         catalog_version_id,
         permission_key,
         is_required,
         rationale,
         metadata
       )
       VALUES ($1, $2, TRUE, '', '{}'::jsonb)`,
      [versionId, permissionKey],
    );
  }

  await run(
    `UPDATE catalog_items
     SET latest_version_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, versionId],
  );

  return versionId;
}

async function assignPluginCategories(
  run: QueryRunner,
  itemId: string,
  categorySlugs: string[],
) {
  await run(
    `DELETE FROM catalog_item_categories
     WHERE catalog_item_id = $1`,
    [itemId],
  );

  if (categorySlugs.length === 0) return;

  const result = await run<{ id: string }>(
    `SELECT id
     FROM catalog_categories
     WHERE item_kind = 'plugin_package'
       AND slug = ANY($1::text[])`,
    [categorySlugs],
  );

  for (const row of result.rows) {
    await run(
      `INSERT INTO catalog_item_categories (catalog_item_id, category_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [itemId, row.id],
    );
  }
}

export async function createOrganization(data: {
  slug: string;
  displayName: string;
  description?: string;
  logoFileId?: string;
  isBuiltin?: boolean;
  isVerified?: boolean;
  ownerUserId?: string;
}) {
  const normalizedSlug = sanitizeSlug(data.slug);
  const row = await db
    .insertInto("publishers")
    .values({
      slug: normalizedSlug,
      display_name: data.displayName,
      description: data.description || "",
      logo_file_id: data.logoFileId || null,
      owner_user_id: data.ownerUserId || null,
      workspace_id: null,
      is_builtin: data.isBuiltin === true,
      is_verified: data.isVerified === true,
      metadata: {} as TableInsert<"publishers">["metadata"],
    })
    .onConflict((oc) =>
      oc.column("slug").doUpdateSet({
        display_name: data.displayName,
        description: data.description || "",
        logo_file_id: data.logoFileId || null,
        owner_user_id: sql`COALESCE(publishers.owner_user_id, excluded.owner_user_id)`,
        is_builtin: data.isBuiltin === true,
        is_verified: data.isVerified === true,
        metadata: {} as TableInsert<"publishers">["metadata"],
        updated_at: sql`NOW()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapPublisherView(row as unknown as PublisherRow);
}

export async function listOrganizations() {
  const rows = await db
    .selectFrom("publishers as publisher")
    .leftJoin("catalog_items as item", (join) =>
      join
        .onRef("item.publisher_id", "=", "publisher.id")
        .on("item.item_kind", "=", "plugin_package")
        .on("item.is_active", "=", true)
        .on("item.workspace_id", "is", null),
    )
    .selectAll("publisher")
    .select(sql<number>`COUNT(item.id)::int`.as("plugin_count"))
    .groupBy("publisher.id")
    .orderBy("publisher.is_verified", "desc")
    .orderBy("publisher.display_name", "asc")
    .execute();

  return rows.map((row) => mapPublisherView(row as unknown as PublisherRow));
}

export async function getOrganization(id: string) {
  const row = await db
    .selectFrom("publishers")
    .selectAll()
    .select(sql<number>`0::int`.as("plugin_count"))
    .where("id", "=", id)
    .limit(1)
    .executeTakeFirst();

  if (!row) {
    throw new McpPluginError(404, "Publisher not found");
  }

  return mapPublisherView(row as unknown as PublisherRow);
}

export async function getOrganizationBySlug(slug: string) {
  const row = await db
    .selectFrom("publishers")
    .selectAll()
    .select(sql<number>`0::int`.as("plugin_count"))
    .where("slug", "=", sanitizeSlug(slug))
    .limit(1)
    .executeTakeFirst();

  return row ? mapPublisherView(row as unknown as PublisherRow) : null;
}

export async function createPlugin(data: {
  orgId: string;
  workspaceId?: string;
  slug: string;
  displayName: string;
  description?: string;
  longDescription?: string;
  iconFileId?: string;
  version?: string;
  transport: string;
  entryPoint?: string;
  lifecycleScope?: ReuseScope;
  configSchema?: Record<string, unknown>;
  configFields?: PluginConfigFieldDefinition[];
  defaultConfig?: Record<string, unknown>;
  toolsManifest?: unknown[];
  tags?: string[];
  categorySlugs?: string[];
  isBuiltin?: boolean;
  validationRules?: McpValidationRule[];
  setupSteps?: McpSetupStep[];
  installFlow?: PluginInstallFlow;
  authBindings?: PluginAuthBindingDefinition[];
  displayNameI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
  longDescriptionI18n?: Record<string, string>;
  summaryI18n?: Record<string, string>;
  defaultLocale?: string;
  defaultInstanceScope?: AttachmentTargetType;
  supportedReuseScopes?: ReuseScope[];
  requiresHandshake?: boolean;
  authorization?: {
    requiredPermissions?: string[];
    defaultAccessTargetType?: CapabilityAccessTargetType;
    reason?: string;
  };
}) {
  const itemId = await transaction(async (client) => {
    const run = client.query.bind(client) as QueryRunner;
    const catalogItemId = await ensureCatalogItem(run, data);
    await upsertPluginVersion(run, catalogItemId, data);
    await assignPluginCategories(run, catalogItemId, data.categorySlugs || []);
    return catalogItemId;
  });

  return getPlugin(itemId);
}

export async function listPlugins(filters?: {
  orgId?: string;
  transport?: string;
  search?: string;
  tags?: string[];
  categorySlugs?: string[];
}) {
  const conditions: RawBuilder<unknown>[] = [
    sql`version.id = item.latest_version_id`,
    sql`item.is_active = TRUE`,
    sql`item.workspace_id IS NULL`,
  ];

  if (filters?.orgId) {
    conditions.push(sql`item.publisher_id = ${filters.orgId}`);
  }

  if (filters?.transport) {
    conditions.push(sql`spec.transport = ${filters.transport}`);
  }

  if (filters?.search) {
    conditions.push(
      sql`(item.display_name ILIKE ${`%${filters.search.trim()}%`} OR item.summary ILIKE ${`%${filters.search.trim()}%`} OR item.long_description ILIKE ${`%${filters.search.trim()}%`} OR EXISTS (
         SELECT 1
         FROM unnest(COALESCE(item.tags, ARRAY[]::text[])) tag
         WHERE tag ILIKE ${`%${filters.search.trim()}%`}
       ))`,
    );
  }

  if (filters?.tags && filters.tags.length > 0) {
    conditions.push(sql`item.tags && ${filters.tags}::text[]`);
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
       )`,
    );
  }

  const rows = await loadPluginCatalogRows(
    sql`AND ${sql.join(conditions, sql` AND `)}
       ORDER BY item.download_count DESC, item.created_at DESC`,
  );

  return rows.map(mapPluginView);
}

export async function listPluginCategories() {
  const rows = await db
    .selectFrom("catalog_categories")
    .selectAll()
    .where("item_kind", "=", "plugin_package")
    .orderBy("sort_order", "asc")
    .orderBy("display_name", "asc")
    .execute();

  return rows.map((row) => {
    const metadata = asObject(row.metadata);
    return {
      id: row.id,
      slug: row.slug,
      display_name: row.display_name,
      description: row.description,
      display_name_i18n: asObject(metadata.displayNameI18n),
      description_i18n: asObject(metadata.descriptionI18n),
      default_locale:
        typeof metadata.defaultLocale === "string"
          ? metadata.defaultLocale
          : "en",
      sort_order: row.sort_order,
    };
  });
}

export async function getPlugin(id: string) {
  const row = await getPluginCatalogRowByItemId(id);
  if (!row) {
    throw new McpPluginError(404, "Plugin not found");
  }

  return mapPluginView(row);
}

export function validateSupportedLifecycleScope(
  supportedScopes: readonly ReuseScope[],
  lifecycleScope: ReuseScope,
) {
  return supportedScopes.includes(lifecycleScope);
}

export async function installPluginUnified(data: {
  workspaceId: string;
  pluginId: string;
  attachmentTarget: AttachmentTarget;
  lifecycleScope?: ReuseScope;
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
  installedByWorkspaceMemberId?: string;
}) {
  const plugin = await getPlugin(data.pluginId);
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    plugin.supported_reuse_scopes,
    plugin.default_reuse_scope || "conversation",
  );
  const lifecycleScope =
    data.lifecycleScope || plugin.default_reuse_scope || "conversation";
  assertSupportedReuseScope(supportedReuseScopes, lifecycleScope, plugin.slug);
  const target = normalizeAttachmentTarget({ attachmentTarget: data.attachmentTarget });
  const approvedRuntimePermissions =
    plugin.authorization?.requiredPermissions || [];

  async function validateResolvedConfigForInstall(
    config: Record<string, unknown>,
    run: QueryRunner,
  ) {
    if (plugin.entry_point !== "feishu/app") {
      return;
    }

    const features = normalizeFeishuFeatureKeys(config.features);
    try {
      assertFeishuFeatureSelection(features);
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error ? error.message : "Invalid Feishu feature selection.",
      );
    }

    const rawConnection = asObject(config.feishuAccount);
    if (
      rawConnection.__kind !== "auth_connection_ref" ||
      typeof rawConnection.connectionId !== "string"
    ) {
      throw new McpPluginError(400, "Feishu account authorization is required.");
    }

    const connectionResult = await run<{
      public_payload: unknown;
    }>(
      `SELECT public_payload
       FROM plugin_connections
       WHERE id = $1
       LIMIT 1`,
      [rawConnection.connectionId],
    );
    if (connectionResult.rows.length === 0) {
      throw new McpPluginError(400, "Feishu auth connection not found.");
    }

    try {
      assertFeishuScopesForFeatures(
        features,
        asObject(connectionResult.rows[0]!.public_payload).scopes,
      );
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error ? error.message : "Feishu scopes do not match the selected features.",
      );
    }
  }

  const result = await transaction(async (client) => {
    const catalogRow = await getPluginCatalogRowByItemId(plugin.id);
    const catalogVersionId = catalogRow?.version_id;
    if (!catalogVersionId) {
      throw new McpPluginError(500, "Plugin catalog is missing its latest version");
    }

    const insertedInstallation = await executeTakeFirst<{ id: string }>(
      client,
      db
        .insertInto("plugin_installations")
        .values({
          workspace_id: data.workspaceId,
          catalog_item_id: plugin.id,
          catalog_version_id: catalogVersionId,
          display_name: plugin.display_name,
          attachment_target_type: target.mountScope,
          attachment_actor_id: target.actorId,
          attachment_conversation_id: target.conversationId,
          attachment_workspace_member_id: target.workspaceMemberId,
          config_data: {} as TableInsert<"plugin_installations">["config_data"],
          approved_runtime_permissions: approvedRuntimePermissions,
          reuse_scope: internalReuseScope(lifecycleScope),
          conversation_type_mask_override:
            plugin.default_conversation_type_mask ?? null,
          status: "active",
          installed_by_workspace_member_id:
            data.installedByWorkspaceMemberId || null,
          metadata: {} as TableInsert<"plugin_installations">["metadata"],
        })
        .returning("id"),
    );
    const installationId = insertedInstallation!.id;

    const resolvedConfigBase = data.configData || {};
    const resolvedConfig = await attachAuthConnectionsToConfig({
      installationId,
      workspaceId: data.workspaceId,
      workspaceMemberId:
        data.attachmentTarget.workspaceMemberId || "",
      configFields: plugin.config_fields || [],
      authBindings: plugin.auth_bindings || [],
      configData: resolvedConfigBase,
      authSessionIds: data.authSessionIds,
      run: client.query.bind(client) as QueryRunner,
    });
    await validateResolvedConfigForInstall(
      resolvedConfig,
      client.query.bind(client) as QueryRunner,
    );
    const encryptedConfig = encryptSensitiveFields(
      resolvedConfig,
      plugin.config_schema || {},
    );

    await executeCompiledQuery(
      client,
      db
        .updateTable("plugin_installations")
        .set({
          config_data: encryptedConfig as TableInsert<"plugin_installations">["config_data"],
          updated_at: sql`NOW()`,
        })
        .where("id", "=", installationId),
    );

    const initialAccessTarget = await resolveAccessGrantTarget({
      workspaceId: data.workspaceId,
      target: defaultAccessTargetForAttachment(data.attachmentTarget),
    });
    const insertedAccess = await executeTakeFirst<{ id: string }>(
      client,
      db
        .insertInto("access_bindings")
        .values({
          workspace_id: data.workspaceId,
          resource_type: "plugin_installation",
          resource_id: installationId,
          target_type: initialAccessTarget.targetType,
          relation: initialAccessTarget.relation,
          subject_workspace_id: initialAccessTarget.subjectWorkspaceId,
          subject_workspace_member_id:
            initialAccessTarget.subjectWorkspaceMemberId,
          subject_actor_id: initialAccessTarget.subjectActorId,
          subject_conversation_id: initialAccessTarget.subjectConversationId,
          subject_conversation_actor_context_id:
            initialAccessTarget.subjectConversationActorContextId,
          granted_permissions: approvedRuntimePermissions,
          metadata: {} as TableInsert<"access_bindings">["metadata"],
          status: "active",
          created_by_workspace_member_id:
            data.installedByWorkspaceMemberId || null,
          reason: plugin.authorization?.reason || null,
        })
        .returning("id"),
    );
    const initialAccessId = insertedAccess!.id;

    await executeCompiledQuery(
      client,
      db
        .insertInto("plugin_source_refs")
        .values({
          installation_id: installationId,
          source_catalog_item_id: plugin.id,
          source_catalog_version_id: catalogVersionId,
          sync_mode: "manual_merge",
          metadata: {} as TableInsert<"plugin_source_refs">["metadata"],
        }),
    );

    await executeCompiledQuery(
      client,
      db
        .updateTable("catalog_items")
        .set({
          download_count: sql`download_count + 1`,
          updated_at: sql`NOW()`,
        })
        .where("id", "=", plugin.id),
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        ...buildPluginInstallationAuthzMutations({
          installationId,
          workspaceId: data.workspaceId,
          ownerWorkspaceMemberId: target.workspaceMemberId,
          operation: "touch",
        }),
        ...buildResourceAccessAuthzMutations({
            resourceType: "plugin_installation",
            resourceId: installationId,
            workspaceId: data.workspaceId,
            target: initialAccessTarget,
            operation: "touch",
          }),
      ],
      {
        source: "plugin.install",
        workspaceId: data.workspaceId,
        installationId,
        accessBindingId: initialAccessId,
      },
    );

    return {
      installationId,
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "plugin.install");
  await incrementMcpVersion(data.workspaceId);

  const installed = await getInstallation(data.workspaceId, result.installationId);
  return installed;
}

export async function uninstallPluginUnified(installId: string) {
  const installation = await db
    .selectFrom("plugin_installations")
    .select([
      "id as installation_id",
      "workspace_id",
      "installed_by_workspace_member_id",
    ])
    .where("id", "=", installId)
    .limit(1)
    .executeTakeFirst();
  if (!installation) {
    throw new McpPluginError(404, "Installation not found");
  }

  const accessRows = await listAccessRows(installId, true);

  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      [
        ...buildPluginInstallationAuthzMutations({
          installationId: installId,
          workspaceId: installation.workspace_id,
          ownerWorkspaceMemberId: null,
          operation: "delete",
        }),
        ...accessRows
          .filter((binding) => binding.status === "active")
          .flatMap((binding) =>
            buildResourceAccessAuthzMutations({
              resourceType: "plugin_installation",
              resourceId: installId,
              target: readAccessBindingTarget(binding),
              operation: "delete",
            }),
          ),
      ],
      {
        source: "plugin.uninstall",
        workspaceId: installation.workspace_id,
        installationId: installId,
      },
    );

    await executeCompiledQuery(
      client,
      db
        .deleteFrom("access_bindings")
        .where("resource_type", "=", "plugin_installation")
        .where("resource_id", "=", installId),
    );

    await executeCompiledQuery(
      client,
      db.deleteFrom("plugin_installations").where("id", "=", installId),
    );

    return ids;
  });

  await flushQueuedAuthzEntries(authzEntryIds, "plugin.uninstall");
  await incrementMcpVersion(installation.workspace_id);

  return {
    id: installId,
    workspace_id: installation.workspace_id,
  };
}

export async function getInstallations(
  workspaceId: string,
  filters?: {
    attachmentType?: AttachmentTargetType;
    conversationId?: string;
    actorId?: string;
    workspaceMemberId?: string;
    pluginId?: string;
  },
) {
  const rows = await loadInstallationRows(workspaceId, filters);
  const pluginsByVersionId = await loadPluginCatalogMapByVersionIds(
    Array.from(new Set(rows.map((row) => row.catalog_version_id))),
  );
  const workspaceConversationTypeMask =
    await getWorkspaceCapabilityConversationTypeMask(
      workspaceId,
      "plugin_installation",
    );

  return rows
    .map((row) => {
      const plugin = pluginsByVersionId.get(row.catalog_version_id);
      return plugin
        ? buildInstallationPayload(row, plugin, workspaceConversationTypeMask)
        : null;
    })
    .filter(Boolean);
}

export async function getInstallation(workspaceId: string, installId: string) {
  const { installation } = await getInstallationPayload(workspaceId, installId);
  return installation;
}

export async function updateInstallation(
  installId: string,
  data: {
    isEnabled?: boolean;
    configData?: Record<string, unknown>;
    authSessionIds?: Record<string, string>;
    lifecycleScope?: ReuseScope;
    attachmentTarget?: AttachmentTarget;
    conversationTypeMaskOverride?: number | null;
    updatedByWorkspaceMemberId?: string;
  },
) {
  const currentRow = await db
    .selectFrom("plugin_installations")
    .select("workspace_id")
    .where("id", "=", installId)
    .limit(1)
    .executeTakeFirst();
  if (!currentRow) {
    throw new McpPluginError(404, "Installation not found");
  }

  const workspaceId = currentRow.workspace_id;
  const { row, plugin } = await getInstallationPayload(workspaceId, installId);

  const nextAttachmentType =
    data.attachmentTarget?.type || publicAttachmentScope(row.attachment_target_type);
  const nextLifecycleScope =
    data.lifecycleScope || publicReuseScope(row.reuse_scope);
  const supportedReuseScopes = normalizeSupportedReuseScopes(
    plugin.supported_reuse_scopes,
    plugin.default_reuse_scope || "conversation",
  );
  assertSupportedReuseScope(
    supportedReuseScopes,
    nextLifecycleScope,
    plugin.slug,
  );

  const target = normalizeAttachmentTarget({
    attachmentTarget:
      data.attachmentTarget || {
        type: nextAttachmentType,
        actorId: row.attachment_actor_id || undefined,
        conversationId: row.attachment_conversation_id || undefined,
        workspaceMemberId: row.attachment_workspace_member_id || undefined,
      },
  });

  const mergedConfig = data.configData
    ? mergeConfigForUpdate(
        asObject(row.config_data),
        data.configData,
        plugin.config_fields || [],
      )
    : asObject(row.config_data);

  async function validateResolvedConfigForUpdate(
    config: Record<string, unknown>,
    run: QueryRunner,
  ) {
    if (plugin.entry_point !== "feishu/app") {
      return;
    }

    const features = normalizeFeishuFeatureKeys(config.features);
    try {
      assertFeishuFeatureSelection(features);
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error ? error.message : "Invalid Feishu feature selection.",
      );
    }

    const rawConnection = asObject(config.feishuAccount);
    if (
      rawConnection.__kind !== "auth_connection_ref" ||
      typeof rawConnection.connectionId !== "string"
    ) {
      throw new McpPluginError(400, "Feishu account authorization is required.");
    }

    const connectionResult = await run<{
      public_payload: unknown;
    }>(
      `SELECT public_payload
       FROM plugin_connections
       WHERE id = $1
       LIMIT 1`,
      [rawConnection.connectionId],
    );
    if (connectionResult.rows.length === 0) {
      throw new McpPluginError(400, "Feishu auth connection not found.");
    }

    try {
      assertFeishuScopesForFeatures(
        features,
        asObject(connectionResult.rows[0]!.public_payload).scopes,
      );
    } catch (error) {
      throw new McpPluginError(
        400,
        error instanceof Error ? error.message : "Feishu scopes do not match the selected features.",
      );
    }
  }

  const authzEntryIds = await transaction(async (client) => {
    const run = client.query.bind(client) as QueryRunner;

    const resolvedConfig =
      data.configData || data.authSessionIds
        ? await attachAuthConnectionsToConfig({
            installationId: installId,
            workspaceId,
            workspaceMemberId:
              data.attachmentTarget?.workspaceMemberId
              || row.attachment_workspace_member_id
              || "",
            configFields: plugin.config_fields || [],
            authBindings: plugin.auth_bindings || [],
            configData: mergedConfig,
            authSessionIds: data.authSessionIds,
            run,
          })
        : mergedConfig;

    if (data.configData || data.authSessionIds) {
      await validateResolvedConfigForUpdate(resolvedConfig, run);
    }

    if (data.configData || data.authSessionIds) {
      const encryptedConfig = encryptSensitiveFields(
        resolvedConfig,
        plugin.config_schema || {},
      );
      await run(
        `UPDATE plugin_installations
         SET config_data = $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [installId, JSON.stringify(encryptedConfig)],
      );
    }

    if (data.isEnabled !== undefined) {
      await run(
        `UPDATE plugin_installations
         SET status = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [installId, data.isEnabled ? "active" : "disabled"],
      );
    }

    if (data.lifecycleScope) {
      await run(
        `UPDATE plugin_installations
         SET reuse_scope = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [installId, internalReuseScope(nextLifecycleScope)],
      );
    }

    if (data.attachmentTarget) {
      await run(
        `UPDATE plugin_installations
         SET attachment_target_type = $2,
             attachment_actor_id = $3,
             attachment_conversation_id = $4,
             attachment_workspace_member_id = $5,
             updated_at = NOW()
         WHERE id = $1`,
        [
          installId,
          target.mountScope,
          target.actorId,
          target.conversationId,
          target.workspaceMemberId,
        ],
      );
    }

    if (data.conversationTypeMaskOverride !== undefined) {
      await run(
        `UPDATE plugin_installations
         SET conversation_type_mask_override = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [installId, data.conversationTypeMaskOverride],
      );
    }

    return [] as string[];
  });

  await flushQueuedAuthzEntries(authzEntryIds, "plugin.installation.update");
  await incrementMcpVersion(workspaceId);

  if (data.configData || data.authSessionIds) {
    await emitEvent({
      type: "mcp.config.changed",
      workspaceId,
      payload: { pluginId: row.catalog_item_id, workspaceId },
      timestamp: nowISO(),
    });
  }

  return getInstallation(workspaceId, installId);
}

export async function getPluginInstallationAccessState(
  workspaceId: string,
  installationId: string,
) {
  const { installation, plugin, workspaceConversationTypeMask } =
    await getInstallationPayload(
    workspaceId,
    installationId,
    );
  const accessRows = await listAccessRows(installationId);
  const grants = accessRows
    .filter((binding) => binding.status === "active")
    .map((binding) =>
      mapAccessRowToGrant(
        binding,
        plugin.authorization?.requiredPermissions || [],
        plugin.authorization?.reason,
        {
          workspaceConversationTypeMask,
          instanceConversationTypeMaskOverride:
            installation.conversation_type_mask_override ?? null,
        },
      ),
    );

  return {
    grants,
    summary: {
      requiredPermissions: plugin.authorization?.requiredPermissions || [],
      suggestedAccessTargetType: installation.access_target.type,
      sourceDefaultConversationTypeMask:
        installation.source_default_conversation_type_mask ||
        DEFAULT_CONVERSATION_TYPE_MASK,
      workspaceConversationTypeMask,
      conversationTypeMaskOverride:
        installation.conversation_type_mask_override ?? null,
      effectiveConversationTypeMask:
        installation.effective_conversation_type_mask,
      reason: plugin.authorization?.reason,
      effectivePermissions:
        grants.length > 0 ? plugin.authorization?.requiredPermissions || [] : [],
      isVisible: grants.length > 0,
      isAuthorized: grants.length > 0,
      matchingGrantIds: grants.map((grant) => grant.id),
    },
  };
}

export async function grantPluginInstallationAccess(input: {
  workspaceId: string;
  installationId: string;
  accessTarget?: CapabilityAccessTarget;
  permissions?: string[];
  conversationTypeMaskOverride?: number | null;
  grantedByWorkspaceMemberId?: string;
  reason?: string;
  metadata?: JsonObject;
}) {
  const { plugin, installation, workspaceConversationTypeMask } =
    await getInstallationPayload(
    input.workspaceId,
    input.installationId,
    );
  const accessRows = await listAccessRows(input.installationId);

  const resolvedAccessTarget =
    input.accessTarget ||
    installation.access_target;
  const accessTarget = await resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    target: resolvedAccessTarget,
  });

  const existing = accessRows.find(
    (entry) =>
      entry.status === "active" &&
      entry.access_target_type === accessTarget.targetType &&
      entry.actor_id === accessTarget.actorId &&
      entry.conversation_id === accessTarget.conversationId &&
      entry.workspace_member_id === accessTarget.workspaceMemberId,
  );
  if (existing) {
    return mapAccessRowToGrant(
      existing,
      plugin.authorization?.requiredPermissions || [],
      plugin.authorization?.reason,
      {
        workspaceConversationTypeMask,
        instanceConversationTypeMaskOverride:
          installation.conversation_type_mask_override ?? null,
      },
    );
  }

  const result = await transaction(async (client) => {
    const inserted = await executeTakeFirst(
      client,
      db
        .insertInto("access_bindings")
        .values({
          workspace_id: input.workspaceId,
          resource_type: "plugin_installation",
          resource_id: input.installationId,
          target_type: accessTarget.targetType,
          relation: accessTarget.relation,
          subject_workspace_id: accessTarget.subjectWorkspaceId,
          subject_workspace_member_id:
            accessTarget.subjectWorkspaceMemberId,
          subject_actor_id: accessTarget.subjectActorId,
          subject_conversation_id: accessTarget.subjectConversationId,
          subject_conversation_actor_context_id:
            accessTarget.subjectConversationActorContextId,
          conversation_type_mask_override:
            input.conversationTypeMaskOverride ?? null,
          granted_permissions: input.permissions || [],
          metadata:
            (input.metadata || {}) as TableInsert<"access_bindings">["metadata"],
          status: "active",
          created_by_workspace_member_id:
            input.grantedByWorkspaceMemberId || null,
          reason: input.reason || plugin.authorization?.reason || null,
        })
        .returningAll(),
    );

    const accessRow = buildInstallationAccessRow({
      ...(inserted as unknown as AccessBindingRow),
      subject_actor_id: accessTarget.subjectActorId,
      subject_conversation_id: accessTarget.subjectConversationId,
      subject_conversation_actor_context_id:
        accessTarget.subjectConversationActorContextId,
    });
    const authzEntryIds = await queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "plugin_installation",
        resourceId: input.installationId,
        target: accessTarget,
        operation: "touch",
      }),
      {
        source: "plugin.access.grant",
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        accessBindingId: accessRow.id,
      },
    );

    return {
      accessRow,
      authzEntryIds,
    };
  });

  await flushQueuedAuthzEntries(result.authzEntryIds, "plugin.access.grant");
  await incrementMcpVersion(input.workspaceId);

  return mapAccessRowToGrant(
    result.accessRow,
    plugin.authorization?.requiredPermissions || [],
    plugin.authorization?.reason,
    {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        installation.conversation_type_mask_override ?? null,
    },
  );
}

export async function updatePluginInstallationAccessGrant(input: {
  workspaceId: string;
  installationId: string;
  grantId: string;
  conversationTypeMaskOverride?: number | null;
}) {
  if (input.conversationTypeMaskOverride === undefined) {
    const { plugin, installation, workspaceConversationTypeMask } =
      await getInstallationPayload(input.workspaceId, input.installationId);
    const accessRows = await listAccessRows(input.installationId);
    const accessRow = accessRows.find((entry) => entry.id === input.grantId);
    if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
      throw new McpPluginError(404, "Access grant not found");
    }
    return mapAccessRowToGrant(
      accessRow,
      plugin.authorization?.requiredPermissions || [],
      plugin.authorization?.reason,
      {
        workspaceConversationTypeMask,
        instanceConversationTypeMaskOverride:
          installation.conversation_type_mask_override ?? null,
      },
    );
  }

  const { plugin, installation, workspaceConversationTypeMask } =
    await getInstallationPayload(input.workspaceId, input.installationId);
  const accessRows = await listAccessRows(input.installationId, true);
  const accessRow = accessRows.find((entry) => entry.id === input.grantId);
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new McpPluginError(404, "Access grant not found");
  }

  await db
    .updateTable("access_bindings")
    .set({
      conversation_type_mask_override:
        input.conversationTypeMaskOverride ?? null,
    })
    .where("id", "=", input.grantId)
    .where("workspace_id", "=", input.workspaceId)
    .executeTakeFirst();

  const updatedAccessRows = await listAccessRows(input.installationId);
  const updatedAccessRow = updatedAccessRows.find((entry) => entry.id === input.grantId);
  if (!updatedAccessRow) {
    throw new McpPluginError(404, "Access grant not found");
  }

  return mapAccessRowToGrant(
    updatedAccessRow,
    plugin.authorization?.requiredPermissions || [],
    plugin.authorization?.reason,
    {
      workspaceConversationTypeMask,
      instanceConversationTypeMaskOverride:
        installation.conversation_type_mask_override ?? null,
    },
  );
}

export async function revokePluginInstallationAccess(input: {
  workspaceId: string;
  installationId: string;
  grantId: string;
}) {
  const accessRows = await listAccessRows(input.installationId, true);
  const accessRow = accessRows.find((entry) => entry.id === input.grantId);
  if (!accessRow || accessRow.workspace_id !== input.workspaceId) {
    throw new McpPluginError(404, "Access grant not found");
  }
  if (accessRow.status === "revoked") {
    return mapAccessRowToGrant(accessRow, [], undefined);
  }

  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      buildResourceAccessAuthzMutations({
        resourceType: "plugin_installation",
        resourceId: accessRow.installation_id,
        target: readAccessBindingTarget(accessRow),
        operation: "delete",
      }),
      {
        source: "plugin.access.revoke",
        workspaceId: input.workspaceId,
        installationId: input.installationId,
        accessBindingId: accessRow.id,
      },
    );

    await executeCompiledQuery(
      client,
      db
        .updateTable("access_bindings")
        .set({
          status: "revoked",
          revoked_at: sql`NOW()`,
        })
        .where("id", "=", accessRow.id),
    );

    return ids;
  });

  await flushQueuedAuthzEntries(authzEntryIds, "plugin.access.revoke");
  await incrementMcpVersion(input.workspaceId);

  return {
    id: accessRow.id,
    revoked: true,
  };
}

export async function createPluginInstallPlan(input: {
  workspaceId: string;
  pluginId: string;
  attachmentTarget: AttachmentTarget;
}) {
  const plugin = await getPlugin(input.pluginId);
  const defaultAccessTarget = defaultAccessTargetForAttachment(
    input.attachmentTarget,
  );
  return {
    packageId: plugin.id,
    revisionId: (
      await getPluginCatalogRowByItemId(plugin.id)
    )!.version_id,
    workspaceId: input.workspaceId,
    attachmentTarget: input.attachmentTarget,
    defaultAccessTarget,
    checks: [],
    grantPlan: buildPluginGrantPlan({
      authorization: plugin.authorization,
      attachmentTarget: input.attachmentTarget,
    }),
  };
}

export function validateConfig(
  config: Record<string, unknown>,
  rules: McpValidationRule[],
) {
  const errors: { field: string; message: string }[] = [];

  for (const rule of rules) {
    const value = config[rule.field];
    switch (rule.rule) {
      case "required":
        if (isConfigValueMissing(value)) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case "pattern":
        if (
          typeof value === "string" &&
          rule.value &&
          !new RegExp(rule.value as string).test(value)
        ) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case "url":
        if (typeof value === "string" && value) {
          try {
            new URL(value);
          } catch {
            errors.push({ field: rule.field, message: rule.message });
          }
        }
        break;
      case "min_length":
        if (
          typeof value === "string" &&
          value.length < Number(rule.value)
        ) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case "max_length":
        if (
          typeof value === "string" &&
          value.length > Number(rule.value)
        ) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case "prefix":
        if (
          typeof value === "string" &&
          !value.startsWith(String(rule.value || ""))
        ) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
      case "enum":
        if (
          Array.isArray(rule.value) &&
          !rule.value.includes(value as string)
        ) {
          errors.push({ field: rule.field, message: rule.message });
        }
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function seedBuiltinMcpPlugins() {
  await seedBuiltinPluginCategories();

  for (const seed of builtinSeeds) {
    const publisher = await createOrganization({
      slug: seed.slug,
      displayName: seed.displayName,
      description: seed.description,
      isBuiltin: true,
      isVerified: true,
    });

    for (const pluginSeed of seed.plugins) {
      let icon: { id: string } | null = null;
      if (pluginSeed.iconAssetPath) {
        try {
          icon = await ensureBuiltinPluginIcon(
            seed.slug,
            pluginSeed.slug,
            pluginSeed.iconAssetPath,
          );
        } catch (error) {
          console.warn(
            `[builtin-mcp] Failed to persist icon for ${seed.slug}/${pluginSeed.slug}; continuing without icon`,
            error,
          );
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
        defaultInstanceScope: pluginSeed.defaultInstanceScope,
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
      });
    }
  }
}

export async function seedBuiltinPluginCategories() {
  for (const category of builtinCapabilityCategories) {
    if (category.targetKind !== "plugin") continue;
    await db
      .insertInto("catalog_categories")
      .values({
        slug: category.slug,
        item_kind: "plugin_package",
        display_name: category.displayName,
        description: category.description || "",
        sort_order: category.sortOrder,
        metadata: {
          displayNameI18n: category.displayNameI18n || {
            en: category.displayName,
          },
          descriptionI18n: category.descriptionI18n || {
            en: category.description || "",
          },
          defaultLocale: category.defaultLocale || "en",
        } as TableInsert<"catalog_categories">["metadata"],
      })
      .onConflict((oc) =>
        oc.columns(["item_kind", "slug"]).doUpdateSet({
          display_name: category.displayName,
          description: category.description || "",
          sort_order: category.sortOrder,
          metadata: {
            displayNameI18n: category.displayNameI18n || {
              en: category.displayName,
            },
            descriptionI18n: category.descriptionI18n || {
              en: category.description || "",
            },
            defaultLocale: category.defaultLocale || "en",
          } as TableInsert<"catalog_categories">["metadata"],
          updated_at: sql`NOW()`,
        }),
      )
      .execute();
  }
}
