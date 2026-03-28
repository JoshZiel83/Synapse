import { createHash, randomBytes } from "crypto";
import type pg from "pg";
import type {
  PluginAuthBindingDefinition,
  PluginAuthConnection,
  PluginAuthSession,
  PluginAuthValueSource,
  PluginConfigFieldDefinition,
} from "@synapse/shared";
import { config } from "../../config/index.js";
import {
  decrypt,
  decryptSensitiveFields,
  encrypt,
} from "../../infrastructure/crypto/index.js";
import { query } from "../../infrastructure/database/index.js";
import {
  normalizeMijiaLocale,
  progressMijiaQrLoginSession,
  startMijiaQrLoginSession,
} from "./mijia/auth.js";
import {
  progressFeishuCliSetup,
  refreshFeishuUserAccessToken,
  startFeishuCliSetup,
} from "./feishu/auth.js";
import {
  resolveFeishuAccountsBaseUrl,
  resolveFeishuOpenBaseUrl,
} from "./feishu/client.js";
import {
  assertFeishuInitialSetupFeatures,
  normalizeFeishuFeatureKeys,
} from "./feishu/features.js";

type JsonObject = Record<string, unknown>;
type QueryRunner = <T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
) => Promise<{ rows: T[] }>;

type PluginAuthSessionRow = {
  id: string;
  workspace_id: string;
  catalog_item_id: string;
  catalog_version_id: string | null;
  installation_id: string | null;
  binding_key: string;
  driver: PluginAuthSession["driver"];
  user_id: string;
  status: PluginAuthSession["status"];
  phase: PluginAuthSession["phase"] | null;
  state: string | null;
  challenge_payload: unknown;
  transient_payload: unknown;
  error_code: string | null;
  error_message: string | null;
  result_preview: unknown;
  result_payload: unknown;
  metadata: unknown;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type PluginConnectionRow = {
  id: string;
  workspace_id: string;
  installation_id: string;
  catalog_item_id: string;
  catalog_version_id?: string | null;
  owner_scope: PluginAuthConnection["ownerScope"];
  owner_user_id: string | null;
  binding_key: string;
  driver: PluginAuthConnection["driver"];
  external_account_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: PluginAuthConnection["status"];
  expires_at: string | null;
  public_payload: unknown;
  secret_payload: unknown;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type PluginAuthSpec = {
  catalogItemId: string;
  catalogVersionId: string | null;
  defaultConfig: Record<string, unknown>;
  authBindings: PluginAuthBindingDefinition[];
};

type InstallationConfigRow = {
  catalog_item_id: string;
  catalog_version_id: string;
  config_data: unknown;
  default_config: unknown;
};

type OAuthTransientPayload = {
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  userInfoUrl?: string;
  tokenRequestContentType: "application/json" | "application/x-www-form-urlencoded";
  audience?: string;
  extraTokenParams?: Record<string, string>;
  profileIdPath?: string;
  profileDisplayNamePath?: string;
  profileAvatarUrlPath?: string;
};

export class PluginAuthError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
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

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNullableString(value: unknown): string | null {
  const normalized = asString(value);
  return normalized || null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function isMissingConfigValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function base64Url(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function getByPath(source: unknown, path?: string): unknown {
  if (!path) return undefined;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function decryptDeep(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return decrypt(value);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => decryptDeep(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = decryptDeep(nested);
    }
    return result;
  }
  return value;
}

function encryptDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return encrypt(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => encryptDeep(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = encryptDeep(nested);
    }
    return result;
  }
  return value;
}

function getAuthChallenge(
  row: PluginAuthSessionRow,
): PluginAuthSession["challenge"] | undefined {
  const challenge = asObject(row.challenge_payload);
  const kind = asString(challenge.kind);
  if (!kind) return undefined;
  if (kind !== "redirect" && kind !== "qr_code" && kind !== "none") {
    return undefined;
  }
  return {
    kind: kind as NonNullable<PluginAuthSession["challenge"]>["kind"],
    url: asString(challenge.url) || undefined,
    qrUrl: asString(challenge.qrUrl) || undefined,
    openMode:
      challenge.openMode === "replace" || challenge.openMode === "popup"
        ? challenge.openMode
        : undefined,
    expiresAt: asString(challenge.expiresAt) || undefined,
    metadata: asObject(challenge.metadata),
  };
}

function mapConnectionRow(row: PluginConnectionRow): PluginAuthConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.catalog_item_id,
    bindingKey: row.binding_key,
    driver: row.driver,
    ownerScope: row.owner_scope,
    ownerUserId: row.owner_user_id || undefined,
    externalAccountId: row.external_account_id || undefined,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    status: row.status,
    expiresAt: row.expires_at || undefined,
    publicPayload: asObject(row.public_payload),
    metadata: asObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionRow(row: PluginAuthSessionRow): PluginAuthSession {
  const metadata = asObject(row.metadata);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.catalog_item_id,
    revisionId: row.catalog_version_id || undefined,
    bindingKey: row.binding_key,
    driver: row.driver,
    userId: row.user_id,
    status: row.status,
    phase: row.phase || undefined,
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
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getPluginAuthSpec(
  pluginId: string,
  catalogVersionId?: string | null,
): Promise<PluginAuthSpec> {
  const result = await query<{
    catalog_item_id: string;
    catalog_version_id: string | null;
    default_config: unknown;
    auth_bindings: unknown;
  }>(
    `SELECT
       item.id AS catalog_item_id,
       version.id AS catalog_version_id,
       spec.default_config,
       spec.auth_bindings
     FROM catalog_items item
     LEFT JOIN catalog_versions version
       ON version.id = COALESCE($2::uuid, item.latest_version_id)
     LEFT JOIN plugin_package_version_specs spec
       ON spec.catalog_version_id = version.id
     WHERE item.id = $1
       AND item.item_kind = 'plugin_package'
     LIMIT 1`,
    [pluginId, catalogVersionId || null],
  );

  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Plugin not found");
  }

  const row = result.rows[0]!;
  return {
    catalogItemId: row.catalog_item_id,
    catalogVersionId: row.catalog_version_id,
    defaultConfig: asObject(row.default_config),
    authBindings: Array.isArray(row.auth_bindings)
      ? (row.auth_bindings as PluginAuthBindingDefinition[])
      : [],
  };
}

function getBinding(
  bindings: PluginAuthBindingDefinition[],
  bindingKey: string,
) {
  const binding = bindings.find((item) => item.key === bindingKey);
  if (!binding) {
    throw new PluginAuthError(404, "Auth binding not found");
  }
  return binding;
}

async function getSessionRow(sessionId: string, workspaceId: string, userId: string) {
  const result = await query<PluginAuthSessionRow>(
    `SELECT *
     FROM plugin_auth_sessions
     WHERE id = $1
       AND workspace_id = $2
       AND user_id = $3
     LIMIT 1`,
    [sessionId, workspaceId, userId],
  );
  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Auth session not found");
  }
  return result.rows[0]!;
}

async function getSessionRowByState(state: string) {
  const result = await query<PluginAuthSessionRow>(
    `SELECT *
     FROM plugin_auth_sessions
     WHERE state = $1
     LIMIT 1`,
    [state],
  );
  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Auth session not found");
  }
  return result.rows[0]!;
}

async function getConnectionRow(connectionId: string, workspaceId?: string) {
  const params: unknown[] = [connectionId];
  const workspaceFilter = workspaceId ? `AND connection.workspace_id = $2` : "";
  if (workspaceId) {
    params.push(workspaceId);
  }
  const result = await query<PluginConnectionRow>(
    `SELECT
       connection.*,
       installation.catalog_item_id,
       installation.catalog_version_id
     FROM plugin_connections connection
     JOIN plugin_installations installation
       ON installation.id = connection.installation_id
     WHERE connection.id = $1
       ${workspaceFilter}
     LIMIT 1`,
    params,
  );
  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Auth connection not found");
  }
  return result.rows[0]!;
}

