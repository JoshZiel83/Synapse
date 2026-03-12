import { createHash, randomBytes } from 'crypto';
import type {
  CapabilityAuthConnection,
  CapabilityAuthProviderDefinition,
  CapabilityAuthSession,
  CapabilityPackageRevision,
} from '@synapse/shared';
import { config } from '../../config/index.js';
import { decrypt, encrypt } from '../../infrastructure/crypto/index.js';
import { query } from '../../infrastructure/database/index.js';
import { getCapabilityPackage } from '../capabilities/service.js';

export class PluginAuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function base64Url(buffer: Buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function getProviderForPackage(pkg: Awaited<ReturnType<typeof getCapabilityPackage>>, providerKey: string) {
  if (!pkg.latestRevision) {
    throw new PluginAuthError(400, 'Plugin has no active revision');
  }
  const provider = (pkg.latestRevision.authProviders || []).find((item) => item.key === providerKey);
  if (!provider) {
    throw new PluginAuthError(404, 'Auth provider not found');
  }
  return provider;
}

function getProviderClientId(provider: CapabilityAuthProviderDefinition) {
  return provider.clientId || (provider.clientIdEnv ? process.env[provider.clientIdEnv] : '') || '';
}

function getProviderClientSecret(provider: CapabilityAuthProviderDefinition) {
  return provider.clientSecret || (provider.clientSecretEnv ? process.env[provider.clientSecretEnv] : '') || '';
}

function getByPath(source: unknown, path?: string): unknown {
  if (!path) return undefined;
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mapConnectionRow(row: any): CapabilityAuthConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.package_id,
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

function mapSessionRow(row: any): CapabilityAuthSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    packageId: row.package_id,
    revisionId: row.revision_id || undefined,
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
    authConnectionId: row.auth_connection_id || undefined,
    metadata: asObject(row.metadata),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildCallbackUrl() {
  return `${config.app.baseUrl.replace(/\/$/, '')}/api/v1/mcp/auth/callback`;
}

async function exchangeAuthorizationCode(provider: CapabilityAuthProviderDefinition, input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const clientId = getProviderClientId(provider);
  if (!clientId) {
    throw new PluginAuthError(400, `Auth provider '${provider.key}' is missing a clientId/clientIdEnv`);
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: clientId,
    code_verifier: input.codeVerifier,
  });
  if (provider.audience) params.set('audience', provider.audience);
  for (const [key, value] of Object.entries(provider.extraTokenParams || {})) {
    params.set(key, value);
  }

  const clientSecret = getProviderClientSecret(provider);
  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });

  const body = asObject(await response.json().catch(() => ({})));
  if (!response.ok) {
    throw new PluginAuthError(
      response.status || 400,
      typeof body?.error_description === 'string'
        ? body.error_description
        : typeof body?.error === 'string'
          ? body.error
          : 'Token exchange failed',
    );
  }

  return asObject(body);
}

async function fetchProfile(provider: CapabilityAuthProviderDefinition, accessToken: string) {
  if (!provider.userInfoUrl) return {};
  const response = await fetch(provider.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PluginAuthError(response.status || 400, 'Failed to fetch provider profile');
  }
  return asObject(body);
}

