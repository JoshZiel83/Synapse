import { createHash, randomBytes } from "crypto";
import type {
  PluginAuthConnection,
  PluginAuthProviderDefinition,
  PluginAuthSession,
  PluginConfigFieldDefinition,
} from "@synapse/shared";
import { config } from "../../config/index.js";
import { decrypt, encrypt } from "../../infrastructure/crypto/index.js";
import { query } from "../../infrastructure/database/index.js";

type JsonObject = Record<string, unknown>;

type PluginAuthSessionRow = {
  id: string;
  workspace_id: string;
  catalog_item_id: string;
  catalog_version_id: string | null;
  provider_key: string;
  user_id: string;
  status: PluginAuthSession["status"];
  state: string;
  code_verifier: string | null;
  redirect_uri: string;
  authorize_url: string | null;
  error_code: string | null;
  error_message: string | null;
  result_preview: unknown;
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
  provider_key: string;
  owner_user_id: string;
  external_account_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  scopes: unknown;
  status: "active" | "expired" | "revoked";
  expires_at: string | null;
  profile: unknown;
  metadata: unknown;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  created_at: string;
  updated_at: string;
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
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

function getProviderClientId(provider: PluginAuthProviderDefinition) {
  return provider.clientId || (provider.clientIdEnv ? process.env[provider.clientIdEnv] : "") || "";
}

function getProviderClientSecret(provider: PluginAuthProviderDefinition) {
  return provider.clientSecret || (provider.clientSecretEnv ? process.env[provider.clientSecretEnv] : "") || "";
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

function mapConnectionRow(row: PluginConnectionRow): PluginAuthConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.catalog_item_id,
    providerKey: row.provider_key,
    ownerUserId: row.owner_user_id,
    externalAccountId: row.external_account_id || undefined,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    scopes: asStringArray(row.scopes),
    status: row.status,
    expiresAt: row.expires_at || undefined,
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
    providerKey: row.provider_key,
    userId: row.user_id,
    status: row.status,
    state: row.state,
    codeVerifier: row.code_verifier || undefined,
    redirectUri: row.redirect_uri,
    authorizeUrl: row.authorize_url || undefined,
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

function buildCallbackUrl() {
  return `${config.app.baseUrl.replace(/\/$/, "")}/api/v1/mcp/auth/callback`;
}

async function getPluginAuthSpec(pluginId: string, catalogVersionId?: string | null) {
  const result = await query<{
    catalog_item_id: string;
    catalog_version_id: string | null;
    auth_providers: unknown;
  }>(
    `SELECT
       item.id AS catalog_item_id,
       version.id AS catalog_version_id,
       spec.auth_providers
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
    authProviders: Array.isArray(row.auth_providers)
      ? (row.auth_providers as PluginAuthProviderDefinition[])
      : [],
  };
}

function getProvider(
  providers: PluginAuthProviderDefinition[],
  providerKey: string,
) {
  const provider = providers.find((item) => item.key === providerKey);
  if (!provider) {
    throw new PluginAuthError(404, "Auth provider not found");
  }
  return provider;
}

async function exchangeAuthorizationCode(
  provider: PluginAuthProviderDefinition,
  input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
) {
  const clientId = getProviderClientId(provider);
  if (!clientId) {
    throw new PluginAuthError(
      400,
      `Auth provider '${provider.key}' is missing a clientId/clientIdEnv`,
    );
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: clientId,
    code_verifier: input.codeVerifier,
  });

  if (provider.audience) {
    params.set("audience", provider.audience);
  }
  for (const [key, value] of Object.entries(provider.extraTokenParams || {})) {
    params.set(key, value);
  }

  const clientSecret = getProviderClientSecret(provider);
  if (clientSecret) {
    params.set("client_secret", clientSecret);
  }

  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  const body = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new PluginAuthError(
      response.status || 400,
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : "Token exchange failed",
    );
  }

  return body;
}

async function fetchProfile(
  provider: PluginAuthProviderDefinition,
  accessToken: string,
) {
  if (!provider.userInfoUrl) return {};

  const response = await fetch(provider.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PluginAuthError(response.status || 400, "Failed to fetch provider profile");
  }
  return asObject(body);
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

async function getConnectionRow(
  connectionId: string,
  workspaceId: string,
  userId: string,
) {
  const result = await query<PluginConnectionRow>(
    `SELECT
       connection.*,
       installation.catalog_item_id
     FROM plugin_connections connection
     JOIN plugin_installations installation
       ON installation.id = connection.installation_id
     WHERE connection.id = $1
       AND connection.workspace_id = $2
       AND connection.owner_user_id = $3
     LIMIT 1`,
    [connectionId, workspaceId, userId],
  );
  if (result.rows.length === 0) {
    throw new PluginAuthError(404, "Auth connection not found");
  }
  return result.rows[0]!;
}

export async function startPluginAuthSession(input: {
  workspaceId: string;
  pluginId: string;
  providerKey: string;
  userId: string;
  metadata?: Record<string, unknown>;
}) {
  const spec = await getPluginAuthSpec(input.pluginId);
  if (!spec.catalogVersionId) {
    throw new PluginAuthError(400, "Plugin has no active version");
  }

  const provider = getProvider(spec.authProviders, input.providerKey);
  const clientId = getProviderClientId(provider);
  if (!clientId) {
    throw new PluginAuthError(400, `Auth provider '${provider.key}' is not configured`);
  }

  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(24));
  const redirectUri = buildCallbackUrl();
  const authorizeUrl = new URL(provider.authorizeUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if ((provider.scopes || []).length > 0) {
    authorizeUrl.searchParams.set("scope", (provider.scopes || []).join(" "));
  }
  if (provider.audience) {
    authorizeUrl.searchParams.set("audience", provider.audience);
  }
  for (const [key, value] of Object.entries(provider.extraAuthorizeParams || {})) {
    authorizeUrl.searchParams.set(key, value);
  }

  const inserted = await query<PluginAuthSessionRow>(
    `INSERT INTO plugin_auth_sessions (
       workspace_id,
       catalog_item_id,
       catalog_version_id,
       provider_key,
       user_id,
       status,
       state,
       code_verifier,
       redirect_uri,
       authorize_url,
       metadata,
       expires_at
     )
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10::jsonb, NOW() + INTERVAL '1 hour')
     RETURNING *`,
    [
      input.workspaceId,
      spec.catalogItemId,
      spec.catalogVersionId,
      provider.key,
      input.userId,
      state,
      verifier,
      redirectUri,
      authorizeUrl.toString(),
      JSON.stringify(input.metadata || {}),
    ],
  );

  return {
    session: mapSessionRow(inserted.rows[0]!),
    authorizeUrl: authorizeUrl.toString(),
  };
}

export async function getPluginAuthSession(
  sessionId: string,
  workspaceId: string,
  userId: string,
) {
  return mapSessionRow(await getSessionRow(sessionId, workspaceId, userId));
}

export async function handlePluginAuthCallback(input: {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}) {
  if (!input.state) {
    throw new PluginAuthError(400, "Missing OAuth state");
  }

  const sessionResult = await query<PluginAuthSessionRow>(
    `SELECT *
     FROM plugin_auth_sessions
     WHERE state = $1
     LIMIT 1`,
    [input.state],
  );
  if (sessionResult.rows.length === 0) {
    throw new PluginAuthError(404, "Auth session not found");
  }
  const session = sessionResult.rows[0]!;

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
           error_code = $2,
           error_message = $3,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [session.id, input.error, input.errorDescription || input.error],
    );
    return mapSessionRow(failed.rows[0]!);
  }

  if (!input.code) {
    throw new PluginAuthError(400, "Missing authorization code");
  }

  const spec = await getPluginAuthSpec(session.catalog_item_id, session.catalog_version_id);
  const provider = getProvider(spec.authProviders, session.provider_key);
  const tokenResponse = await exchangeAuthorizationCode(provider, {
    code: input.code,
    codeVerifier: session.code_verifier || "",
    redirectUri: session.redirect_uri,
  });

  const accessToken = typeof tokenResponse.access_token === "string" ? tokenResponse.access_token : "";
  if (!accessToken) {
    throw new PluginAuthError(400, "Provider did not return an access token");
  }

  const profile = await fetchProfile(provider, accessToken);
  const externalAccountId =
    getByPath(profile, provider.profileIdPath) ||
    tokenResponse.sub ||
    tokenResponse.user_id;
  const displayName =
    getByPath(profile, provider.profileDisplayNamePath) ||
    tokenResponse.name ||
    tokenResponse.preferred_username;
  const avatarUrl = getByPath(profile, provider.profileAvatarUrlPath);
  const scopes =
    typeof tokenResponse.scope === "string"
      ? tokenResponse.scope.split(/\s+/).filter(Boolean)
      : provider.scopes || [];
  const expiresAt =
    typeof tokenResponse.expires_in === "number"
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : null;

  const preview = {
    externalAccountId: externalAccountId ? String(externalAccountId) : undefined,
    displayName: displayName ? String(displayName) : undefined,
    avatarUrl: avatarUrl ? String(avatarUrl) : undefined,
    scopes,
  };

  const metadata = {
    ...asObject(session.metadata),
    connectionPayload: {
      externalAccountId: externalAccountId ? String(externalAccountId) : null,
      displayName: displayName ? String(displayName) : null,
      avatarUrl: avatarUrl ? String(avatarUrl) : null,
      scopes,
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
      profile,
      tokenResponse,
    },
  };

  const updated = await query<PluginAuthSessionRow>(
    `UPDATE plugin_auth_sessions
     SET status = 'completed',
         result_preview = $2::jsonb,
         error_code = NULL,
         error_message = NULL,
         metadata = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [session.id, JSON.stringify(preview), JSON.stringify(metadata)],
  );

  return mapSessionRow(updated.rows[0]!);
}

export async function getAuthConnection(
  connectionId: string,
  workspaceId: string,
  userId: string,
) {
  return mapConnectionRow(await getConnectionRow(connectionId, workspaceId, userId));
}

export async function attachAuthConnectionsToConfig(input: {
  installationId: string;
  workspaceId: string;
  userId: string;
  configFields: PluginConfigFieldDefinition[];
  authProviders: PluginAuthProviderDefinition[];
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
}) {
  const result: Record<string, unknown> = { ...(input.configData || {}) };
  const authSessionIds = input.authSessionIds || {};
  const providerMap = new Map(input.authProviders.map((provider) => [provider.key, provider]));
  const oauthFields = input.configFields.filter((field) => field.type === "oauth_connection");

  for (const field of oauthFields) {
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
    const providerKey =
      (typeof metadata.providerKey === "string" ? metadata.providerKey : undefined) ||
      session.provider_key;

    if (field.authProviderKey && providerKey !== field.authProviderKey) {
      throw new PluginAuthError(
        400,
        `Authorization provider mismatch for '${field.key}'`,
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
        input.userId,
      );
    } else {
      const payload = asObject(metadata.connectionPayload);
      if (!payload.accessToken) {
        throw new PluginAuthError(
          400,
          `Authorization for '${field.key}' is missing connection payload`,
        );
      }

      const existing = await query<PluginConnectionRow>(
        `SELECT
           connection.*,
           installation.catalog_item_id
         FROM plugin_connections connection
         JOIN plugin_installations installation
           ON installation.id = connection.installation_id
         WHERE connection.installation_id = $1
           AND connection.workspace_id = $2
           AND connection.owner_user_id = $3
           AND connection.provider_key = $4
           AND connection.external_account_id IS NOT DISTINCT FROM $5
         ORDER BY connection.updated_at DESC
         LIMIT 1`,
        [
          input.installationId,
          input.workspaceId,
          input.userId,
          providerKey,
          typeof payload.externalAccountId === "string"
            ? payload.externalAccountId
            : null,
        ],
      );

      let connectionRow: PluginConnectionRow;
      if (existing.rows.length > 0) {
        const updated = await query<PluginConnectionRow>(
          `UPDATE plugin_connections
           SET display_name = $2,
               avatar_url = $3,
               scopes = $4,
               access_token = $5,
               refresh_token = $6,
               token_type = $7,
               status = 'active',
               expires_at = $8,
               profile = $9::jsonb,
               metadata = $10::jsonb,
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
            typeof payload.displayName === "string" ? payload.displayName : null,
            typeof payload.avatarUrl === "string" ? payload.avatarUrl : null,
            asStringArray(payload.scopes),
            payload.accessToken,
            typeof payload.refreshToken === "string" ? payload.refreshToken : null,
            typeof payload.tokenType === "string" ? payload.tokenType : null,
            typeof payload.expiresAt === "string" ? payload.expiresAt : null,
            JSON.stringify(asObject(payload.profile)),
            JSON.stringify({
              provider: providerMap.get(providerKey)?.key,
              sourceSessionId: session.id,
              tokenResponse: asObject(payload.tokenResponse),
            }),
          ],
        );
        connectionRow = updated.rows[0]!;
      } else {
        const inserted = await query<PluginConnectionRow>(
          `INSERT INTO plugin_connections (
             installation_id,
             workspace_id,
             owner_user_id,
             provider_key,
             external_account_id,
             display_name,
             avatar_url,
             scopes,
             access_token,
             refresh_token,
             token_type,
             status,
             expires_at,
             profile,
             metadata
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13::jsonb, $14::jsonb
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
            input.userId,
            providerKey,
            typeof payload.externalAccountId === "string"
              ? payload.externalAccountId
              : null,
            typeof payload.displayName === "string" ? payload.displayName : null,
            typeof payload.avatarUrl === "string" ? payload.avatarUrl : null,
            asStringArray(payload.scopes),
            payload.accessToken,
            typeof payload.refreshToken === "string" ? payload.refreshToken : null,
            typeof payload.tokenType === "string" ? payload.tokenType : null,
            typeof payload.expiresAt === "string" ? payload.expiresAt : null,
            JSON.stringify(asObject(payload.profile)),
            JSON.stringify({
              provider: providerMap.get(providerKey)?.key,
              sourceSessionId: session.id,
              tokenResponse: asObject(payload.tokenResponse),
            }),
          ],
        );
        connectionRow = inserted.rows[0]!;
      }

      connection = mapConnectionRow(connectionRow);

      await query(
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
      __kind: "oauth_connection_ref",
      connectionId: connection.id,
      providerKey: connection.providerKey,
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
    if (ref.__kind !== "oauth_connection_ref" || typeof ref.connectionId !== "string") {
      continue;
    }

    const result = await query<PluginConnectionRow>(
      `SELECT
         connection.*,
         installation.catalog_item_id
       FROM plugin_connections connection
       JOIN plugin_installations installation
         ON installation.id = connection.installation_id
       WHERE connection.id = $1
       LIMIT 1`,
      [ref.connectionId],
    );
    if (result.rows.length === 0) continue;

    const row = result.rows[0]!;
    resolved[key] = {
      type: "oauth_connection",
      connectionId: row.id,
      providerKey: row.provider_key,
      externalAccountId: row.external_account_id || undefined,
      displayName: row.display_name || undefined,
      avatarUrl: row.avatar_url || undefined,
      scopes: asStringArray(row.scopes),
      accessToken: row.access_token ? decrypt(row.access_token) : undefined,
      refreshToken: row.refresh_token ? decrypt(row.refresh_token) : undefined,
      tokenType: row.token_type || undefined,
      expiresAt: row.expires_at || undefined,
      profile: asObject(row.profile),
      metadata: asObject(row.metadata),
    };
  }
  return resolved;
}