async function getInstallationConfigRow(
  installationId: string,
  workspaceId: string,
): Promise<InstallationConfigRow> {
  const result = await query<InstallationConfigRow>(
    `SELECT
       installation.catalog_item_id,
       installation.catalog_version_id,
       installation.config_data,
       spec.default_config
     FROM plugin_installations installation
     JOIN plugin_package_version_specs spec
       ON spec.catalog_version_id = installation.catalog_version_id
     WHERE installation.id = $1
       AND installation.workspace_id = $2
     LIMIT 1`,
    [installationId, workspaceId],
  );

  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Installation not found");
  }

  return result.rows[0]!;
}

function mergeConfigLayers(...layers: Record<string, unknown>[]) {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

async function buildDraftConfig(input: {
  workspaceId: string;
  pluginId: string;
  defaultConfig: Record<string, unknown>;
  installationId?: string;
  draftConfig?: Record<string, unknown>;
}) {
  if (!input.installationId) {
    return mergeConfigLayers(
      input.defaultConfig,
      input.draftConfig || {},
    );
  }

  const row = await getInstallationConfigRow(input.installationId, input.workspaceId);
  if (row.catalog_item_id !== input.pluginId) {
    throw new PluginAuthError(400, "Installation does not belong to this plugin");
  }

  return mergeConfigLayers(
    input.defaultConfig,
    decryptSensitiveFields(asObject(row.config_data)),
    input.draftConfig || {},
  );
}

function defaultOauthCallbackUrl() {
  return `${config.app.baseUrl.replace(/\/$/, "")}/api/v1/mcp/auth/callback`;
}

function resolveAuthValue(
  source: PluginAuthValueSource | undefined,
  configData: Record<string, unknown>,
) {
  if (!source) return undefined;
  switch (source.source) {
    case "config":
      return source.field ? configData[source.field] : undefined;
    case "env":
      return source.env ? process.env[source.env] : undefined;
    case "literal":
      return source.value;
    case "derived":
      if (source.name === "app_base_url") {
        return config.app.baseUrl.replace(/\/$/, "");
      }
      if (source.name === "oauth_callback_url") {
        return defaultOauthCallbackUrl();
      }
      return undefined;
    default:
      return undefined;
  }
}

function getBindingStringInput(
  binding: PluginAuthBindingDefinition,
  inputKey: string,
  configData: Record<string, unknown>,
) {
  return asString(resolveAuthValue(binding.inputs?.[inputKey], configData));
}

function validatePrerequisiteFields(
  binding: PluginAuthBindingDefinition,
  configData: Record<string, unknown>,
) {
  for (const fieldKey of binding.prerequisiteFields || []) {
    const value = configData[fieldKey];
    if (isMissingConfigValue(value)) {
      throw new PluginAuthError(
        400,
        `Field '${fieldKey}' is required before starting '${binding.key}'`,
      );
    }
  }
}

function getTokenRequestContentType(binding: PluginAuthBindingDefinition) {
  const metadata = asObject(binding.metadata);
  return metadata.tokenRequestContentType === "application/json"
    ? "application/json"
    : "application/x-www-form-urlencoded";
}

function buildMijiaResultPreview(authState: object) {
  const state = authState as JsonObject;
  const externalAccountId =
    asNullableString(state.cUserId) || asNullableString(state.userId);
  const displayName =
    asNullableString(state.userId) || externalAccountId;

  return {
    externalAccountId: externalAccountId || undefined,
    displayName: displayName || undefined,
    locale: normalizeMijiaLocale(state.locale),
  };
}

function buildMijiaResultPayload(authState: object) {
  const state = authState as JsonObject;
  const expiresAt =
    typeof state.expireTime === "number"
      ? new Date(state.expireTime).toISOString()
      : null;
  const preview = buildMijiaResultPreview(authState);

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
  };
}

