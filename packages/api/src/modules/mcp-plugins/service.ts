import crypto from "node:crypto";
import fs from "node:fs/promises";
import type pg from "pg";
import { nowISO } from "@synapse/shared";
import type {
  AccessGrant,
  AccessGrantScope,
} from "@synapse/shared/types";
import type {
  AttachmentScope,
  PluginAuthProviderDefinition,
  PluginConfigFieldDefinition,
  PluginConfigFieldState,
  PluginInstallFlow,
  ReuseScope,
  McpSetupStep,
  McpValidationRule,
  PluginReuseScopeV2,
  RuntimeBindingScope,
} from "@synapse/shared";
import { encryptSensitiveFields, isEncrypted } from "../../infrastructure/crypto/index.js";
import {
  deleteRelation,
  flushAuthzOutboxEntries,
  queueAuthzRelationships,
  touchRelation,
  type AuthzRelationMutation,
} from "../../infrastructure/authz/index.js";
import { query, transaction } from "../../infrastructure/database/index.js";
import { emitEvent } from "../../infrastructure/events/index.js";
import { saveFromBuffer } from "../../infrastructure/storage/file-io.js";
import {
  attachAuthConnectionsToConfig,
} from "./auth-service.js";
import { incrementMcpVersion } from "./instance-manager.js";
import { builtinCapabilityCategories } from "./builtin-plugins/categories.js";
import { builtinSeeds } from "./builtin-plugins/index.js";
import {
  buildResourceAccessAuthzMutations,
  isPrimaryAccessBinding,
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
  item_metadata: unknown;
  item_created_at: string;
  item_updated_at: string;
  version_id: string | null;
  version_value: string | null;
  version_status: "draft" | "active" | "deprecated" | "archived" | null;
  version_changelog: string | null;
  version_metadata: unknown;
  version_created_by: string | null;
  version_created_at: string | null;
  spec_transport: "builtin" | "stdio" | "http" | "relay" | null;
  spec_entry_point: string | null;
  spec_tool_manifest: unknown;
  spec_config_schema: unknown;
  spec_default_config: unknown;
  spec_install_flow: unknown;
  spec_auth_providers: unknown;
  spec_default_mount_scope: RuntimeBindingScope | null;
  spec_default_reuse_scope: PluginReuseScopeV2 | null;
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
  config_data: unknown;
  approved_runtime_permissions: string[] | null;
  reuse_scope: PluginReuseScopeV2;
  installation_status: "active" | "disabled" | "error" | "archived";
  installed_by: string | null;
  installation_metadata: unknown;
  installation_created_at: string;
  installation_updated_at: string;
  source_catalog_item_id: string | null;
  source_catalog_version_id: string | null;
  source_sync_mode: "notify" | "manual_merge" | "follow_upstream" | "detached" | null;
  primary_access_id: string | null;
  primary_attachment_scope: RuntimeBindingScope | null;
  primary_conversation_id: string | null;
  primary_actor_id: string | null;
  primary_user_id: string | null;
  primary_access_status: "active" | "revoked" | null;
  primary_access_metadata: unknown;
  primary_access_created_by: string | null;
  primary_access_created_at: string | null;
};

