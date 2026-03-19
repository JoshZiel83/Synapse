import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AUTH_QR_LOGIN_REQUEST_TTL_SECONDS,
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_MAX_AGE_SECONDS,
  AUTH_SESSION_TOUCH_INTERVAL_SECONDS,
} from '@synapse/shared';
import type {
  AuthClientType,
  AuthQrLoginCreateResponse,
  AuthQrLoginRequestSummary,
  AuthQrLoginResolveResponse,
  AuthQrLoginStatus,
  AuthQrLoginStatusResponse,
  AuthSessionPersistence,
  AuthSessionSummary,
  AuthTransport,
  User,
} from '@synapse/shared';
import { query, transaction } from '../../infrastructure/database/index.js';
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
  sessionPersistence?: AuthSessionPersistence;
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
  sessionPersistence: AuthSessionPersistence;
}

interface DatabaseExecutor {
  query: typeof query;
}

interface AuthQrLoginRequestRow {
  id: string;
  status: AuthQrLoginStatus;
  browser_ip_address: string | null;
  browser_user_agent: string | null;
  browser_label: string;
  approved_session_persistence: AuthSessionPersistence | null;
  resolver_user_id: string | null;
  approved_by_user_id: string | null;
  scanned_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  consumed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
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

function getSessionPersistence(input?: AuthSessionPersistence): AuthSessionPersistence {
  return input || 'persistent';
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

function getQrLoginExpiryDate() {
  return new Date(Date.now() + AUTH_QR_LOGIN_REQUEST_TTL_SECONDS * 1000);
}

function getDatabaseExecutor(executor?: DatabaseExecutor): DatabaseExecutor {
  return executor ?? { query };
}

function getBrowserName(userAgent?: string) {
  const value = userAgent?.toLowerCase() ?? '';

  if (value.includes('edg/')) return 'Edge';
  if (value.includes('opr/') || value.includes('opera')) return 'Opera';
  if (value.includes('firefox/') || value.includes('fxios/')) return 'Firefox';
  if (value.includes('chrome/') || value.includes('crios/')) return 'Chrome';
  if (value.includes('safari/') && !value.includes('chrome/') && !value.includes('crios/')) {
    return 'Safari';
  }

  return undefined;
}

function getOperatingSystemName(userAgent?: string) {
  const value = userAgent?.toLowerCase() ?? '';

  if (value.includes('windows')) return 'Windows';
  if (value.includes('iphone') || value.includes('ipad') || value.includes('ipod')) return 'iOS';
  if (value.includes('android')) return 'Android';
  if (value.includes('mac os x') || value.includes('macintosh')) return 'macOS';
  if (value.includes('linux')) return 'Linux';

  return undefined;
}

function describeBrowserSession(userAgent?: string) {
  const browser = getBrowserName(userAgent);
  const operatingSystem = getOperatingSystemName(userAgent);

  if (browser && operatingSystem) {
    return `${browser} on ${operatingSystem}`;
  }

  return browser || operatingSystem || 'This browser';
}

function mapAuthQrLoginRequestRow(row: AuthQrLoginRequestRow): AuthQrLoginRequestSummary {
  return {
    id: row.id,
    status: row.status,
    browserLabel: row.browser_label,
    approvedSessionPersistence: row.approved_session_persistence ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    scannedAt: row.scanned_at ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
  };
}

function isExpiredTimestamp(timestamp: string) {
  const expiresAt = new Date(timestamp).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function isQrLoginExpiredStatus(status: AuthQrLoginStatus) {
  return status !== 'rejected' && status !== 'expired' && status !== 'consumed';
}

async function expireQrLoginRequestIfNeeded(
  row: AuthQrLoginRequestRow,
  executor?: DatabaseExecutor,
): Promise<AuthQrLoginRequestRow> {
  if (!isQrLoginExpiredStatus(row.status) || !isExpiredTimestamp(row.expires_at)) {
    return row;
  }

  const db = getDatabaseExecutor(executor);
  const result = await db.query<AuthQrLoginRequestRow>(
    `UPDATE auth_qr_login_requests
        SET status = 'expired',
            updated_at = NOW()
      WHERE id = $1
        AND status <> 'expired'
        AND status <> 'rejected'
        AND status <> 'consumed'
      RETURNING
        id,
        status,
        browser_ip_address,
        browser_user_agent,
        browser_label,
        approved_session_persistence,
        resolver_user_id,
        approved_by_user_id,
        scanned_at,
        approved_at,
        rejected_at,
        consumed_at,
        expires_at,
        created_at,
        updated_at`,
    [row.id],
  );

  return result.rows[0] ?? { ...row, status: 'expired' };
}

async function insertSession(
  user: User,
  input: SessionContextInput,
  executor?: DatabaseExecutor,
): Promise<{
  session: AuthSessionSummary;
  sessionToken: string;
  sessionPersistence: AuthSessionPersistence;
}> {
  const db = getDatabaseExecutor(executor);
  const sessionToken = generateSessionToken();
  const tokenHash = getTokenHash(sessionToken);
  const expiresAt = getSessionExpiryDate().toISOString();
  const clientType = getClientType(input.clientType);
  const transport = getTransport(input.transport);
  const sessionPersistence = getSessionPersistence(input.sessionPersistence);
  const deviceName = sanitizeOptionalText(input.deviceName, 255) ?? null;
  const platform = sanitizeOptionalText(input.platform, 120) ?? null;
  const ipAddress = extractIpAddress(input.request) ?? null;
  const userAgent = extractUserAgent(input.request) ?? null;
  const metadata = {
    ...(input.metadata ?? {}),
    sessionPersistence,
  };

  const result = await db.query<{
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
    sessionPersistence,
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

async function getUserByEmail(email: string, executor?: DatabaseExecutor): Promise<UserRow | null> {
  const db = getDatabaseExecutor(executor);
  const result = await db.query<UserRow>(
    `SELECT id, email, name, avatar_url, password_hash, created_at, updated_at
       FROM users
      WHERE email = $1`,
    [email.toLowerCase()],
  );

  return result.rows[0] ?? null;
}

async function getUserById(userId: string, executor?: DatabaseExecutor): Promise<UserRow | null> {
  const db = getDatabaseExecutor(executor);
  const result = await db.query<UserRow>(
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

async function getQrLoginRequestById(
  requestId: string,
  browserToken: string,
  executor?: DatabaseExecutor,
  forUpdate = false,
): Promise<AuthQrLoginRequestRow | null> {
  const db = getDatabaseExecutor(executor);
  const result = await db.query<AuthQrLoginRequestRow>(
    `SELECT
        id,
        status,
        browser_ip_address,
        browser_user_agent,
        browser_label,
        approved_session_persistence,
        resolver_user_id,
        approved_by_user_id,
        scanned_at,
        approved_at,
        rejected_at,
        consumed_at,
        expires_at,
        created_at,
        updated_at
       FROM auth_qr_login_requests
      WHERE id = $1
        AND browser_token_hash = $2
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [requestId, getTokenHash(browserToken)],
  );

  return result.rows[0] ?? null;
}

async function getQrLoginRequestByScanToken(
  scanToken: string,
  executor?: DatabaseExecutor,
  forUpdate = false,
): Promise<AuthQrLoginRequestRow | null> {
  const db = getDatabaseExecutor(executor);
  const result = await db.query<AuthQrLoginRequestRow>(
    `SELECT
        id,
        status,
        browser_ip_address,
        browser_user_agent,
        browser_label,
        approved_session_persistence,
        resolver_user_id,
        approved_by_user_id,
        scanned_at,
        approved_at,
        rejected_at,
        consumed_at,
        expires_at,
        created_at,
        updated_at
       FROM auth_qr_login_requests
      WHERE scan_token_hash = $1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [getTokenHash(scanToken)],
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
    const { session, sessionToken, sessionPersistence } = await insertSession(user, sessionContext);

    return { user, session, sessionToken, sessionPersistence };
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
    const { session, sessionToken, sessionPersistence } = await insertSession(user, sessionContext);

    return { user, session, sessionToken, sessionPersistence };
  }

  async function createQrLoginRequest(request: FastifyRequest): Promise<AuthQrLoginCreateResponse> {
    const scanToken = generateSessionToken();
    const browserToken = generateSessionToken();
    const browserUserAgent = extractUserAgent(request);
    const expiresAt = getQrLoginExpiryDate().toISOString();
    const result = await query<AuthQrLoginRequestRow>(
      `INSERT INTO auth_qr_login_requests (
         scan_token_hash,
         browser_token_hash,
         status,
         browser_ip_address,
         browser_user_agent,
         browser_label,
         expires_at
       )
       VALUES ($1, $2, 'pending_scan', $3, $4, $5, $6)
       RETURNING
         id,
         status,
         browser_ip_address,
         browser_user_agent,
         browser_label,
         approved_session_persistence,
         resolver_user_id,
         approved_by_user_id,
         scanned_at,
         approved_at,
         rejected_at,
         consumed_at,
         expires_at,
         created_at,
         updated_at`,
      [
        getTokenHash(scanToken),
        getTokenHash(browserToken),
        extractIpAddress(request) ?? null,
        browserUserAgent ?? null,
        describeBrowserSession(browserUserAgent),
        expiresAt,
      ],
    );

    return {
      request: mapAuthQrLoginRequestRow(result.rows[0]),
      scanToken,
      browserToken,
    };
  }

  async function getQrLoginRequestStatus(
    requestId: string,
    browserToken: string,
  ): Promise<AuthQrLoginStatusResponse> {
    let row = await getQrLoginRequestById(requestId, browserToken);
    if (!row) {
      throw new AuthError('QR login request not found', 404, 'QR_LOGIN_REQUEST_NOT_FOUND');
    }

    row = await expireQrLoginRequestIfNeeded(row);
    return { request: mapAuthQrLoginRequestRow(row) };
  }

  async function resolveQrLoginRequest(
    scanToken: string,
    userId: string,
  ): Promise<AuthQrLoginResolveResponse> {
    return transaction(async (client) => {
      const db = { query: client.query.bind(client) as typeof query };
      let row = await getQrLoginRequestByScanToken(scanToken, db, true);
      if (!row) {
        throw new AuthError('QR login request not found', 404, 'QR_LOGIN_REQUEST_NOT_FOUND');
      }

      row = await expireQrLoginRequestIfNeeded(row, db);

      if (row.status === 'expired') {
        throw new AuthError('QR login request expired', 410, 'QR_LOGIN_REQUEST_EXPIRED');
      }

      if (row.status === 'rejected') {
        throw new AuthError('QR login request was rejected', 409, 'QR_LOGIN_REQUEST_REJECTED');
      }

      if (row.status === 'consumed') {
        throw new AuthError('QR login request was already used', 409, 'QR_LOGIN_REQUEST_CONSUMED');
      }

      if (row.resolver_user_id && row.resolver_user_id !== userId) {
        throw new AuthError(
          'QR login request is being confirmed from another account',
          409,
          'QR_LOGIN_REQUEST_CLAIMED',
        );
      }

      if (row.status === 'pending_scan') {
        const updated = await db.query<AuthQrLoginRequestRow>(
          `UPDATE auth_qr_login_requests
              SET status = 'pending_confirm',
                  resolver_user_id = $2,
                  scanned_at = COALESCE(scanned_at, NOW()),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING
              id,
              status,
              browser_ip_address,
              browser_user_agent,
              browser_label,
              approved_session_persistence,
              resolver_user_id,
              approved_by_user_id,
              scanned_at,
              approved_at,
              rejected_at,
              consumed_at,
              expires_at,
              created_at,
              updated_at`,
          [row.id, userId],
        );
        row = updated.rows[0] ?? row;
      }

      return {
        request: mapAuthQrLoginRequestRow(row),
        confirmation: {
          browserLabel: row.browser_label,
          requestedAt: row.created_at,
          expiresAt: row.expires_at,
        },
      };
    });
  }

  async function approveQrLoginRequest(
    scanToken: string,
    userId: string,
    sessionPersistence: AuthSessionPersistence,
  ): Promise<AuthQrLoginStatusResponse> {
    return transaction(async (client) => {
      const db = { query: client.query.bind(client) as typeof query };
      let row = await getQrLoginRequestByScanToken(scanToken, db, true);
      if (!row) {
        throw new AuthError('QR login request not found', 404, 'QR_LOGIN_REQUEST_NOT_FOUND');
      }

      row = await expireQrLoginRequestIfNeeded(row, db);

      if (row.status === 'expired') {
        throw new AuthError('QR login request expired', 410, 'QR_LOGIN_REQUEST_EXPIRED');
      }

      if (row.status === 'rejected') {
        throw new AuthError('QR login request was rejected', 409, 'QR_LOGIN_REQUEST_REJECTED');
      }

      if (row.status === 'consumed') {
        throw new AuthError('QR login request was already used', 409, 'QR_LOGIN_REQUEST_CONSUMED');
      }

      if (row.resolver_user_id && row.resolver_user_id !== userId) {
        throw new AuthError(
          'QR login request is being confirmed from another account',
          409,
          'QR_LOGIN_REQUEST_CLAIMED',
        );
      }

      if (row.status !== 'approved') {
        const updated = await db.query<AuthQrLoginRequestRow>(
          `UPDATE auth_qr_login_requests
              SET status = 'approved',
                  resolver_user_id = COALESCE(resolver_user_id, $2),
                  approved_by_user_id = $2,
                  approved_session_persistence = $3,
                  scanned_at = COALESCE(scanned_at, NOW()),
                  approved_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING
              id,
              status,
              browser_ip_address,
              browser_user_agent,
              browser_label,
              approved_session_persistence,
              resolver_user_id,
              approved_by_user_id,
              scanned_at,
              approved_at,
              rejected_at,
              consumed_at,
              expires_at,
              created_at,
              updated_at`,
          [row.id, userId, sessionPersistence],
        );
        row = updated.rows[0] ?? row;
      }

      return { request: mapAuthQrLoginRequestRow(row) };
    });
  }

  async function rejectQrLoginRequest(
    scanToken: string,
    userId: string,
  ): Promise<AuthQrLoginStatusResponse> {
    return transaction(async (client) => {
      const db = { query: client.query.bind(client) as typeof query };
      let row = await getQrLoginRequestByScanToken(scanToken, db, true);
      if (!row) {
        throw new AuthError('QR login request not found', 404, 'QR_LOGIN_REQUEST_NOT_FOUND');
      }

      row = await expireQrLoginRequestIfNeeded(row, db);

      if (row.status === 'expired') {
        throw new AuthError('QR login request expired', 410, 'QR_LOGIN_REQUEST_EXPIRED');
      }

      if (row.status === 'consumed') {
        throw new AuthError('QR login request was already used', 409, 'QR_LOGIN_REQUEST_CONSUMED');
      }

      if (row.status === 'approved') {
        throw new AuthError('QR login request was already approved', 409, 'QR_LOGIN_REQUEST_APPROVED');
      }

      if (row.resolver_user_id && row.resolver_user_id !== userId) {
        throw new AuthError(
          'QR login request is being confirmed from another account',
          409,
          'QR_LOGIN_REQUEST_CLAIMED',
        );
      }

      if (row.status !== 'rejected') {
        const updated = await db.query<AuthQrLoginRequestRow>(
          `UPDATE auth_qr_login_requests
              SET status = 'rejected',
                  resolver_user_id = COALESCE(resolver_user_id, $2),
                  scanned_at = COALESCE(scanned_at, NOW()),
                  rejected_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING
              id,
              status,
              browser_ip_address,
              browser_user_agent,
              browser_label,
              approved_session_persistence,
              resolver_user_id,
              approved_by_user_id,
              scanned_at,
              approved_at,
              rejected_at,
              consumed_at,
              expires_at,
              created_at,
              updated_at`,
          [row.id, userId],
        );
        row = updated.rows[0] ?? row;
      }

      return { request: mapAuthQrLoginRequestRow(row) };
    });
  }

  async function finalizeQrLoginRequest(
    requestId: string,
    browserToken: string,
    request: FastifyRequest,
  ): Promise<AuthServiceResult> {
    return transaction(async (client) => {
      const db = { query: client.query.bind(client) as typeof query };
      let row = await getQrLoginRequestById(requestId, browserToken, db, true);
      if (!row) {
        throw new AuthError('QR login request not found', 404, 'QR_LOGIN_REQUEST_NOT_FOUND');
      }

      row = await expireQrLoginRequestIfNeeded(row, db);

      if (row.status === 'expired') {
        throw new AuthError('QR login request expired', 410, 'QR_LOGIN_REQUEST_EXPIRED');
      }

      if (row.status === 'rejected') {
        throw new AuthError('QR login request was rejected', 409, 'QR_LOGIN_REQUEST_REJECTED');
      }

      if (row.status === 'consumed') {
        throw new AuthError('QR login request was already used', 409, 'QR_LOGIN_REQUEST_CONSUMED');
      }

      if (row.status !== 'approved' || !row.approved_by_user_id) {
        throw new AuthError('QR login request is not approved yet', 409, 'QR_LOGIN_REQUEST_NOT_READY');
      }

      const userRow = await getUserById(row.approved_by_user_id, db);
      if (!userRow) {
        throw new AuthError('User not found', 404, 'USER_NOT_FOUND');
      }

      const user = mapUserRow(userRow);
      const sessionPersistence = getSessionPersistence(
        row.approved_session_persistence ?? undefined,
      );
      await ensureConfiguredPlatformAdminForUser({ id: user.id, email: user.email });
      const { session, sessionToken } = await insertSession(
        user,
        {
          request,
          clientType: 'web',
          transport: 'cookie',
          sessionPersistence,
          metadata: {
            source: 'qr_login',
            qrLoginRequestId: row.id,
          },
        },
        db,
      );

      await db.query(
        `UPDATE auth_qr_login_requests
            SET status = 'consumed',
                consumed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [row.id],
      );

      return { user, session, sessionToken, sessionPersistence };
    });
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
    createQrLoginRequest,
    getQrLoginRequestStatus,
    resolveQrLoginRequest,
    approveQrLoginRequest,
    rejectQrLoginRequest,
    finalizeQrLoginRequest,
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