function buildFeishuResultPreview(input: {
  brand: "feishu" | "lark";
  tokenScope: string;
  profile: JsonObject;
  requestedFeatures: string[];
}) {
  const externalAccountId =
    asNullableString(input.profile.open_id) ||
    asNullableString(input.profile.union_id) ||
    asNullableString(input.profile.user_id);
  const displayName =
    asNullableString(input.profile.name) ||
    asNullableString(input.profile.en_name) ||
    externalAccountId;
  const avatarUrl = asNullableString(input.profile.avatar_url);
  const scopes = asStringArray(input.tokenScope);

  return {
    externalAccountId: externalAccountId || undefined,
    displayName: displayName || undefined,
    avatarUrl: avatarUrl || undefined,
    brand: input.brand,
    scopes,
    features: input.requestedFeatures,
  };
}

function buildFeishuResultPayload(input: {
  brand: "feishu" | "lark";
  appId: string;
  appSecret: string;
  tokenData: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    refreshExpiresIn: number;
    scope: string;
    tokenType: string;
  };
  profile: JsonObject;
  requestedFeatures: string[];
}) {
  const expiresAt = new Date(Date.now() + input.tokenData.expiresIn * 1000).toISOString();
  const refreshExpiresAt = new Date(
    Date.now() + input.tokenData.refreshExpiresIn * 1000,
  ).toISOString();
  const preview = buildFeishuResultPreview({
    brand: input.brand,
    tokenScope: input.tokenData.scope,
    profile: input.profile,
    requestedFeatures: input.requestedFeatures,
  });

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
  };
}

async function expirePluginAuthSession(sessionId: string) {
  const expired = await query<PluginAuthSessionRow>(
    `UPDATE plugin_auth_sessions
     SET status = 'expired',
         phase = NULL,
         error_code = 'AUTH_SESSION_EXPIRED',
         error_message = 'Auth session expired',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionId],
  );
  return expired.rows[0]!;
}

async function progressMijiaPluginAuthSession(row: PluginAuthSessionRow) {
  if (row.driver !== "mijia_qr_login" || row.status !== "pending") {
    return row;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return expirePluginAuthSession(row.id);
  }

  const transientPayload = asObject(decryptDeep(asObject(row.transient_payload)));
  const mijiaPayload = asObject(transientPayload.mijia);

  try {
    const progress = await progressMijiaQrLoginSession({
      transientPayload: mijiaPayload,
      timeoutMs: 1_200,
    });

    switch (progress.status) {
      case "pending": {
        if (!progress.phase || progress.phase === row.phase) {
          return row;
        }

        const updated = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET phase = $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [row.id, progress.phase],
        );
        return updated.rows[0]!;
      }
      case "completed": {
        const resultPayload = buildMijiaResultPayload(progress.authState);
        const updated = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET status = 'completed',
               phase = NULL,
               result_preview = $2::jsonb,
               result_payload = $3::jsonb,
               error_code = NULL,
               error_message = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            row.id,
            JSON.stringify(buildMijiaResultPreview(progress.authState)),
            JSON.stringify(resultPayload),
          ],
        );
        return updated.rows[0]!;
      }
      case "expired": {
        const expired = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET status = 'expired',
               phase = NULL,
               error_code = $2,
               error_message = $3,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [row.id, progress.errorCode, progress.errorMessage],
        );
        return expired.rows[0]!;
      }
      case "failed": {
        const failed = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET status = 'failed',
               phase = NULL,
               error_code = $2,
               error_message = $3,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [row.id, progress.errorCode, progress.errorMessage],
        );
        return failed.rows[0]!;
      }
      default:
        return row;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to complete Mijia authorization.";
    const failed = await query<PluginAuthSessionRow>(
      `UPDATE plugin_auth_sessions
       SET status = 'failed',
           phase = NULL,
           error_code = 'MIJIA_AUTH_ERROR',
           error_message = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [row.id, message],
    );
    return failed.rows[0]!;
  }
}