export async function startPluginAuthSession(input: {
  workspaceId: string;
  pluginId: string;
  providerKey: string;
  userId: string;
  metadata?: Record<string, unknown>;
}) {
  const pkg = await getCapabilityPackage(input.pluginId);
  if (pkg.kind !== 'plugin') {
    throw new PluginAuthError(404, 'Plugin not found');
  }
  const provider = getProviderForPackage(pkg, input.providerKey);
  const clientId = getProviderClientId(provider);
  if (!clientId) {
    throw new PluginAuthError(400, `Auth provider '${provider.key}' is not configured`);
  }

  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(24));
  const redirectUri = buildCallbackUrl();
  const authorizeUrl = new URL(provider.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if ((provider.scopes || []).length > 0) {
    authorizeUrl.searchParams.set('scope', (provider.scopes || []).join(' '));
  }
  if (provider.audience) {
    authorizeUrl.searchParams.set('audience', provider.audience);
  }
  for (const [key, value] of Object.entries(provider.extraAuthorizeParams || {})) {
    authorizeUrl.searchParams.set(key, value);
  }

  const result = await query(
    `INSERT INTO capability_auth_sessions (
       workspace_id, package_id, revision_id, provider_key, user_id, status, state,
       code_verifier, redirect_uri, authorize_url, metadata, expires_at
     )
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, NOW() + INTERVAL '1 hour')
     RETURNING *`,
    [
      input.workspaceId,
      pkg.id,
      pkg.latestRevisionId || null,
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
    session: mapSessionRow(result.rows[0]),
    authorizeUrl: authorizeUrl.toString(),
  };
}

export async function getPluginAuthSession(sessionId: string, workspaceId: string, userId: string) {
  const result = await query(
    `SELECT * FROM capability_auth_sessions
     WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
    [sessionId, workspaceId, userId],
  );
  if (result.rows.length === 0) {
    throw new PluginAuthError(404, 'Auth session not found');
  }
  return mapSessionRow(result.rows[0]);
}

export async function handlePluginAuthCallback(input: {
  state?: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}) {
  if (!input.state) {
    throw new PluginAuthError(400, 'Missing OAuth state');
  }

  const sessionResult = await query(
    `SELECT * FROM capability_auth_sessions WHERE state = $1`,
    [input.state],
  );
  if (sessionResult.rows.length === 0) {
    throw new PluginAuthError(404, 'Auth session not found');
  }
  const sessionRow = sessionResult.rows[0];

  if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
    await query(
      `UPDATE capability_auth_sessions
       SET status = 'expired', updated_at = NOW()
       WHERE id = $1`,
      [sessionRow.id],
    );
    throw new PluginAuthError(410, 'Auth session expired');
  }

  if (input.error) {
    await query(
      `UPDATE capability_auth_sessions
       SET status = 'failed', error_code = $2, error_message = $3, updated_at = NOW()
       WHERE id = $1`,
      [sessionRow.id, input.error, input.errorDescription || input.error],
    );
    return mapSessionRow({ ...sessionRow, status: 'failed', error_code: input.error, error_message: input.errorDescription || input.error });
  }

  if (!input.code) {
    throw new PluginAuthError(400, 'Missing authorization code');
  }

  const pkg = await getCapabilityPackage(sessionRow.package_id);
  const provider = getProviderForPackage(pkg, sessionRow.provider_key);
  const tokenResponse = await exchangeAuthorizationCode(provider, {
    code: input.code,
    codeVerifier: sessionRow.code_verifier,
    redirectUri: sessionRow.redirect_uri,
  });

  const accessToken = typeof tokenResponse.access_token === 'string' ? tokenResponse.access_token : '';
  if (!accessToken) {
    throw new PluginAuthError(400, 'Provider did not return an access token');
  }

  const profile = await fetchProfile(provider, accessToken);
  const externalAccountId = getByPath(profile, provider.profileIdPath) || tokenResponse.sub || tokenResponse.user_id;
  const displayName = getByPath(profile, provider.profileDisplayNamePath) || tokenResponse.name || tokenResponse.preferred_username;
  const avatarUrl = getByPath(profile, provider.profileAvatarUrlPath);
  const scopes = typeof tokenResponse.scope === 'string'
    ? tokenResponse.scope.split(/\s+/).filter(Boolean)
    : (provider.scopes || []);

  const existingConnection = externalAccountId
    ? await query(
        `SELECT * FROM capability_auth_connections
         WHERE workspace_id = $1 AND package_id = $2 AND provider_key = $3 AND owner_user_id = $4 AND external_account_id = $5
         ORDER BY updated_at DESC
         LIMIT 1`,
        [sessionRow.workspace_id, sessionRow.package_id, provider.key, sessionRow.user_id, String(externalAccountId)],
      )
    : { rows: [] };

  let connectionRow: any;
  if (existingConnection.rows.length > 0) {
    const updateResult = await query(
      `UPDATE capability_auth_connections
       SET display_name = $2,
           avatar_url = $3,
           scopes = $4,
           access_token = $5,
           refresh_token = $6,
           token_type = $7,
           status = 'active',
           expires_at = $8,
           profile = $9,
           metadata = $10,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        existingConnection.rows[0].id,
        displayName ? String(displayName) : null,
        avatarUrl ? String(avatarUrl) : null,
        scopes,
        encrypt(accessToken),
        typeof tokenResponse.refresh_token === 'string' ? encrypt(tokenResponse.refresh_token) : null,
        typeof tokenResponse.token_type === 'string' ? tokenResponse.token_type : null,
        typeof tokenResponse.expires_in === 'number' ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString() : null,
        JSON.stringify(profile),
        JSON.stringify({ tokenResponse }),
      ],
    );
    connectionRow = updateResult.rows[0];
  } else {
    const insertResult = await query(
      `INSERT INTO capability_auth_connections (
         workspace_id, package_id, provider_key, owner_user_id, external_account_id, display_name,
         avatar_url, scopes, access_token, refresh_token, token_type, status, expires_at, profile, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13, $14)
       RETURNING *`,
      [
        sessionRow.workspace_id,
        sessionRow.package_id,
        provider.key,
        sessionRow.user_id,
        externalAccountId ? String(externalAccountId) : null,
        displayName ? String(displayName) : null,
        avatarUrl ? String(avatarUrl) : null,
        scopes,
        encrypt(accessToken),
        typeof tokenResponse.refresh_token === 'string' ? encrypt(tokenResponse.refresh_token) : null,
        typeof tokenResponse.token_type === 'string' ? tokenResponse.token_type : null,
        typeof tokenResponse.expires_in === 'number' ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString() : null,
        JSON.stringify(profile),
        JSON.stringify({ tokenResponse }),
      ],
    );
    connectionRow = insertResult.rows[0];
  }

  const preview = {
    externalAccountId: externalAccountId ? String(externalAccountId) : undefined,
    displayName: displayName ? String(displayName) : undefined,
    avatarUrl: avatarUrl ? String(avatarUrl) : undefined,
    scopes,
  };

  const updateSession = await query(
    `UPDATE capability_auth_sessions
     SET status = 'completed',
         result_preview = $2,
         auth_connection_id = $3,
         error_code = NULL,
         error_message = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [sessionRow.id, JSON.stringify(preview), connectionRow.id],
  );

  return mapSessionRow(updateSession.rows[0]);
}

export async function getAuthConnection(connectionId: string, workspaceId: string, userId: string) {
  const result = await query(
    `SELECT * FROM capability_auth_connections
     WHERE id = $1 AND workspace_id = $2 AND owner_user_id = $3`,
    [connectionId, workspaceId, userId],
  );
  if (result.rows.length === 0) {
    throw new PluginAuthError(404, 'Auth connection not found');
  }
  return mapConnectionRow(result.rows[0]);
}

export async function attachAuthConnectionsToConfig(input: {
  workspaceId: string;
  userId: string;
  revision?: CapabilityPackageRevision;
  existingConfig?: Record<string, unknown>;
  configData?: Record<string, unknown>;
  authSessionIds?: Record<string, string>;
}) {
  const result: Record<string, unknown> = { ...(input.existingConfig || {}), ...(input.configData || {}) };
  const authSessionIds = input.authSessionIds || {};
  const oauthFields = (input.revision?.configFields || []).filter((field) => field.type === 'oauth_connection');

  for (const field of oauthFields) {
    const sessionId = authSessionIds[field.key];
    if (!sessionId) {
      continue;
    }
    const session = await getPluginAuthSession(sessionId, input.workspaceId, input.userId);
    if (session.status !== 'completed' || !session.authConnectionId) {
      throw new PluginAuthError(400, `Authorization for '${field.key}' is not completed`);
    }
    const connection = await getAuthConnection(session.authConnectionId, input.workspaceId, input.userId);
    if (field.authProviderKey && connection.providerKey !== field.authProviderKey) {
      throw new PluginAuthError(400, `Authorization provider mismatch for '${field.key}'`);
    }
    result[field.key] = {
      __kind: 'oauth_connection_ref',
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const ref = value as Record<string, unknown>;
    if (ref.__kind !== 'oauth_connection_ref' || typeof ref.connectionId !== 'string') continue;

    const result = await query(
      `SELECT * FROM capability_auth_connections WHERE id = $1`,
      [ref.connectionId],
    );
    if (result.rows.length === 0) continue;
    const row = result.rows[0];
    resolved[key] = {
      type: 'oauth_connection',
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
