import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_MAX_AGE_SECONDS,
  AUTH_SESSION_TOUCH_INTERVAL_SECONDS,
} from '@synapse/shared';
import type {
  AuthClientType,
  AuthSessionSummary,
  AuthTransport,
  User,
} from '@synapse/shared';
import { query } from '../../infrastructure/database/index.js';
import {
  disconnectSocketsForSession,
  disconnectSocketsForUser,
} from '../../infrastructure/websocket/auth-session-registry.js';
import { ensureConfiguredPlatformAdminForUser } from '../platform/admin-service.js';

const SALT_ROUNDS = 10;

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface AuthenticatedSessionRow {
  session_id: string;
  session_user_id: string;
  session_client_type: AuthClientType;
  session_transport: AuthTransport;
  session_device_name: string | null;
  session_platform: string | null;
  session_created_at: string;
  session_updated_at: string;
  session_last_seen_at: string;
  session_expires_at: string;
  session_revoked_at: string | null;
  session_revoke_reason: string | null;
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionContextInput {
  request: FastifyRequest;
  clientType?: AuthClientType;
  transport?: AuthTransport;
  deviceName?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthenticatedRequestSession {
  user: User;
  session: AuthSessionSummary;
}

export interface AuthServiceResult {
  user: User;
  session: AuthSessionSummary;
  sessionToken: string;
}

function mapUserRow(row: Pick<UserRow, 'id' | 'email' | 'name' | 'avatar_url' | 'created_at' | 'updated_at'>): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAuthenticatedSessionRow(row: AuthenticatedSessionRow, current = true): AuthSessionSummary {
  return {
    id: row.session_id,
    clientType: row.session_client_type,
    transport: row.session_transport,
    deviceName: row.session_device_name ?? undefined,
    platform: row.session_platform ?? undefined,
    current,
    createdAt: row.session_created_at,
    lastSeenAt: row.session_last_seen_at,
    expiresAt: row.session_expires_at,
    revokedAt: row.session_revoked_at ?? undefined,
  };
}

function sanitizeOptionalText(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function getClientType(input?: AuthClientType): AuthClientType {
  return input || 'web';
}

function getTransport(input?: AuthTransport): AuthTransport {
  return input || 'cookie';
}

function getTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSessionToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

function getTokenHint(token: string): string {
  return token.slice(0, 8);
}

function extractIpAddress(request: FastifyRequest): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = firstForwarded?.split(',')[0]?.trim() || request.ip;
  return sanitizeOptionalText(ip, 120);
}

function extractUserAgent(request: FastifyRequest): string | undefined {
  const userAgent = Array.isArray(request.headers['user-agent'])
    ? request.headers['user-agent'][0]
    : request.headers['user-agent'];
  return sanitizeOptionalText(userAgent, 1000);
}

function getSessionExpiryDate() {
  return new Date(Date.now() + AUTH_SESSION_MAX_AGE_SECONDS * 1000);
}

async function insertSession(user: User, input: SessionContextInput): Promise<{ session: AuthSessionSummary; sessionToken: string }> {
  const sessionToken = generateSessionToken();
  const tokenHash = getTokenHash(sessionToken);
  const expiresAt = getSessionExpiryDate().toISOString();
  const clientType = getClientType(input.clientType);
  const transport = getTransport(input.transport);
  const deviceName = sanitizeOptionalText(input.deviceName, 255) ?? null;
  const platform = sanitizeOptionalText(input.platform, 120) ?? null;
  const ipAddress = extractIpAddress(input.request) ?? null;
  const userAgent = extractUserAgent(input.request) ?? null;
  const metadata = input.metadata ?? {};

  const result = await query<{
    id: string;
    client_type: AuthClientType;
    transport: AuthTransport;
    device_name: string | null;
    platform: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `INSERT INTO auth_sessions (
       user_id,
       client_type,
       transport,
       device_name,
       platform,
       token_hash,
       token_hint,
       ip_address,
       user_agent,
       metadata,
       expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING id, client_type, transport, device_name, platform, created_at, last_seen_at, expires_at, revoked_at`,
    [
      user.id,
      clientType,
      transport,
      deviceName,
      platform,
      tokenHash,
      getTokenHint(sessionToken),
      ipAddress,
      userAgent,
      JSON.stringify(metadata),
      expiresAt,
    ],
  );

  const row = result.rows[0];

  return {
    sessionToken,
    session: {
      id: row.id,
      clientType: row.client_type,
      transport: row.transport,
      deviceName: row.device_name ?? undefined,
      platform: row.platform ?? undefined,
      current: true,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
    },
  };
}

async function getUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, name, avatar_url, password_hash, created_at, updated_at
       FROM users
      WHERE email = $1`,
    [email.toLowerCase()],
  );

  return result.rows[0] ?? null;
}

async function getUserById(userId: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT id, email, name, avatar_url, password_hash, created_at, updated_at
       FROM users
      WHERE id = $1`,
    [userId],
  );

  return result.rows[0] ?? null;
}