async function progressFeishuPluginAuthSession(row: PluginAuthSessionRow) {
  if (row.driver !== "feishu_cli_setup" || row.status !== "pending") {
    return row;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return expirePluginAuthSession(row.id);
  }

  const transientPayload = asObject(decryptDeep(asObject(row.transient_payload)));

  try {
    const progress = await progressFeishuCliSetup(transientPayload as any);
    switch (progress.status) {
      case "pending": {
        const nextTransient = progress.transientPayload || (transientPayload as any);
        const nextChallenge = progress.challengePayload || asObject(row.challenge_payload);
        const nextExpiresAt = progress.expiresAt || row.expires_at;

        const updated = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET phase = 'pending_scan',
               challenge_payload = $2::jsonb,
               transient_payload = $3::jsonb,
               expires_at = $4,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            row.id,
            JSON.stringify(nextChallenge),
            JSON.stringify(encryptDeep(nextTransient)),
            nextExpiresAt,
          ],
        );
        return updated.rows[0]!;
      }
      case "completed": {
        const resultPayload = buildFeishuResultPayload({
          brand: progress.appCredentials.brand,
          appId: progress.appCredentials.appId,
          appSecret: progress.appCredentials.appSecret,
          tokenData: progress.tokenData,
          profile: progress.profile,
          requestedFeatures: progress.requestedFeatures,
        });
        const resultPreview = buildFeishuResultPreview({
          brand: progress.appCredentials.brand,
          tokenScope: progress.tokenData.scope,
          profile: progress.profile,
          requestedFeatures: progress.requestedFeatures,
        });

        const updated = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET status = 'completed',
               phase = NULL,
               result_preview = $2::jsonb,
               result_payload = $3::jsonb,
               error_code = NULL,
               error_message = NULL,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            row.id,
            JSON.stringify(resultPreview),
            JSON.stringify(resultPayload),
          ],
        );
        return updated.rows[0]!;
      }
      case "expired": {
        const expired = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET status = 'expired',
               phase = NULL,
               error_code = $2,
               error_message = $3,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [row.id, progress.errorCode, progress.errorMessage],
        );
        return expired.rows[0]!;
      }
      case "failed": {
        const failed = await query<PluginAuthSessionRow>(
          `UPDATE plugin_auth_sessions
           SET status = 'failed',
               phase = NULL,
               error_code = $2,
               error_message = $3,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [row.id, progress.errorCode, progress.errorMessage],
        );
        return failed.rows[0]!;
      }
      default:
        return row;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to complete Feishu authorization.";
    const failed = await query<PluginAuthSessionRow>(
      `UPDATE plugin_auth_sessions
       SET status = 'failed',
           phase = NULL,
           error_code = 'FEISHU_AUTH_ERROR',
           error_message = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [row.id, message],
    );
    return failed.rows[0]!;
  }
}

async function exchangeAuthorizationCode(
  payload: OAuthTransientPayload,
  code: string,
) {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: payload.redirectUri,
    client_id: payload.clientId,
    code_verifier: payload.codeVerifier,
  };

  if (payload.audience) {
    params.audience = payload.audience;
  }
  for (const [key, value] of Object.entries(payload.extraTokenParams || {})) {
    params[key] = value;
  }
  if (payload.clientSecret) {
    params.client_secret = payload.clientSecret;
  }

  const body =
    payload.tokenRequestContentType === "application/json"
      ? JSON.stringify(params)
      : new URLSearchParams(params).toString();

  const response = await fetch(payload.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": payload.tokenRequestContentType,
      Accept: "application/json",
    },
    body,
  });

  const responseBody = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new PluginAuthError(
      response.status || 400,
      typeof responseBody.error_description === "string"
        ? responseBody.error_description
        : typeof responseBody.error === "string"
          ? responseBody.error
          : "Token exchange failed",
    );
  }

  return responseBody;
}