type InstallationAccessRow = AccessBindingRow & {
  installation_id: string;
  attachment_scope: RuntimeBindingScope;
  conversation_id: string | null;
  actor_id: string | null;
  user_id: string | null;
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
    item.metadata AS item_metadata,
    item.created_at AS item_created_at,
    item.updated_at AS item_updated_at,
    version.id AS version_id,
    version.version AS version_value,
    version.status AS version_status,
    version.changelog AS version_changelog,
    version.metadata AS version_metadata,
    version.created_by AS version_created_by,
    version.created_at AS version_created_at,
    spec.transport AS spec_transport,
    spec.entry_point AS spec_entry_point,
    spec.tool_manifest AS spec_tool_manifest,
    spec.config_schema AS spec_config_schema,
    spec.default_config AS spec_default_config,
    spec.install_flow AS spec_install_flow,
    spec.auth_providers AS spec_auth_providers,
    spec.default_mount_scope AS spec_default_mount_scope,
    spec.default_reuse_scope AS spec_default_reuse_scope,
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

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function publicAttachmentScope(
  scope: RuntimeBindingScope | null | undefined,
): Exclude<AttachmentScope, "platform"> {
  switch (scope) {
    case "actor":
      return "actor_global";
    case "workspace":
    case "conversation":
    case "actor_conversation":
    case "user":
      return scope;
    default:
      return "workspace";
  }
}

function internalAttachmentScope(
  scope: Exclude<AttachmentScope, "platform">,
): RuntimeBindingScope {
  return scope === "actor_global" ? "actor" : scope;
}

function publicReuseScope(
  scope: PluginReuseScopeV2 | null | undefined,
): Exclude<ReuseScope, "platform"> {
  switch (scope) {
    case "actor":
      return "actor_global";
    case "turn":
    case "workspace":
    case "conversation":
    case "actor_conversation":
    case "user":
      return scope;
    default:
      return "conversation";
  }
}

function internalReuseScope(
  scope: Exclude<ReuseScope, "platform">,
): PluginReuseScopeV2 {
  return scope === "actor_global" ? "actor" : scope;
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

  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'files'
     ) AS exists`,
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

  const existing = await query(
    `SELECT id, stored_name
     FROM files
     WHERE workspace_id IS NULL
       AND category = 'plugin_asset'
       AND metadata->>'builtin_plugin_icon_key' = $1
       AND metadata->>'sha256' = $2
     LIMIT 1`,
    [key, sha256],
  );

  if (existing.rows.length > 0) {
    return {
      id: existing.rows[0].id,
      iconUrl: `/files/${existing.rows[0].stored_name}`,
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
    iconUrl: file.url,
  };
}

function authorizationFromRuntimePermissions(
  runtimePermissions: unknown,
  defaultScope: Exclude<AttachmentScope, "platform">,
  specMetadata: JsonObject,
) {
  const rows = asArray<JsonObject>(runtimePermissions);
  const metadataAuthorization = asObject(specMetadata.authorization);

  return {
    requiredPermissions: rows
      .filter((row) => row.isRequired !== false)
      .map((row) => String(row.permissionKey || ""))
      .filter(Boolean),
    defaultGrantScope:
      (metadataAuthorization.defaultGrantScope as AccessGrantScope | undefined) ||
      defaultScope,
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
    icon_url:
      typeof itemMetadata.iconUrl === "string" ? itemMetadata.iconUrl : null,
    version: row.version_value || "1.0.0",
    transport: row.spec_transport || "builtin",
    entry_point: row.spec_entry_point || "",
    lifecycle_scope: publicReuseScope(row.spec_default_reuse_scope),
    default_reuse_scope: publicReuseScope(row.spec_default_reuse_scope),
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
    auth_providers: asArray<PluginAuthProviderDefinition>(row.spec_auth_providers),
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
    logo_url:
      typeof metadata.logoUrl === "string" ? metadata.logoUrl : null,
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
  authProviders: PluginAuthProviderDefinition[],
) {
  const rawConfig = asObject(installation.config_data);
  const schemaProperties = asObject(configSchema.properties);
  const fieldMap = new Map(configFields.map((field) => [field.key, field]));
  const providerMap = new Map(authProviders.map((provider) => [provider.key, provider]));
  const sanitizedConfig: Record<string, unknown> = {};
  const configState: PluginConfigFieldState[] = [];

  for (const [key, value] of Object.entries(rawConfig)) {
    const field = fieldMap.get(key);

    if (
      field?.type === "oauth_connection" &&
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
        providerKey:
          typeof ref.providerKey === "string"
            ? ref.providerKey
            : field.authProviderKey,
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
        field.type !== "oauth_connection" &&
        !field.serverManaged)
    ) {
      continue;
    }

    const provider = field.authProviderKey
      ? providerMap.get(field.authProviderKey)
      : undefined;
    configState.push({
      key: field.key,
      isConfigured: false,
      accountDisplayName: provider
        ? Object.values(provider.displayNameI18n || {})[0]
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
  attachmentType: Exclude<AttachmentScope, "platform">;
  actorId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
}) {
  switch (input.attachmentType) {
    case "workspace":
      return {
        mountScope: "workspace" as const,
        actorId: null,
        conversationId: null,
        userId: null,
      };
    case "conversation":
      if (!input.conversationId) {
        throw new McpPluginError(400, "conversationId is required for conversation scope");
      }
      return {
        mountScope: "conversation" as const,
        actorId: null,
        conversationId: input.conversationId,
        userId: null,
      };
    case "actor_global":
      if (!input.actorId) {
        throw new McpPluginError(400, "actorId is required for actor scope");
      }
      return {
        mountScope: "actor" as const,
        actorId: input.actorId,
        conversationId: null,
        userId: null,
      };
    case "actor_conversation":
      if (!input.actorId || !input.conversationId) {
        throw new McpPluginError(
          400,
          "actorId and conversationId are required for actor_conversation scope",
        );
      }
      return {
        mountScope: "actor_conversation" as const,
        actorId: input.actorId,
        conversationId: input.conversationId,
        userId: null,
      };
    case "user":
      if (!input.userId) {
        throw new McpPluginError(400, "userId is required for user scope");
      }
      return {
        mountScope: "user" as const,
        actorId: null,
        conversationId: null,
        userId: input.userId,
      };
    default:
      throw new McpPluginError(400, `Unsupported attachment type: ${String(input.attachmentType)}`);
  }
}

function attachmentIdForTarget(target: {
  workspace_id: string;
  attachment_scope: RuntimeBindingScope;
  actor_id: string | null;
  conversation_id: string | null;
  user_id: string | null;
}) {
  switch (target.attachment_scope) {
    case "workspace":
      return target.workspace_id;
    case "conversation":
      return target.conversation_id;
    case "actor":
      return target.actor_id;
    case "actor_conversation":
      return `${target.actor_id || ""}:${target.conversation_id || ""}`;
    case "user":
      return target.user_id;
  }
}

function buildPluginInstallationAuthzMutations(params: {
  installationId: string;
  workspaceId: string;
  ownerUserId?: string | null;
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

  if (params.ownerUserId) {
    relations.push(
      mutate(
        "plugin_installation",
        params.installationId,
        "owner",
        "user",
        params.ownerUserId,
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
    attachment_scope: target.bindScope,
    actor_id: target.actorId,
    conversation_id: target.conversationId,
    user_id: target.userId,
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
  whereSql: string,
  params: unknown[],
) {
  const result = await query<PluginCatalogRow>(
    `${PLUGIN_CATALOG_SELECT}
     ${whereSql}`,
    params,
  );
  return result.rows;
}

async function loadPluginCatalogMapByVersionIds(versionIds: string[]) {
  if (versionIds.length === 0) {
    return new Map<string, ReturnType<typeof mapPluginView>>();
  }

  const rows = await loadPluginCatalogRows(
    `AND version.id = ANY($1::uuid[])`,
    [versionIds],
  );

  return new Map(rows.map((row) => [row.version_id!, mapPluginView(row)]));
}

async function getPluginCatalogRowByItemId(itemId: string) {
  const rows = await loadPluginCatalogRows(
    `AND item.id = $1
     AND version.id = item.latest_version_id
     LIMIT 1`,
    [itemId],
  );

  return rows[0] || null;
}

async function loadInstallationRows(
  workspaceId: string,
  filters?: {
    attachmentType?: Exclude<AttachmentScope, "platform">;
    conversationId?: string;
    actorId?: string;
    userId?: string;
    pluginId?: string;
    installationId?: string;
  },
) {
  const conditions = [`installation.workspace_id = $1`];
  const values: unknown[] = [workspaceId];
  let index = 2;

  if (filters?.pluginId) {
    conditions.push(`installation.catalog_item_id = $${index++}`);
    values.push(filters.pluginId);
  }

  if (filters?.installationId) {
    conditions.push(`installation.id = $${index++}`);
    values.push(filters.installationId);
  }

  const result = await query<InstallationRow>(
    `SELECT
       installation.id AS installation_id,
       installation.workspace_id,
       installation.catalog_item_id,
       installation.catalog_version_id,
       installation.display_name AS installation_display_name,
       installation.config_data,
       installation.approved_runtime_permissions,
       installation.reuse_scope,
       installation.status AS installation_status,
       installation.installed_by,
       installation.metadata AS installation_metadata,
       installation.created_at AS installation_created_at,
       installation.updated_at AS installation_updated_at,
       source_ref.source_catalog_item_id,
       source_ref.source_catalog_version_id,
       source_ref.sync_mode AS source_sync_mode,
       primary_access.id AS primary_access_id,
       primary_access.attachment_scope AS primary_attachment_scope,
       primary_access.conversation_id AS primary_conversation_id,
       primary_access.actor_id AS primary_actor_id,
       primary_access.user_id AS primary_user_id,
       primary_access.status AS primary_access_status,
       primary_access.metadata AS primary_access_metadata,
       primary_access.created_by AS primary_access_created_by,
       primary_access.created_at AS primary_access_created_at
     FROM plugin_installations installation
     LEFT JOIN plugin_source_refs source_ref
       ON source_ref.installation_id = installation.id
     LEFT JOIN LATERAL (
       SELECT
         binding.id,
         CASE
           WHEN binding.relation = 'use_workspace' THEN 'workspace'
           WHEN binding.relation = 'use_conversation' THEN 'conversation'
           WHEN binding.relation = 'use_actor_conversation' THEN 'actor_conversation'
           WHEN binding.relation = 'use_principal' AND binding.subject_type = 'actor' THEN 'actor'
           ELSE 'user'
         END AS attachment_scope,
         NULLIF(binding.metadata->>'conversationId', '') AS conversation_id,
         NULLIF(binding.metadata->>'actorId', '') AS actor_id,
         NULLIF(binding.metadata->>'userId', '') AS user_id,
         binding.status,
         binding.metadata,
         binding.created_by,
         binding.created_at
       FROM access_bindings binding
       WHERE binding.resource_type = 'plugin_installation'
         AND binding.resource_id = installation.id::text
         AND binding.status = 'active'
         AND COALESCE((binding.metadata->>'isPrimary')::boolean, FALSE) = TRUE
       ORDER BY binding.created_at ASC
       LIMIT 1
     ) primary_access ON TRUE
     WHERE ${conditions.join(" AND ")}
     ORDER BY installation.created_at DESC`,
    values,
  );

  return result.rows.filter((row) => {
    const attachmentScope = publicAttachmentScope(
      row.primary_attachment_scope || "workspace",
    );
    if (filters?.attachmentType && attachmentScope !== filters.attachmentType) {
      return false;
    }
    if (filters?.conversationId && row.primary_conversation_id !== filters.conversationId) {
      return false;
    }
    if (filters?.actorId && row.primary_actor_id !== filters.actorId) {
      return false;
    }
    if (filters?.userId && row.primary_user_id !== filters.userId) {
      return false;
    }
    return true;
  });
}

async function listAccessRows(installationId: string, includeRevoked = false) {
  const result = await query<AccessBindingRow>(
    `SELECT
       id,
       workspace_id,
       resource_type,
       resource_id,
       relation,
       subject_type,
       subject_id,
       subject_relation,
       status,
       created_by,
       reason,
       metadata,
       created_at,
       revoked_at
     FROM access_bindings
     WHERE resource_type = 'plugin_installation'
       AND resource_id = $1
       ${includeRevoked ? "" : "AND status = 'active'"}
     ORDER BY created_at ASC`,
    [installationId],
  );
  return result.rows.map(buildInstallationAccessRow);
}

function buildPluginGrantPlan(input: {
  authorization: {
    requiredPermissions: string[];
    defaultGrantScope?: AccessGrantScope;
    reason?: string;
  };
  attachmentType: Exclude<AttachmentScope, "platform">;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const requiredPermissions = input.authorization.requiredPermissions || [];
  if (requiredPermissions.length === 0) {
    return {
      requiresGrant: false,
      requiredPermissions: [],
    };
  }

  let suggestedGrantScope =
    input.authorization.defaultGrantScope || input.attachmentType;

  if (
    suggestedGrantScope === "conversation" &&
    !input.conversationId
  ) {
    suggestedGrantScope = input.attachmentType;
  }
  if (
    suggestedGrantScope === "actor_global" &&
    !input.actorId
  ) {
    suggestedGrantScope = input.attachmentType;
  }
  if (
    suggestedGrantScope === "actor_conversation" &&
    (!input.actorId || !input.conversationId)
  ) {
    suggestedGrantScope = input.attachmentType;
  }
  if (suggestedGrantScope === "user" && !input.userId) {
    suggestedGrantScope = input.attachmentType;
  }

  return {
    requiresGrant: true,
    requiredPermissions,
    suggestedGrantScope,
    reason: input.authorization.reason,
  };
}

function mapAccessRowToGrant(
  mount: InstallationAccessRow,
  requiredPermissions: string[],
  reason?: string,
): AccessGrant {
  return mapAccessBindingToGrant(mount, requiredPermissions, reason);
}

function buildInstallationPayload(
  row: InstallationRow,
  plugin: ReturnType<typeof mapPluginView>,
) {
  const primaryAccess = {
    workspace_id: row.workspace_id,
    attachment_scope: row.primary_attachment_scope || "workspace",
    actor_id: row.primary_actor_id,
    conversation_id: row.primary_conversation_id,
    user_id: row.primary_user_id,
  };
  const { sanitizedConfig, configState } = sanitizeInstallationConfig(
    {
      config_data: row.config_data,
      updated_at: row.installation_updated_at,
    },
    plugin.config_schema || {},
    plugin.config_fields || [],
    plugin.auth_providers || [],
  );

  const attachmentType = publicAttachmentScope(row.primary_attachment_scope || "workspace");

  return {
    id: row.installation_id,
    workspace_id: row.workspace_id,
    plugin_id: row.catalog_item_id,
    attachment_type: attachmentType,
    attachment_id: attachmentIdForTarget(primaryAccess),
    attachment_actor_id: row.primary_actor_id,
    attachment_conversation_id: row.primary_conversation_id,
    attachment_user_id: row.primary_user_id,
    lifecycle_scope: publicReuseScope(row.reuse_scope),
    is_enabled:
      row.installation_status === "active" &&
      row.primary_access_status !== "revoked" &&
      Boolean(row.primary_access_id),
    status: row.installation_status,
    config_data: sanitizedConfig,
    config_state: configState,
    approved_runtime_permissions: row.approved_runtime_permissions || [],
    installed_by: row.installed_by,
    metadata: asObject(row.installation_metadata),
    created_at: row.installation_created_at,
    updated_at: row.installation_updated_at,
    source_catalog_item_id: row.source_catalog_item_id,
    source_catalog_version_id: row.source_catalog_version_id,
    source_sync_mode: row.source_sync_mode,
    primary_access_id: row.primary_access_id,
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
    tools_manifest: plugin.tools_manifest,
    plugin_icon_url: plugin.icon_url,
    plugin_categories: plugin.categories || [],
    plugin_category_slugs: plugin.category_slugs || [],
    plugin_version: plugin.version,
    config_schema: plugin.config_schema,
    config_fields: plugin.config_fields,
    install_flow: plugin.install_flow,
    auth_providers: plugin.auth_providers,
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

  return {
    row,
    plugin,
    installation: buildInstallationPayload(row, plugin),
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
    iconUrl?: string;
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
    iconUrl: input.iconUrl || null,
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
           metadata = $7::jsonb,
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
       source_kind,
       visibility,
       tags,
       is_active,
       metadata
     )
     VALUES (
       $1, $2, 'plugin_package', $3, $4, $5, $6, $7, 'public', $8, TRUE, $9::jsonb
     )
     RETURNING id`,
    [
      input.orgId,
      input.workspaceId || null,
      normalizedSlug,
      input.displayName,
      input.description || "",
      input.longDescription || "",
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
    defaultInstanceScope?: AttachmentScope;
    requiresHandshake?: boolean;
    toolsManifest?: unknown[];
    configSchema?: Record<string, unknown>;
    defaultConfig?: Record<string, unknown>;
    installFlow?: PluginInstallFlow;
    authProviders?: PluginAuthProviderDefinition[];
    configFields?: PluginConfigFieldDefinition[];
    validationRules?: McpValidationRule[];
    setupSteps?: McpSetupStep[];
    authorization?: {
      requiredPermissions?: string[];
      defaultGrantScope?: AttachmentScope;
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
      defaultGrantScope: input.authorization?.defaultGrantScope || undefined,
      reason: input.authorization?.reason || undefined,
    },
  };

  await run(
    `INSERT INTO plugin_package_version_specs (
       catalog_version_id,
       transport,
       entry_point,
       tool_manifest,
       config_schema,
       default_config,
       install_flow,
       auth_providers,
       default_mount_scope,
       default_reuse_scope,
       requires_handshake,
       metadata
     )
     VALUES (
       $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
       $9, $10, $11, $12::jsonb
     )
     ON CONFLICT (catalog_version_id) DO UPDATE
       SET transport = EXCLUDED.transport,
           entry_point = EXCLUDED.entry_point,
           tool_manifest = EXCLUDED.tool_manifest,
           config_schema = EXCLUDED.config_schema,
           default_config = EXCLUDED.default_config,
           install_flow = EXCLUDED.install_flow,
           auth_providers = EXCLUDED.auth_providers,
           default_mount_scope = EXCLUDED.default_mount_scope,
           default_reuse_scope = EXCLUDED.default_reuse_scope,
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
      JSON.stringify(input.authProviders || []),
      internalAttachmentScope(
        ((input.defaultInstanceScope || "workspace") as Exclude<
          AttachmentScope,
          "platform"
        >),
      ),
      internalReuseScope(
        ((input.lifecycleScope || "conversation") as Exclude<
          ReuseScope,
          "platform"
        >),
      ),
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
  logoUrl?: string;
  isBuiltin?: boolean;
  isVerified?: boolean;
  ownerUserId?: string;
}) {
  const normalizedSlug = sanitizeSlug(data.slug);
  const result = await query<PublisherRow>(
    `INSERT INTO publishers (
       slug,
       display_name,
       description,
       owner_user_id,
       workspace_id,
       is_builtin,
       is_verified,
       metadata
     )
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7::jsonb)
     ON CONFLICT (slug) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           owner_user_id = COALESCE(publishers.owner_user_id, EXCLUDED.owner_user_id),
           is_builtin = EXCLUDED.is_builtin,
           is_verified = EXCLUDED.is_verified,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
     RETURNING *`,
    [
      normalizedSlug,
      data.displayName,
      data.description || "",
      data.ownerUserId || null,
      data.isBuiltin === true,
      data.isVerified === true,
      JSON.stringify({
        logoUrl: data.logoUrl || null,
      }),
    ],
  );

  return mapPublisherView(result.rows[0]!);
}

export async function listOrganizations() {
  const result = await query<PublisherRow>(
    `SELECT
       publisher.*,
       COUNT(item.id)::int AS plugin_count
     FROM publishers publisher
     LEFT JOIN catalog_items item
       ON item.publisher_id = publisher.id
      AND item.item_kind = 'plugin_package'
      AND item.is_active = TRUE
      AND item.workspace_id IS NULL
     GROUP BY publisher.id
     ORDER BY publisher.is_verified DESC, publisher.display_name ASC`,
  );

  return result.rows.map(mapPublisherView);
}

export async function getOrganization(id: string) {
  const result = await query<PublisherRow>(
    `SELECT *, 0::int AS plugin_count
     FROM publishers
     WHERE id = $1
     LIMIT 1`,
    [id],
  );

  if (result.rows.length === 0) {
    throw new McpPluginError(404, "Publisher not found");
  }

  return mapPublisherView(result.rows[0]!);
}

export async function getOrganizationBySlug(slug: string) {
  const result = await query<PublisherRow>(
    `SELECT *, 0::int AS plugin_count
     FROM publishers
     WHERE slug = $1
     LIMIT 1`,
    [sanitizeSlug(slug)],
  );

  return result.rows[0] ? mapPublisherView(result.rows[0]) : null;
}

export async function createPlugin(data: {
  orgId: string;
  workspaceId?: string;
  slug: string;
  displayName: string;
  description?: string;
  longDescription?: string;
  iconUrl?: string;
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
  authProviders?: PluginAuthProviderDefinition[];
  displayNameI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
  longDescriptionI18n?: Record<string, string>;
  summaryI18n?: Record<string, string>;
  defaultLocale?: string;
  defaultInstanceScope?: AttachmentScope;
  requiresHandshake?: boolean;
  authorization?: {
    requiredPermissions?: string[];
    defaultGrantScope?: AttachmentScope;
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
  const conditions = [
    "version.id = item.latest_version_id",
    "item.is_active = TRUE",
    "item.workspace_id IS NULL",
  ];
  const values: unknown[] = [];
  let index = 1;

  if (filters?.orgId) {
    conditions.push(`item.publisher_id = $${index++}`);
    values.push(filters.orgId);
  }

  if (filters?.transport) {
    conditions.push(`spec.transport = $${index++}`);
    values.push(filters.transport);
  }

  if (filters?.search) {
    conditions.push(
      `(item.display_name ILIKE $${index} OR item.summary ILIKE $${index} OR item.long_description ILIKE $${index} OR EXISTS (
         SELECT 1
         FROM unnest(COALESCE(item.tags, ARRAY[]::text[])) tag
         WHERE tag ILIKE $${index}
       ))`,
    );
    values.push(`%${filters.search.trim()}%`);
    index += 1;
  }

  if (filters?.tags && filters.tags.length > 0) {
    conditions.push(`item.tags && $${index++}::text[]`);
    values.push(filters.tags);
  }

  if (filters?.categorySlugs && filters.categorySlugs.length > 0) {
    conditions.push(
      `EXISTS (
         SELECT 1
         FROM catalog_item_categories item_category
         JOIN catalog_categories category
           ON category.id = item_category.category_id
         WHERE item_category.catalog_item_id = item.id
           AND category.item_kind = 'plugin_package'
           AND category.slug = ANY($${index}::text[])
       )`,
    );
    values.push(filters.categorySlugs);
    index += 1;
  }

  const rows = await loadPluginCatalogRows(
    `AND ${conditions.join(" AND ")}
     ORDER BY item.download_count DESC, item.created_at DESC`,
    values,
  );

  return rows.map(mapPluginView);
}

export async function listPluginCategories() {
  const result = await query<PluginCategoryRow>(
    `SELECT *
     FROM catalog_categories
     WHERE item_kind = 'plugin_package'
     ORDER BY sort_order ASC, display_name ASC`,
  );

  return result.rows.map((row) => {
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

export function validateLifecycleHierarchy(
  attachmentType: AttachmentScope,
  lifecycleScope: ReuseScope,
) {
  switch (attachmentType) {
    case "workspace":
      return [
        "workspace",
        "conversation",
        "actor_global",
        "actor_conversation",
        "user",
        "turn",
      ].includes(lifecycleScope);
    case "conversation":
      return ["conversation", "actor_conversation", "turn"].includes(lifecycleScope);
    case "actor_global":
      return ["actor_global", "turn"].includes(lifecycleScope);
    case "actor_conversation":
      return ["actor_conversation", "turn"].includes(lifecycleScope);
    case "user":
      return [
        "workspace",
        "conversation",
        "actor_global",
        "actor_conversation",
        "user",
        "turn",
      ].includes(lifecycleScope);
    default:
      return false;
  }
}

export async function installPluginUnified(data: {
  workspaceId: string;
  pluginId: string;
  attachmentType: Exclude<AttachmentScope, "platform">;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  lifecycleScope?: Exclude<ReuseScope, "platform">;
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
  installedBy?: string;
}) {
  const lifecycleScope = data.lifecycleScope || "conversation";
  if (!validateLifecycleHierarchy(data.attachmentType, lifecycleScope)) {
    throw new McpPluginError(
      400,
      `Reuse scope '${lifecycleScope}' is not valid for attachment '${data.attachmentType}'`,
    );
  }

  const plugin = await getPlugin(data.pluginId);
  const target = normalizeAttachmentTarget({
    attachmentType: data.attachmentType,
    actorId: data.actorId,
    conversationId: data.conversationId,
    userId: data.userId,
  });
  const approvedRuntimePermissions =
    plugin.authorization?.requiredPermissions || [];

  const result = await transaction(async (client) => {
    const insertedInstallation = await client.query<{ id: string }>(
      `INSERT INTO plugin_installations (
         workspace_id,
         catalog_item_id,
         catalog_version_id,
         display_name,
         config_data,
         approved_runtime_permissions,
         reuse_scope,
         status,
         installed_by,
         metadata
       )
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, 'active', $7, '{}'::jsonb)
       RETURNING id`,
      [
        data.workspaceId,
        plugin.id,
        (await getPluginCatalogRowByItemId(plugin.id))!.version_id,
        plugin.display_name,
        approvedRuntimePermissions,
        internalReuseScope(lifecycleScope),
        data.installedBy || null,
      ],
    );
    const installationId = insertedInstallation.rows[0]!.id;

    const resolvedConfigBase = data.configData || {};
    const resolvedConfig = await attachAuthConnectionsToConfig({
      installationId,
      workspaceId: data.workspaceId,
      userId: data.installedBy || data.userId || "",
      configFields: plugin.config_fields || [],
      authProviders: plugin.auth_providers || [],
      configData: resolvedConfigBase,
      authSessionIds: data.authSessionIds,
      run: client.query.bind(client) as QueryRunner,
    });
    const encryptedConfig = encryptSensitiveFields(
      resolvedConfig,
      plugin.config_schema || {},
    );

    await client.query(
      `UPDATE plugin_installations
       SET config_data = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [installationId, JSON.stringify(encryptedConfig)],
    );

    const primaryAccessTarget = resolveAccessGrantTarget({
      workspaceId: data.workspaceId,
      grantScope: data.attachmentType,
      actorId: target.actorId,
      conversationId: target.conversationId,
      userId: target.userId,
    });
    const insertedAccess = await client.query<{ id: string }>(
      `INSERT INTO access_bindings (
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         metadata,
         status,
         created_by,
         reason
       )
       VALUES ($1, 'plugin_installation', $2, $3, $4, $5, $6::jsonb, 'active', $7, $8)
       RETURNING id`,
      [
        data.workspaceId,
        installationId,
        primaryAccessTarget.relation,
        primaryAccessTarget.subjectType,
        primaryAccessTarget.subjectId,
        JSON.stringify({
          isPrimary: true,
          grantScope: data.attachmentType,
          actorId: target.actorId,
          conversationId: target.conversationId,
          userId: target.userId,
          requestedPermissions: approvedRuntimePermissions,
          reason: plugin.authorization?.reason || null,
        }),
        data.installedBy || null,
        plugin.authorization?.reason || null,
      ],
    );
    const primaryAccessId = insertedAccess.rows[0]!.id;

    await client.query(
      `INSERT INTO plugin_source_refs (
         installation_id,
         source_catalog_item_id,
         source_catalog_version_id,
         sync_mode,
         metadata
       )
       VALUES ($1, $2, $3, 'manual_merge', '{}'::jsonb)`,
      [
        installationId,
        plugin.id,
        (await getPluginCatalogRowByItemId(plugin.id))!.version_id,
      ],
    );

    await client.query(
      `UPDATE catalog_items
       SET download_count = download_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [plugin.id],
    );

    const authzEntryIds = await queueAuthzRelationships(
      client,
      [
        ...buildPluginInstallationAuthzMutations({
          installationId,
          workspaceId: data.workspaceId,
          ownerUserId: data.installedBy,
          operation: "touch",
        }),
        ...buildResourceAccessAuthzMutations({
          resourceType: "plugin_installation",
          resourceId: installationId,
          target: primaryAccessTarget,
          operation: "touch",
        }),
      ],
      {
        source: "plugin.install",
        workspaceId: data.workspaceId,
        installationId,
        accessBindingId: primaryAccessId,
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
  const rows = await query<{
    installation_id: string;
    workspace_id: string;
    installed_by: string | null;
  }>(
    `SELECT
       id AS installation_id,
       workspace_id,
       installed_by
     FROM plugin_installations
     WHERE id = $1
     LIMIT 1`,
    [installId],
  );
  if (rows.rows.length === 0) {
    throw new McpPluginError(404, "Installation not found");
  }

  const installation = rows.rows[0]!;
  const accessRows = await listAccessRows(installId, true);

  const authzEntryIds = await transaction(async (client) => {
    const ids = await queueAuthzRelationships(
      client,
      [
        ...buildPluginInstallationAuthzMutations({
          installationId: installId,
          workspaceId: installation.workspace_id,
          ownerUserId: installation.installed_by,
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

    await client.query(
      `DELETE FROM access_bindings
       WHERE resource_type = 'plugin_installation'
         AND resource_id = $1`,
      [installId],
    );

    await client.query(
      `DELETE FROM plugin_installations
       WHERE id = $1`,
      [installId],
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
    attachmentType?: Exclude<AttachmentScope, "platform">;
    conversationId?: string;
    actorId?: string;
    userId?: string;
    pluginId?: string;
  },
) {
  const rows = await loadInstallationRows(workspaceId, filters);
  const pluginsByVersionId = await loadPluginCatalogMapByVersionIds(
    Array.from(new Set(rows.map((row) => row.catalog_version_id))),
  );

  return rows
    .map((row) => {
      const plugin = pluginsByVersionId.get(row.catalog_version_id);
      return plugin ? buildInstallationPayload(row, plugin) : null;
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
    lifecycleScope?: Exclude<ReuseScope, "platform">;
    attachmentType?: Exclude<AttachmentScope, "platform">;
    actorId?: string | null;
    conversationId?: string | null;
    userId?: string | null;
    updatedBy?: string;
  },
) {
  const currentRows = await query<{ workspace_id: string }>(
    `SELECT workspace_id
     FROM plugin_installations
     WHERE id = $1
     LIMIT 1`,
    [installId],
  );
  if (currentRows.rows.length === 0) {
    throw new McpPluginError(404, "Installation not found");
  }

  const workspaceId = currentRows.rows[0]!.workspace_id;
  const { row, plugin } = await getInstallationPayload(workspaceId, installId);
  const accessRows = await listAccessRows(installId, true);
  const primaryAccess = accessRows.find((entry) => isPrimaryAccessBinding(entry));
  if (!primaryAccess) {
    throw new McpPluginError(500, "Installation is missing its primary access grant");
  }

  const nextAttachmentType =
    data.attachmentType || publicAttachmentScope(primaryAccess.attachment_scope);
  const nextLifecycleScope =
    data.lifecycleScope || publicReuseScope(row.reuse_scope);

  if (!validateLifecycleHierarchy(nextAttachmentType, nextLifecycleScope)) {
    throw new McpPluginError(
      400,
      `Reuse scope '${nextLifecycleScope}' is not valid for attachment '${nextAttachmentType}'`,
    );
  }

  const target = normalizeAttachmentTarget({
    attachmentType: nextAttachmentType,
    actorId:
      data.actorId !== undefined ? data.actorId : primaryAccess.actor_id,
    conversationId:
      data.conversationId !== undefined
        ? data.conversationId
        : primaryAccess.conversation_id,
    userId: data.userId !== undefined ? data.userId : primaryAccess.user_id,
  });
  const nextPrimaryAccessTarget = resolveAccessGrantTarget({
    workspaceId,
    grantScope: nextAttachmentType,
    actorId: target.actorId,
    conversationId: target.conversationId,
    userId: target.userId,
  });

  const mergedConfig = data.configData
    ? mergeConfigForUpdate(
        asObject(row.config_data),
        data.configData,
        plugin.config_fields || [],
      )
    : asObject(row.config_data);

  const authzEntryIds = await transaction(async (client) => {
    const run = client.query.bind(client) as QueryRunner;

    const resolvedConfig =
      data.configData || data.authSessionIds
        ? await attachAuthConnectionsToConfig({
            installationId: installId,
            workspaceId,
            userId: data.updatedBy || data.userId || "",
            configFields: plugin.config_fields || [],
            authProviders: plugin.auth_providers || [],
            configData: mergedConfig,
            authSessionIds: data.authSessionIds,
            run,
          })
        : mergedConfig;

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

    if (data.attachmentType) {
      await run(
        `UPDATE access_bindings
         SET relation = $2,
             subject_type = $3,
             subject_id = $4,
             metadata = $5::jsonb
         WHERE id = $1`,
        [
          primaryAccess.id,
          nextPrimaryAccessTarget.relation,
          nextPrimaryAccessTarget.subjectType,
          nextPrimaryAccessTarget.subjectId,
          JSON.stringify({
            ...asObject(primaryAccess.metadata),
            isPrimary: true,
            grantScope: nextAttachmentType,
            actorId: target.actorId,
            conversationId: target.conversationId,
            userId: target.userId,
          }),
        ],
      );

      return queueAuthzRelationships(
        client,
        [
          ...buildResourceAccessAuthzMutations({
            resourceType: "plugin_installation",
            resourceId: installId,
            target: readAccessBindingTarget(primaryAccess),
            operation: "delete",
          }),
          ...buildResourceAccessAuthzMutations({
            resourceType: "plugin_installation",
            resourceId: installId,
            target: nextPrimaryAccessTarget,
            operation: "touch",
          }),
        ],
        {
          source: "plugin.installation.update",
          workspaceId,
          installationId: installId,
        },
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
  const { installation, plugin } = await getInstallationPayload(
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
      ),
    );

  return {
    grants,
    summary: {
      requiredPermissions: plugin.authorization?.requiredPermissions || [],
      suggestedGrantScope:
        plugin.authorization?.defaultGrantScope || installation.attachment_type,
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
  grantScope?: Exclude<AccessGrantScope, "platform">;
  actorId?: string;
  conversationId?: string;
  userId?: string;
  permissions?: string[];
  grantedBy?: string;
  reason?: string;
  metadata?: JsonObject;
}) {
  const { plugin } = await getInstallationPayload(
    input.workspaceId,
    input.installationId,
  );
  const accessRows = await listAccessRows(input.installationId);
  const primaryAccess = accessRows.find((entry) => isPrimaryAccessBinding(entry));
  if (!primaryAccess) {
    throw new McpPluginError(500, "Installation is missing its primary access grant");
  }

  const grantScope =
    input.grantScope ||
    (plugin.authorization?.defaultGrantScope === "platform"
      ? undefined
      : plugin.authorization?.defaultGrantScope) ||
    publicAttachmentScope(primaryAccess.attachment_scope);
  const target = normalizeAttachmentTarget({
    attachmentType: grantScope,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
  });
  const accessTarget = resolveAccessGrantTarget({
    workspaceId: input.workspaceId,
    grantScope,
    actorId: target.actorId,
    conversationId: target.conversationId,
    userId: target.userId,
  });

  const existing = accessRows.find(
    (entry) =>
      entry.status === "active" &&
      entry.attachment_scope === target.mountScope &&
      entry.actor_id === target.actorId &&
      entry.conversation_id === target.conversationId &&
      entry.user_id === target.userId,
  );
  if (existing) {
    return mapAccessRowToGrant(
      existing,
      plugin.authorization?.requiredPermissions || [],
      plugin.authorization?.reason,
    );
  }

  const result = await transaction(async (client) => {
    const inserted = await client.query<AccessBindingRow>(
      `INSERT INTO access_bindings (
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         metadata,
         status,
         created_by,
         reason
       )
       VALUES ($1, 'plugin_installation', $2, $3, $4, $5, $6::jsonb, 'active', $7, $8)
       RETURNING
         id,
         workspace_id,
         resource_type,
         resource_id,
         relation,
         subject_type,
         subject_id,
         subject_relation,
         status,
         created_by,
         reason,
         metadata,
         created_at,
         revoked_at`,
      [
        input.workspaceId,
        input.installationId,
        accessTarget.relation,
        accessTarget.subjectType,
        accessTarget.subjectId,
        JSON.stringify({
          ...(input.metadata || {}),
          isPrimary: false,
          grantScope,
          actorId: target.actorId,
          conversationId: target.conversationId,
          userId: target.userId,
          requestedPermissions: input.permissions || [],
          reason: input.reason || plugin.authorization?.reason || null,
        }),
        input.grantedBy || null,
        input.reason || plugin.authorization?.reason || null,
      ],
    );

    const accessRow = buildInstallationAccessRow(inserted.rows[0]!);
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
  if (isPrimaryAccessBinding(accessRow)) {
    throw new McpPluginError(
      400,
      "Primary installation access cannot be removed. Update Advanced settings or uninstall the plugin instead.",
    );
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

    await client.query(
      `UPDATE access_bindings
       SET status = 'revoked',
           revoked_at = NOW()
       WHERE id = $1`,
      [accessRow.id],
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
  attachmentType: Exclude<AttachmentScope, "platform">;
  actorId?: string;
  conversationId?: string;
  userId?: string;
}) {
  const plugin = await getPlugin(input.pluginId);
  return {
    packageId: plugin.id,
    revisionId: (
      await getPluginCatalogRowByItemId(plugin.id)
    )!.version_id,
    workspaceId: input.workspaceId,
    attachmentType: input.attachmentType,
    actorId: input.actorId,
    conversationId: input.conversationId,
    userId: input.userId,
    checks: [],
    grantPlan: buildPluginGrantPlan({
      authorization: plugin.authorization,
      attachmentType: input.attachmentType,
      actorId: input.actorId,
      conversationId: input.conversationId,
      userId: input.userId,
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
        if (value === undefined || value === null || value === "") {
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
      let icon: { id: string; iconUrl: string } | null = null;
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
        iconUrl: icon?.iconUrl,
        transport: pluginSeed.transport,
        entryPoint: pluginSeed.entryPoint,
        lifecycleScope: pluginSeed.defaultReuseScope,
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
        authProviders: pluginSeed.authProviders,
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
    await query(
      `INSERT INTO catalog_categories (
         slug,
         item_kind,
         display_name,
         description,
         sort_order,
         metadata
       )
       VALUES ($1, 'plugin_package', $2, $3, $4, $5::jsonb)
       ON CONFLICT (item_kind, slug) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             description = EXCLUDED.description,
             sort_order = EXCLUDED.sort_order,
             metadata = EXCLUDED.metadata,
             updated_at = NOW()`,
      [
        category.slug,
        category.displayName,
        category.description || "",
        category.sortOrder,
        JSON.stringify({
          displayNameI18n: category.displayNameI18n || {
            en: category.displayName,
          },
          descriptionI18n: category.descriptionI18n || {
            en: category.description || "",
          },
          defaultLocale: category.defaultLocale || "en",
        }),
      ],
    );
  }
}