async function touchSessionIfNeeded(row: AuthenticatedSessionRow, request: FastifyRequest) {
  const lastSeenAtMs = new Date(row.session_last_seen_at).getTime();
  if (!Number.isFinite(lastSeenAtMs)) return;
  if (Date.now() - lastSeenAtMs < AUTH_SESSION_TOUCH_INTERVAL_SECONDS * 1000) return;

  await query(
    `UPDATE auth_sessions
        SET last_seen_at = NOW(),
            updated_at = NOW(),
            ip_address = $2,
            user_agent = $3
      WHERE id = $1`,
    [row.session_id, extractIpAddress(request) ?? null, extractUserAgent(request) ?? null],
  );
}

async function findAuthenticatedSession(token: string): Promise<AuthenticatedSessionRow | null> {
  const tokenHash = getTokenHash(token);

  const result = await query<AuthenticatedSessionRow>(
    `SELECT
        s.id AS session_id,
        s.user_id AS session_user_id,
        s.client_type AS session_client_type,
        s.transport AS session_transport,
        s.device_name AS session_device_name,
        s.platform AS session_platform,
        s.created_at AS session_created_at,
        s.updated_at AS session_updated_at,
        s.last_seen_at AS session_last_seen_at,
        s.expires_at AS session_expires_at,
        s.revoked_at AS session_revoked_at,
        s.revoke_reason AS session_revoke_reason,
        u.id,
        u.email,
        u.name,
        u.avatar_url,
        u.created_at,
        u.updated_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export function extractSessionTokenFromRequest(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }

  const cookieToken = request.cookies?.[AUTH_SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.trim().length > 0) {
    return cookieToken.trim();
  }

  return null;
}

export async function authenticateSessionToken(
  token: string,
  request?: FastifyRequest,
): Promise<AuthenticatedRequestSession | null> {
  const row = await findAuthenticatedSession(token);
  if (!row) return null;

  if (request) {
    await touchSessionIfNeeded(row, request);
  }

  return {
    user: mapUserRow(row),
    session: mapAuthenticatedSessionRow(row),
  };
}

export async function authenticateRequestSession(request: FastifyRequest): Promise<AuthenticatedRequestSession | null> {
  const token = extractSessionTokenFromRequest(request);
  if (!token) return null;
  return authenticateSessionToken(token, request);
}

async function revokeSessionById(sessionId: string, reason: string) {
  await query(
    `UPDATE auth_sessions
        SET revoked_at = NOW(),
            revoke_reason = $2,
            updated_at = NOW()
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

async function revokeAllSessionsForUser(userId: string, reason: string, exceptSessionId?: string) {
  const params: any[] = [userId, reason];
  let filter = '';

  if (exceptSessionId) {
    params.push(exceptSessionId);
    filter = 'AND id <> $3';
  }

  await query(
    `UPDATE auth_sessions
        SET revoked_at = NOW(),
            revoke_reason = $2,
            updated_at = NOW()
      WHERE user_id = $1
        AND revoked_at IS NULL
        ${filter}`,
    params,
  );
}

async function disconnectSocketsBestEffort(action: Promise<unknown>, context: string) {
  try {
    await action;
  } catch (error) {
    console.error(`[auth] Failed to disconnect websocket sessions after ${context}:`, error);
  }
}

export function createAuthService(_app: FastifyInstance) {
  async function register(
    email: string,
    password: string,
    name: string,
    sessionContext: SessionContextInput,
  ): Promise<AuthServiceResult> {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await getUserByEmail(normalizedEmail);
    if (existing) {
      throw new AuthError('A user with this email already exists', 409, 'EMAIL_TAKEN');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await query<UserRow>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, avatar_url, password_hash, created_at, updated_at`,
      [normalizedEmail, passwordHash, name.trim()],
    );

    const user = mapUserRow(result.rows[0]);
    await ensureConfiguredPlatformAdminForUser({ id: user.id, email: user.email });
    const { session, sessionToken } = await insertSession(user, sessionContext);

    return { user, session, sessionToken };
  }

  async function login(
    email: string,
    password: string,
    sessionContext: SessionContextInput,
  ): Promise<AuthServiceResult> {
    const row = await getUserByEmail(email.trim().toLowerCase());

    if (!row) {
      throw new AuthError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      throw new AuthError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    const user = mapUserRow(row);
    await ensureConfiguredPlatformAdminForUser({ id: user.id, email: user.email });
    const { session, sessionToken } = await insertSession(user, sessionContext);

    return { user, session, sessionToken };
  }

  async function getProfile(userId: string): Promise<User> {
    const row = await getUserById(userId);
    if (!row) {
      throw new AuthError('User not found', 404, 'USER_NOT_FOUND');
    }

    return mapUserRow(row);
  }

  async function updateProfile(userId: string, input: { name?: string; avatarUrl?: string | null }): Promise<User> {
    const current = await getProfile(userId);
    const nextName = input.name === undefined ? current.name : input.name.trim();
    const nextAvatarUrl = input.avatarUrl === undefined ? current.avatarUrl ?? null : input.avatarUrl;

    const result = await query<UserRow>(
      `UPDATE users
          SET name = $2,
              avatar_url = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, name, avatar_url, password_hash, created_at, updated_at`,
      [userId, nextName, nextAvatarUrl ?? null],
    );

    if (!result.rowCount) {
      throw new AuthError('User not found', 404, 'USER_NOT_FOUND');
    }

    return mapUserRow(result.rows[0]);
  }

  async function getCurrentSession(request: FastifyRequest): Promise<AuthenticatedRequestSession> {
    const authenticated = await authenticateRequestSession(request);
    if (!authenticated) {
      throw new AuthError('Authentication required', 401, 'UNAUTHENTICATED');
    }

    return authenticated;
  }

  async function listSessions(userId: string, currentSessionId?: string): Promise<AuthSessionSummary[]> {
    const result = await query<{
      id: string;
      client_type: AuthClientType;
      transport: AuthTransport;
      device_name: string | null;
      platform: string | null;
      created_at: string;
      last_seen_at: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      `SELECT id, client_type, transport, device_name, platform, created_at, last_seen_at, expires_at, revoked_at
         FROM auth_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      clientType: row.client_type,
      transport: row.transport,
      deviceName: row.device_name ?? undefined,
      platform: row.platform ?? undefined,
      current: row.id === currentSessionId,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
    }));
  }

  async function logoutCurrentSession(sessionId: string) {
    await revokeSessionById(sessionId, 'logout');
    await disconnectSocketsBestEffort(
      disconnectSocketsForSession(sessionId, 'Session logged out'),
      `logout of session ${sessionId}`,
    );
  }

  async function logoutAllSessions(userId: string, exceptSessionId?: string) {
    await revokeAllSessionsForUser(userId, 'logout_all', exceptSessionId);
    await disconnectSocketsBestEffort(
      disconnectSocketsForUser(userId, 'All sessions were logged out', exceptSessionId),
      `logout-all for user ${userId}`,
    );
  }

  async function revokeSessionForUser(userId: string, sessionId: string) {
    const result = await query<{ id: string }>(
      `SELECT id
         FROM auth_sessions
        WHERE id = $1
          AND user_id = $2
        LIMIT 1`,
      [sessionId, userId],
    );

    if (!result.rowCount) {
      throw new AuthError('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    await revokeSessionById(sessionId, 'revoked_by_user');
    await disconnectSocketsBestEffort(
      disconnectSocketsForSession(sessionId, 'Session revoked'),
      `revocation of session ${sessionId}`,
    );
  }

  return {
    register,
    login,
    getProfile,
    updateProfile,
    getCurrentSession,
    listSessions,
    logoutCurrentSession,
    logoutAllSessions,
    revokeSessionForUser,
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