async function refreshOAuthConnection(
  binding: PluginAuthBindingDefinition,
  row: PluginConnectionRow,
  configData: Record<string, unknown>,
) {
  const tokenUrl = asString(binding.tokenUrl);
  if (!tokenUrl) {
    throw new PluginAuthError(400, `Auth binding '${binding.key}' is missing tokenUrl`);
  }

  const storedSecretPayload = asObject(row.secret_payload);
  const secretPayload = asObject(decryptDeep(storedSecretPayload));
  const refreshToken = asString(secretPayload.refreshToken);
  if (!refreshToken) {
    throw new PluginAuthError(400, "Auth connection has no refresh token");
  }

  const clientId = getBindingStringInput(binding, "clientId", configData);
  if (!clientId) {
    throw new PluginAuthError(400, `Auth binding '${binding.key}' is missing clientId`);
  }
  const clientSecret = getBindingStringInput(binding, "clientSecret", configData);

  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (binding.audience) {
    params.audience = binding.audience;
  }
  for (const [key, value] of Object.entries(binding.extraTokenParams || {})) {
    params[key] = value;
  }
  if (clientSecret) {
    params.client_secret = clientSecret;
  }

  const contentType = getTokenRequestContentType(binding);
  const body =
    contentType === "application/json"
      ? JSON.stringify(params)
      : new URLSearchParams(params).toString();

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body,
  });

  const tokenResponse = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new PluginAuthError(
      response.status || 400,
      typeof tokenResponse.error_description === "string"
        ? tokenResponse.error_description
        : typeof tokenResponse.error === "string"
          ? tokenResponse.error
          : "Token refresh failed",
    );
  }

  const accessToken = asString(tokenResponse.access_token);
  if (!accessToken) {
    throw new PluginAuthError(400, "Provider did not return an access token");
  }

  const expiresAt =
    typeof tokenResponse.expires_in === "number"
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : row.expires_at;

  const publicPayload = {
    ...asObject(row.public_payload),
    ...(typeof tokenResponse.scope === "string"
      ? {
          scopes: tokenResponse.scope.split(/\s+/).filter(Boolean),
        }
      : {}),
  };

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
  };

  await query(
    `UPDATE plugin_connections
     SET public_payload = $2::jsonb,
         secret_payload = $3::jsonb,
         status = 'active',
         expires_at = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [
      row.id,
      JSON.stringify(publicPayload),
      JSON.stringify(nextSecretPayload),
      expiresAt,
    ],
  );

  return getConnectionRow(row.id);
}

async function refreshFeishuConnection(row: PluginConnectionRow) {
  const storedSecretPayload = asObject(row.secret_payload);
  const secretPayload = asObject(decryptDeep(storedSecretPayload));
  const publicPayload = asObject(row.public_payload);
  const brand =
    asString(publicPayload.brand) === "lark"
      ? "lark"
      : "feishu";
  const appId = asString(secretPayload.appId);
  const appSecret = asString(secretPayload.appSecret);
  const refreshToken = asString(secretPayload.refreshToken);

  if (!appId || !appSecret || !refreshToken) {
    throw new PluginAuthError(
      400,
      "Feishu auth connection is missing refresh credentials",
    );
  }

  const tokenResponse = await refreshFeishuUserAccessToken({
    brand,
    openBaseUrl: asString(publicPayload.openBaseUrl) || undefined,
    appId,
    appSecret,
    refreshToken,
  });

  const expiresAt = new Date(Date.now() + tokenResponse.expiresIn * 1000).toISOString();
  const refreshExpiresAt = new Date(
    Date.now() + tokenResponse.refreshExpiresIn * 1000,
  ).toISOString();
  const nextPublicPayload = {
    ...publicPayload,
    scopes: asStringArray(tokenResponse.scope),
  };
  const nextSecretPayload = {
    ...storedSecretPayload,
    accessToken: encrypt(tokenResponse.accessToken),
    refreshToken: encrypt(tokenResponse.refreshToken),
    tokenType: tokenResponse.tokenType,
    expiresAt,
    refreshExpiresAt,
  };

  await query(
    `UPDATE plugin_connections
     SET public_payload = $2::jsonb,
         secret_payload = $3::jsonb,
         status = 'active',
         expires_at = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [
      row.id,
      JSON.stringify(nextPublicPayload),
      JSON.stringify(nextSecretPayload),
      expiresAt,
    ],
  );

  return getConnectionRow(row.id);
}

async function ensureFreshPluginConnection(row: PluginConnectionRow) {
  if (
    row.status !== "active" ||
    !row.expires_at ||
    new Date(row.expires_at).getTime() > Date.now() + 60_000
  ) {
    return row;
  }

  if (!row.catalog_item_id) {
    throw new PluginAuthError(400, "Auth connection is missing its plugin binding");
  }

  const installationRow = await getInstallationConfigRow(row.installation_id, row.workspace_id);
  const configData = mergeConfigLayers(
    asObject(installationRow.default_config),
    decryptSensitiveFields(asObject(installationRow.config_data)),
  );
  const spec = await getPluginAuthSpec(
    row.catalog_item_id,
    row.catalog_version_id || installationRow.catalog_version_id,
  );
  const binding = getBinding(spec.authBindings, row.binding_key);

  try {
    switch (row.driver) {
      case "oauth2_authorization_code_pkce":
        return await refreshOAuthConnection(binding, row, configData);
      case "mijia_qr_login":
        return row;
      case "feishu_cli_setup":
        return await refreshFeishuConnection(row);
      default:
        throw new PluginAuthError(
          400,
          `Auth driver '${row.driver}' does not support token refresh`,
        );
    }
  } catch {
    await query(
      `UPDATE plugin_connections
       SET status = 'expired',
           updated_at = NOW()
       WHERE id = $1`,
      [row.id],
    );
    return {
      ...row,
      status: "expired",
    };
  }
}

export async function startPluginAuthSession(input: {
  workspaceId: string;
  pluginId: string;
  installationId?: string;
  bindingKey: string;
  userId: string;
  draftConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  let catalogVersionId: string | null | undefined;
  if (input.installationId) {
    const installationRow = await getInstallationConfigRow(
      input.installationId,
      input.workspaceId,
    );
    if (installationRow.catalog_item_id !== input.pluginId) {
      throw new PluginAuthError(400, "Installation does not belong to this plugin");
    }
    catalogVersionId = installationRow.catalog_version_id;
  }

  const spec = await getPluginAuthSpec(input.pluginId, catalogVersionId || null);
  if (!spec.catalogVersionId) {
    throw new PluginAuthError(400, "Plugin has no active version");
  }

  const binding = getBinding(spec.authBindings, input.bindingKey);
  const draftConfig = await buildDraftConfig({
    workspaceId: input.workspaceId,
    pluginId: input.pluginId,
    defaultConfig: spec.defaultConfig,
    installationId: input.installationId,
    draftConfig: input.draftConfig,
  });
  validatePrerequisiteFields(binding, draftConfig);

  switch (binding.driver) {
    case "oauth2_authorization_code_pkce": {
      const clientId = getBindingStringInput(binding, "clientId", draftConfig);
      if (!clientId) {
        throw new PluginAuthError(
          400,
          `Auth binding '${binding.key}' is missing clientId`,
        );
      }
      const clientSecret = getBindingStringInput(binding, "clientSecret", draftConfig);
      const authorizeUrlValue = asString(binding.authorizeUrl);
      const tokenUrl = asString(binding.tokenUrl);
      if (!authorizeUrlValue || !tokenUrl) {
        throw new PluginAuthError(
          400,
          `Auth binding '${binding.key}' is missing authorizeUrl/tokenUrl`,
        );
      }

      const { verifier, challenge } = createPkcePair();
      const state = base64Url(randomBytes(24));
      const redirectUri =
        getBindingStringInput(binding, "callbackUrl", draftConfig) ||
        defaultOauthCallbackUrl();
      const authorizeUrl = new URL(authorizeUrlValue);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      if ((binding.scopes || []).length > 0) {
        authorizeUrl.searchParams.set("scope", binding.scopes!.join(" "));
      }
      if (binding.audience) {
        authorizeUrl.searchParams.set("audience", binding.audience);
      }
      for (const [key, value] of Object.entries(binding.extraAuthorizeParams || {})) {
        authorizeUrl.searchParams.set(key, value);
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
      };

      const inserted = await query<PluginAuthSessionRow>(
        `INSERT INTO plugin_auth_sessions (
           workspace_id,
           catalog_item_id,
           catalog_version_id,
           installation_id,
           binding_key,
           driver,
           user_id,
           status,
           phase,
           state,
           challenge_payload,
           transient_payload,
           metadata,
           expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'pending', 'awaiting_callback', $8,
           $9::jsonb, $10::jsonb, $11::jsonb, NOW() + INTERVAL '1 hour'
         )
         RETURNING *`,
        [
          input.workspaceId,
          spec.catalogItemId,
          spec.catalogVersionId,
          input.installationId || null,
          binding.key,
          binding.driver,
          input.userId,
          state,
          JSON.stringify({
            kind: "redirect",
            url: authorizeUrl.toString(),
            openMode: "popup",
          }),
          JSON.stringify(transientPayload),
          JSON.stringify(input.metadata || {}),
        ],
      );

      return {
        session: mapSessionRow(inserted.rows[0]!),
      };
    }
    case "mijia_qr_login": {
      const result = await startMijiaQrLoginSession({
        locale: draftConfig.locale,
      });
      const inserted = await query<PluginAuthSessionRow>(
        `INSERT INTO plugin_auth_sessions (
           workspace_id,
           catalog_item_id,
           catalog_version_id,
           installation_id,
           binding_key,
           driver,
           user_id,
           status,
           phase,
           state,
           challenge_payload,
           transient_payload,
           metadata,
           expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'pending', 'pending_scan', NULL,
           $8::jsonb, $9::jsonb, $10::jsonb, $11
         )
         RETURNING *`,
        [
          input.workspaceId,
          spec.catalogItemId,
          spec.catalogVersionId,
          input.installationId || null,
          binding.key,
          binding.driver,
          input.userId,
          JSON.stringify(result.challengePayload),
          JSON.stringify(encryptDeep(result.transientPayload)),
          JSON.stringify(input.metadata || {}),
          result.expiresAt,
        ],
      );

      return {
        session: mapSessionRow(inserted.rows[0]!),
      };
    }
    case "feishu_cli_setup": {
      const selectedFeatures = normalizeFeishuFeatureKeys(draftConfig.features);
      const existingConnectionRef = asObject(draftConfig.feishuAccount);
      let existingAppCredentials:
        | {
            brand: "feishu" | "lark";
            appId: string;
            appSecret: string;
          }
        | undefined;
      if (
        existingConnectionRef.__kind === "auth_connection_ref" &&
        typeof existingConnectionRef.connectionId === "string"
      ) {
        const connectionRow = await getConnectionRow(
          existingConnectionRef.connectionId,
          input.workspaceId,
        );
        const publicPayload = asObject(connectionRow.public_payload);
        const secretPayload = asObject(decryptDeep(asObject(connectionRow.secret_payload)));
        const appId = asString(secretPayload.appId);
        const appSecret = asString(secretPayload.appSecret);
        if (appId && appSecret) {
          existingAppCredentials = {
            brand:
              asString(publicPayload.brand) === "lark"
                ? "lark"
                : "feishu",
            appId,
            appSecret,
          };
        }
      } else {
        assertFeishuInitialSetupFeatures(selectedFeatures);
      }

      const result = await startFeishuCliSetup(
        selectedFeatures,
        existingAppCredentials,
      );
      const inserted = await query<PluginAuthSessionRow>(
        `INSERT INTO plugin_auth_sessions (
           workspace_id,
           catalog_item_id,
           catalog_version_id,
           installation_id,
           binding_key,
           driver,
           user_id,
           status,
           phase,
           state,
           challenge_payload,
           transient_payload,
           metadata,
           expires_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'pending', 'pending_scan', NULL,
           $8::jsonb, $9::jsonb, $10::jsonb, $11
         )
         RETURNING *`,
        [
          input.workspaceId,
          spec.catalogItemId,
          spec.catalogVersionId,
          input.installationId || null,
          binding.key,
          binding.driver,
          input.userId,
          JSON.stringify(result.challengePayload),
          JSON.stringify(encryptDeep(result.transientPayload)),
          JSON.stringify(input.metadata || {}),
          result.expiresAt,
        ],
      );

      return {
        session: mapSessionRow(inserted.rows[0]!),
      };
    }
    default:
      throw new PluginAuthError(
        400,
        `Auth driver '${binding.driver}' is not implemented yet`,
      );
  }
}

export async function getPluginAuthSession(
  sessionId: string,
  workspaceId: string,
  userId: string,
) {
  let row = await getSessionRow(sessionId, workspaceId, userId);
  if (row.driver === "mijia_qr_login" && row.status === "pending") {
    row = await progressMijiaPluginAuthSession(row);
  } else if (row.driver === "feishu_cli_setup" && row.status === "pending") {
    row = await progressFeishuPluginAuthSession(row);
  } else if (
    row.status === "pending" &&
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    row = await expirePluginAuthSession(row.id);
  }
  return mapSessionRow(row);
}

export async function handlePluginAuthCallback(input: {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}) {
  if (!input.state) {
    throw new PluginAuthError(400, "Missing auth state");
  }

  const session = await getSessionRowByState(input.state);

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await query(
      `UPDATE plugin_auth_sessions
       SET status = 'expired',
           updated_at = NOW()
       WHERE id = $1`,
      [session.id],
    );
    throw new PluginAuthError(410, "Auth session expired");
  }

  if (input.error) {
    const failed = await query<PluginAuthSessionRow>(
      `UPDATE plugin_auth_sessions
       SET status = 'failed',
           phase = NULL,
           error_code = $2,
           error_message = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [session.id, input.error, input.errorDescription || input.error],
    );
    return mapSessionRow(failed.rows[0]!);
  }

  switch (session.driver) {
    case "oauth2_authorization_code_pkce": {
      if (!input.code) {
        throw new PluginAuthError(400, "Missing authorization code");
      }

      const transientPayload = asObject(
        decryptDeep(asObject(session.transient_payload)),
      );
      const oauth = asObject(transientPayload.oauth) as OAuthTransientPayload;
      if (!oauth.tokenUrl || !oauth.clientId || !oauth.codeVerifier || !oauth.redirectUri) {
        throw new PluginAuthError(400, "Auth session is missing OAuth state");
      }

      const tokenResponse = await exchangeAuthorizationCode(oauth, input.code);
      const accessToken = asString(tokenResponse.access_token);
      if (!accessToken) {
        throw new PluginAuthError(400, "Provider did not return an access token");
      }

      let profile: Record<string, unknown> = {};
      if (oauth.userInfoUrl) {
        const response = await fetch(oauth.userInfoUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        });
        if (!response.ok) {
          throw new PluginAuthError(
            response.status || 400,
            "Failed to fetch provider profile",
          );
        }
        profile = asObject(await response.json().catch(() => ({})));
      }

      const externalAccountId =
        getByPath(profile, oauth.profileIdPath) ||
        tokenResponse.sub ||
        tokenResponse.user_id;
      const displayName =
        getByPath(profile, oauth.profileDisplayNamePath) ||
        tokenResponse.name ||
        tokenResponse.preferred_username;
      const avatarUrl = getByPath(profile, oauth.profileAvatarUrlPath);
      const scopes =
        typeof tokenResponse.scope === "string"
          ? tokenResponse.scope.split(/\s+/).filter(Boolean)
          : [];
      const expiresAt =
        typeof tokenResponse.expires_in === "number"
          ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
          : null;

      const resultPreview = {
        externalAccountId: externalAccountId ? String(externalAccountId) : undefined,
        displayName: displayName ? String(displayName) : undefined,
        avatarUrl: avatarUrl ? String(avatarUrl) : undefined,
        scopes,
      };

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
      };

      const updated = await query<PluginAuthSessionRow>(
        `UPDATE plugin_auth_sessions
         SET status = 'completed',
             phase = NULL,
             result_preview = $2::jsonb,
             result_payload = $3::jsonb,
             error_code = NULL,
             error_message = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          session.id,
          JSON.stringify(resultPreview),
          JSON.stringify(resultPayload),
        ],
      );

      return mapSessionRow(updated.rows[0]!);
    }
    default:
      throw new PluginAuthError(
        400,
        `Auth driver '${session.driver}' cannot handle callbacks`,
      );
  }
}

export async function getAuthConnection(
  connectionId: string,
  workspaceId: string,
) {
  return mapConnectionRow(await getConnectionRow(connectionId, workspaceId));
}

export async function attachAuthConnectionsToConfig(input: {
  installationId: string;
  workspaceId: string;
  userId: string;
  configFields: PluginConfigFieldDefinition[];
  authBindings: PluginAuthBindingDefinition[];
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
  run?: QueryRunner;
}) {
  const run = input.run || (query as QueryRunner);
  const result: Record<string, unknown> = { ...(input.configData || {}) };
  const authSessionIds = input.authSessionIds || {};
  const bindingMap = new Map(input.authBindings.map((binding) => [binding.key, binding]));
  const authFields = input.configFields.filter((field) => field.type === "auth_connection");

  for (const field of authFields) {
    const sessionId = authSessionIds[field.key];
    if (!sessionId) continue;

    const session = await getSessionRow(sessionId, input.workspaceId, input.userId);
    if (!["completed", "consumed"].includes(session.status)) {
      throw new PluginAuthError(
        400,
        `Authorization for '${field.key}' is not completed`,
      );
    }

    const metadata = asObject(session.metadata);
    const bindingKey = session.binding_key;
    if (field.authBindingKey && bindingKey !== field.authBindingKey) {
      throw new PluginAuthError(
        400,
        `Authorization binding mismatch for '${field.key}'`,
      );
    }

    let connection: PluginAuthConnection;
    if (
      session.status === "consumed" &&
      typeof metadata.consumedConnectionId === "string"
    ) {
      connection = await getAuthConnection(
        metadata.consumedConnectionId,
        input.workspaceId,
      );
    } else {
      const normalizedPayload = asObject(session.result_payload);
      const publicPayload = asObject(normalizedPayload.publicPayload);
      const secretPayload = asObject(normalizedPayload.secretPayload);
      if (Object.keys(secretPayload).length === 0) {
        throw new PluginAuthError(
          400,
          `Authorization for '${field.key}' is missing connection payload`,
        );
      }

      const binding = bindingMap.get(bindingKey);
      const externalAccountId = asNullableString(normalizedPayload.externalAccountId);
      const displayName = asNullableString(normalizedPayload.displayName);
      const avatarUrl = asNullableString(normalizedPayload.avatarUrl);
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
         ORDER BY connection.updated_at DESC
         LIMIT 1`,
        [
          input.installationId,
          input.workspaceId,
          bindingKey,
          externalAccountId,
        ],
      );

      let connectionRow: PluginConnectionRow;
      if (existing.rows.length > 0) {
        const updated = await run<PluginConnectionRow>(
          `UPDATE plugin_connections
           SET owner_scope = $2,
               owner_user_id = $3,
               display_name = $4,
               avatar_url = $5,
               status = 'active',
               expires_at = $6,
               public_payload = $7::jsonb,
               secret_payload = $8::jsonb,
               metadata = $9::jsonb,
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
            input.userId || null,
            displayName,
            avatarUrl,
            asNullableString(secretPayload.expiresAt),
            JSON.stringify(publicPayload),
            JSON.stringify(secretPayload),
            JSON.stringify({
              sourceSessionId: session.id,
              bindingKey,
              driver: session.driver,
            }),
          ],
        );
        connectionRow = updated.rows[0]!;
      } else {
        const inserted = await run<PluginConnectionRow>(
          `INSERT INTO plugin_connections (
             installation_id,
             workspace_id,
             owner_scope,
             owner_user_id,
             binding_key,
             driver,
             external_account_id,
             display_name,
             avatar_url,
             status,
             expires_at,
             public_payload,
             secret_payload,
             metadata
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11::jsonb, $12::jsonb, $13::jsonb
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
            input.userId || null,
            bindingKey,
            session.driver,
            externalAccountId,
            displayName,
            avatarUrl,
            asNullableString(secretPayload.expiresAt),
            JSON.stringify(publicPayload),
            JSON.stringify(secretPayload),
            JSON.stringify({
              sourceSessionId: session.id,
              bindingKey,
              driver: session.driver,
            }),
          ],
        );
        connectionRow = inserted.rows[0]!;
      }

      connection = mapConnectionRow(connectionRow);

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
        ],
      );
    }

    result[field.key] = {
      __kind: "auth_connection_ref",
      connectionId: connection.id,
      bindingKey: connection.bindingKey,
      accountDisplayName: connection.displayName,
      externalAccountId: connection.externalAccountId,
      updatedAt: connection.updatedAt,
    };
  }

  return result;
}

export async function resolveAuthConnectionRefs(config: Record<string, unknown>) {
  const resolved: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(resolved)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const ref = value as Record<string, unknown>;
    if (ref.__kind !== "auth_connection_ref" || typeof ref.connectionId !== "string") {
      continue;
    }

    const row = await ensureFreshPluginConnection(
      await getConnectionRow(ref.connectionId),
    );
    const secretPayload = asObject(decryptDeep(asObject(row.secret_payload)));
    if (row.status !== "active") {
      delete secretPayload.accessToken;
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
      metadata: asObject(row.metadata),
    };
  }
  return resolved;
}
