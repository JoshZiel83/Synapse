import bcrypt from "bcryptjs"
import crypto from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import {
  AUTH_QR_LOGIN_REQUEST_TTL_SECONDS,
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_MAX_AGE_SECONDS,
  AUTH_SESSION_TOUCH_INTERVAL_SECONDS,
} from "@synapse/shared"
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
} from "@synapse/shared"
import {
  db,
  runBuilder,
  takeFirstOn,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import {
  disconnectSocketsForSession,
  disconnectSocketsForUser,
} from "../../infrastructure/websocket/auth-session-registry.js"
import {
  canUserAccessFileWorkspace,
  getFileAccessInfo,
  getFileUrlById,
} from "../files/service.js"
import { createGeneratedUserAvatarFile } from "../avatar/service.js"
import { ensureConfiguredPlatformAdminForUser } from "../platform/admin-service.js"
import { sql } from "kysely"

const SALT_ROUNDS = 10

interface UserRow {
  id: string
  email: string
  name: string
  avatar_file_id: string | null
  password_hash: string
  created_at: string | Date | null
  updated_at: string | Date | null
}

interface AuthenticatedSessionRow {
  session_id: string
  session_user_id: string
  session_client_type: AuthClientType | string
  session_transport: AuthTransport | string
  session_device_name: string | null
  session_platform: string | null
  session_created_at: string | Date | null
  session_updated_at: string | Date | null
  session_last_seen_at: string | Date | null
  session_expires_at: string | Date | null
  session_revoked_at: string | Date | null
  session_revoke_reason: string | null
  id: string
  email: string
  name: string
  avatar_file_id: string | null
  created_at: string | Date | null
  updated_at: string | Date | null
}

export interface SessionContextInput {
  request: FastifyRequest
  clientType?: AuthClientType
  transport?: AuthTransport
  sessionPersistence?: AuthSessionPersistence
  deviceName?: string
  platform?: string
}

export interface AuthenticatedRequestSession {
  user: User
  session: AuthSessionSummary
}

export interface AuthServiceResult {
  user: User
  session: AuthSessionSummary
  sessionToken: string
  sessionPersistence: AuthSessionPersistence
}

type DatabaseExecutor = Executor

interface AuthQrLoginRequestRow {
  id: string
  status: AuthQrLoginStatus | string
  browser_ip_address: string | null
  browser_user_agent: string | null
  browser_label: string
  approved_session_persistence: AuthSessionPersistence | string | null
  resolver_user_id: string | null
  approved_by_user_id: string | null
  scanned_at: string | Date | null
  approved_at: string | Date | null
  rejected_at: string | Date | null
  consumed_at: string | Date | null
  expires_at: string | Date | null
  created_at: string | Date | null
  updated_at: string | Date | null
}

function toIsoString(value: string | Date | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return new Date(0).toISOString()
}

function toOptionalIsoString(
  value: string | Date | null | undefined
): string | undefined {
  if (value == null) return undefined
  return toIsoString(value)
}

function mapUserRow(
  row: Pick<
    UserRow,
    "id" | "email" | "name" | "avatar_file_id" | "created_at" | "updated_at"
  >
): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_file_id
      ? getFileUrlById(row.avatar_file_id)
      : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function mapAuthenticatedSessionRow(
  row: AuthenticatedSessionRow,
  current = true
): AuthSessionSummary {
  return {
    id: row.session_id,
    clientType: row.session_client_type as AuthClientType,
    transport: row.session_transport as AuthTransport,
    deviceName: row.session_device_name ?? undefined,
    platform: row.session_platform ?? undefined,
    current,
    createdAt: toIsoString(row.session_created_at),
    lastSeenAt: toIsoString(row.session_last_seen_at),
    expiresAt: toIsoString(row.session_expires_at),
    revokedAt: toOptionalIsoString(row.session_revoked_at),
  }
}

function sanitizeOptionalText(
  input: unknown,
  maxLength: number
): string | undefined {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLength)
}

function getClientType(input?: AuthClientType): AuthClientType {
  return input || "web"
}

function getTransport(input?: AuthTransport): AuthTransport {
  return input || "cookie"
}

function getSessionPersistence(
  input?: AuthSessionPersistence
): AuthSessionPersistence {
  return input || "persistent"
}

function getTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

function generateSessionToken(): string {
  return crypto.randomBytes(48).toString("base64url")
}

function getTokenHint(token: string): string {
  return token.slice(0, 8)
}

function extractIpAddress(request: FastifyRequest): string | undefined {
  const forwarded = request.headers["x-forwarded-for"]
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const ip = firstForwarded?.split(",")[0]?.trim() || request.ip
  return sanitizeOptionalText(ip, 120)
}

function extractUserAgent(request: FastifyRequest): string | undefined {
  const userAgent = Array.isArray(request.headers["user-agent"])
    ? request.headers["user-agent"][0]
    : request.headers["user-agent"]
  return sanitizeOptionalText(userAgent, 1000)
}

function getSessionExpiryDate() {
  return new Date(Date.now() + AUTH_SESSION_MAX_AGE_SECONDS * 1000)
}

function getQrLoginExpiryDate() {
  return new Date(Date.now() + AUTH_QR_LOGIN_REQUEST_TTL_SECONDS * 1000)
}

function getDatabaseExecutor(executor?: DatabaseExecutor): DatabaseExecutor {
  return executor ?? db
}

const userSelection = [
  "id",
  "email",
  "name",
  "avatar_file_id",
  "password_hash",
  "created_at",
  "updated_at",
] as const

const authSessionReturning = [
  "id",
  "client_type",
  "transport",
  "device_name",
  "platform",
  "created_at",
  "last_seen_at",
  "expires_at",
  "revoked_at",
] as const

const authQrLoginRequestSelection = [
  "id",
  "status",
  "browser_ip_address",
  "browser_user_agent",
  "browser_label",
  "approved_session_persistence",
  "resolver_user_id",
  "approved_by_user_id",
  "scanned_at",
  "approved_at",
  "rejected_at",
  "consumed_at",
  "expires_at",
  "created_at",
  "updated_at",
] as const

function getBrowserName(userAgent?: string) {
  const value = userAgent?.toLowerCase() ?? ""

  if (value.includes("edg/")) return "Edge"
  if (value.includes("opr/") || value.includes("opera")) return "Opera"
  if (value.includes("firefox/") || value.includes("fxios/")) return "Firefox"
  if (value.includes("chrome/") || value.includes("crios/")) return "Chrome"
  if (
    value.includes("safari/") &&
    !value.includes("chrome/") &&
    !value.includes("crios/")
  ) {
    return "Safari"
  }

  return undefined
}

function getOperatingSystemName(userAgent?: string) {
  const value = userAgent?.toLowerCase() ?? ""

  if (value.includes("windows")) return "Windows"
  if (
    value.includes("iphone") ||
    value.includes("ipad") ||
    value.includes("ipod")
  )
    return "iOS"
  if (value.includes("android")) return "Android"
  if (value.includes("mac os x") || value.includes("macintosh")) return "macOS"
  if (value.includes("linux")) return "Linux"

  return undefined
}

function describeBrowserSession(userAgent?: string) {
  const browser = getBrowserName(userAgent)
  const operatingSystem = getOperatingSystemName(userAgent)

  if (browser && operatingSystem) {
    return `${browser} on ${operatingSystem}`
  }

  return browser || operatingSystem || "This browser"
}

function mapAuthQrLoginRequestRow(
  row: AuthQrLoginRequestRow
): AuthQrLoginRequestSummary {
  return {
    id: row.id,
    status: row.status as AuthQrLoginStatus,
    browserLabel: row.browser_label,
    approvedSessionPersistence:
      (row.approved_session_persistence as AuthSessionPersistence | null) ??
      undefined,
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
    scannedAt: toOptionalIsoString(row.scanned_at),
    approvedAt: toOptionalIsoString(row.approved_at),
    rejectedAt: toOptionalIsoString(row.rejected_at),
    consumedAt: toOptionalIsoString(row.consumed_at),
  }
}

function isExpiredTimestamp(timestamp: string | Date | null) {
  if (!timestamp) return false
  const expiresAt = new Date(timestamp).getTime()
  return Number.isFinite(expiresAt) && expiresAt <= Date.now()
}

function isQrLoginExpiredStatus(status: AuthQrLoginStatus | string) {
  return status !== "rejected" && status !== "expired" && status !== "consumed"
}

async function expireQrLoginRequestIfNeeded(
  row: AuthQrLoginRequestRow,
  executor?: DatabaseExecutor
): Promise<AuthQrLoginRequestRow> {
  if (
    !isQrLoginExpiredStatus(row.status) ||
    !isExpiredTimestamp(row.expires_at)
  ) {
    return row
  }

  const runner = getDatabaseExecutor(executor)
  const updated = await takeFirstOn<AuthQrLoginRequestRow>(
    runner,
    db
      .updateTable("auth_qr_login_requests")
      .set({
        status: "expired",
        updated_at: sql`NOW()`,
      })
      .where("id", "=", row.id)
      .where("status", "<>", "expired")
      .where("status", "<>", "rejected")
      .where("status", "<>", "consumed")
      .returning(authQrLoginRequestSelection)
  )

  return updated ?? { ...row, status: "expired" }
}

async function insertSession(
  user: User,
  input: SessionContextInput,
  executor?: DatabaseExecutor
): Promise<{
  session: AuthSessionSummary
  sessionToken: string
  sessionPersistence: AuthSessionPersistence
}> {
  const runner = getDatabaseExecutor(executor)
  const sessionToken = generateSessionToken()
  const tokenHash = getTokenHash(sessionToken)
  const expiresAt = getSessionExpiryDate().toISOString()
  const clientType = getClientType(input.clientType)
  const transport = getTransport(input.transport)
  const sessionPersistence = getSessionPersistence(input.sessionPersistence)
  const deviceName = sanitizeOptionalText(input.deviceName, 255) ?? null
  const platform = sanitizeOptionalText(input.platform, 120) ?? null
  const ipAddress = extractIpAddress(input.request) ?? null
  const userAgent = extractUserAgent(input.request) ?? null

  const row = await takeFirstOn<{
    id: string
    client_type: AuthClientType
    transport: AuthTransport
    device_name: string | null
    platform: string | null
    created_at: string
    last_seen_at: string
    expires_at: string
    revoked_at: string | null
  }>(
    runner,
    db
      .insertInto("auth_sessions")
      .values({
        user_id: user.id,
        client_type: clientType,
        transport,
        device_name: deviceName,
        platform,
        token_hash: tokenHash,
        token_hint: getTokenHint(sessionToken),
        ip_address: ipAddress,
        user_agent: userAgent,
        expires_at: expiresAt,
      })
      .returning(authSessionReturning)
  )
  if (!row) {
    throw new Error("Failed to create auth session")
  }

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
  }
}

async function getUserByEmail(
  email: string,
  executor?: DatabaseExecutor
): Promise<UserRow | null> {
  const runner = getDatabaseExecutor(executor)
  return takeFirstOn<UserRow>(
    runner,
    db
      .selectFrom("users")
      .select(userSelection)
      .where("email", "=", email.toLowerCase())
  )
}

async function getUserById(
  userId: string,
  executor?: DatabaseExecutor
): Promise<UserRow | null> {
  const runner = getDatabaseExecutor(executor)
  return takeFirstOn<UserRow>(
    runner,
    db.selectFrom("users").select(userSelection).where("id", "=", userId)
  )
}

async function touchSessionIfNeeded(
  row: AuthenticatedSessionRow,
  request: FastifyRequest
) {
  if (!row.session_last_seen_at) return
  const lastSeenAtMs = new Date(row.session_last_seen_at).getTime()
  if (!Number.isFinite(lastSeenAtMs)) return
  if (Date.now() - lastSeenAtMs < AUTH_SESSION_TOUCH_INTERVAL_SECONDS * 1000)
    return

  await db
    .updateTable("auth_sessions")
    .set({
      last_seen_at: sql`NOW()`,
      updated_at: sql`NOW()`,
      ip_address: extractIpAddress(request) ?? null,
      user_agent: extractUserAgent(request) ?? null,
    })
    .where("id", "=", row.session_id)
    .execute()
}

async function findAuthenticatedSession(
  token: string
): Promise<AuthenticatedSessionRow | null> {
  const tokenHash = getTokenHash(token)

  return ((await db
    .selectFrom("auth_sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .select([
      "s.id as session_id",
      "s.user_id as session_user_id",
      "s.client_type as session_client_type",
      "s.transport as session_transport",
      "s.device_name as session_device_name",
      "s.platform as session_platform",
      "s.created_at as session_created_at",
      "s.updated_at as session_updated_at",
      "s.last_seen_at as session_last_seen_at",
      "s.expires_at as session_expires_at",
      "s.revoked_at as session_revoked_at",
      "s.revoke_reason as session_revoke_reason",
      "u.id",
      "u.email",
      "u.name",
      "u.avatar_file_id",
      "u.created_at",
      "u.updated_at",
    ])
    .where("s.token_hash", "=", tokenHash)
    .where("s.revoked_at", "is", null)
    .where(sql<boolean>`s.expires_at > NOW()`)
    .limit(1)
    .executeTakeFirst()) ?? null) as AuthenticatedSessionRow | null
}

async function getQrLoginRequestById(
  requestId: string,
  browserToken: string,
  executor?: DatabaseExecutor,
  forUpdate = false
): Promise<AuthQrLoginRequestRow | null> {
  const runner = getDatabaseExecutor(executor)
  let statement = db
    .selectFrom("auth_qr_login_requests")
    .select(authQrLoginRequestSelection)
    .where("id", "=", requestId)
    .where("browser_token_hash", "=", getTokenHash(browserToken))
  if (forUpdate) {
    statement = statement.forUpdate()
  }

  return takeFirstOn<AuthQrLoginRequestRow>(runner, statement)
}

async function getQrLoginRequestByScanToken(
  scanToken: string,
  executor?: DatabaseExecutor,
  forUpdate = false
): Promise<AuthQrLoginRequestRow | null> {
  const runner = getDatabaseExecutor(executor)
  let statement = db
    .selectFrom("auth_qr_login_requests")
    .select(authQrLoginRequestSelection)
    .where("scan_token_hash", "=", getTokenHash(scanToken))
  if (forUpdate) {
    statement = statement.forUpdate()
  }

  return takeFirstOn<AuthQrLoginRequestRow>(runner, statement)
}

export function extractSessionTokenFromRequest(
  request: FastifyRequest
): string | null {
  const authHeader = request.headers.authorization
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim()
    if (token) return token
  }

  const cookieToken = request.cookies?.[AUTH_SESSION_COOKIE_NAME]
  if (typeof cookieToken === "string" && cookieToken.trim().length > 0) {
    return cookieToken.trim()
  }

  return null
}

export async function authenticateSessionToken(
  token: string,
  request?: FastifyRequest
): Promise<AuthenticatedRequestSession | null> {
  const row = await findAuthenticatedSession(token)
  if (!row) return null

  if (request) {
    await touchSessionIfNeeded(row, request)
  }

  return {
    user: mapUserRow(row),
    session: mapAuthenticatedSessionRow(row),
  }
}

export async function authenticateRequestSession(
  request: FastifyRequest
): Promise<AuthenticatedRequestSession | null> {
  const token = extractSessionTokenFromRequest(request)
  if (!token) return null
  return authenticateSessionToken(token, request)
}

async function revokeSessionById(sessionId: string, reason: string) {
  await db
    .updateTable("auth_sessions")
    .set({
      revoked_at: sql`NOW()`,
      revoke_reason: reason,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", sessionId)
    .where("revoked_at", "is", null)
    .execute()
}

async function revokeAllSessionsForUser(
  userId: string,
  reason: string,
  exceptSessionId?: string
) {
  let statement = db
    .updateTable("auth_sessions")
    .set({
      revoked_at: sql`NOW()`,
      revoke_reason: reason,
      updated_at: sql`NOW()`,
    })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)

  if (exceptSessionId) {
    statement = statement.where("id", "<>", exceptSessionId)
  }

  await statement.execute()
}

async function disconnectSocketsBestEffort(
  action: Promise<unknown>,
  context: string
) {
  try {
    await action
  } catch (error) {
    console.error(
      `[auth] Failed to disconnect websocket sessions after ${context}:`,
      error
    )
  }
}

export function createAuthService(_app: FastifyInstance) {
  async function register(
    email: string,
    password: string,
    name: string,
    sessionContext: SessionContextInput
  ): Promise<AuthServiceResult> {
    const normalizedEmail = email.trim().toLowerCase()
    const existing = await getUserByEmail(normalizedEmail)
    if (existing) {
      throw new AuthError(
        "A user with this email already exists",
        409,
        "EMAIL_TAKEN"
      )
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    const userRow = await withDbTransaction(async (trx) => {
      const row = await trx
        .insertInto("users")
        .values({
          email: normalizedEmail,
          password_hash: passwordHash,
          name: name.trim(),
        })
        .returning(userSelection)
        .executeTakeFirst()
      if (!row) {
        throw new Error("Failed to create user")
      }

      const avatarFile = await createGeneratedUserAvatarFile(trx, {
        userId: row.id,
        name: row.name,
        email: row.email,
      })

      const updatedUser = await trx
        .updateTable("users")
        .set({
          avatar_file_id: avatarFile.fileId,
          updated_at: sql`NOW()`,
        })
        .where("id", "=", row.id)
        .returning(userSelection)
        .executeTakeFirst()
      if (!updatedUser) {
        throw new Error("Failed to update user avatar")
      }

      return updatedUser
    })

    const user = mapUserRow(userRow)
    await ensureConfiguredPlatformAdminForUser({
      id: user.id,
      email: user.email,
    })
    const { session, sessionToken, sessionPersistence } = await insertSession(
      user,
      sessionContext
    )

    return { user, session, sessionToken, sessionPersistence }
  }

  async function login(
    email: string,
    password: string,
    sessionContext: SessionContextInput
  ): Promise<AuthServiceResult> {
    const row = await getUserByEmail(email.trim().toLowerCase())

    if (!row) {
      throw new AuthError(
        "Invalid email or password",
        401,
        "INVALID_CREDENTIALS"
      )
    }

    const valid = await bcrypt.compare(password, row.password_hash)
    if (!valid) {
      throw new AuthError(
        "Invalid email or password",
        401,
        "INVALID_CREDENTIALS"
      )
    }

    const user = mapUserRow(row)
    await ensureConfiguredPlatformAdminForUser({
      id: user.id,
      email: user.email,
    })
    const { session, sessionToken, sessionPersistence } = await insertSession(
      user,
      sessionContext
    )

    return { user, session, sessionToken, sessionPersistence }
  }

  async function createQrLoginRequest(
    request: FastifyRequest
  ): Promise<AuthQrLoginCreateResponse> {
    const scanToken = generateSessionToken()
    const browserToken = generateSessionToken()
    const browserUserAgent = extractUserAgent(request)
    const expiresAt = getQrLoginExpiryDate().toISOString()
    const row = await db
      .insertInto("auth_qr_login_requests")
      .values({
        scan_token_hash: getTokenHash(scanToken),
        browser_token_hash: getTokenHash(browserToken),
        status: "pending_scan",
        browser_ip_address: extractIpAddress(request) ?? null,
        browser_user_agent: browserUserAgent ?? null,
        browser_label: describeBrowserSession(browserUserAgent),
        expires_at: expiresAt,
      })
      .returning(authQrLoginRequestSelection)
      .executeTakeFirst()

    if (!row) {
      throw new Error("Failed to create QR login request")
    }

    return {
      request: mapAuthQrLoginRequestRow(row),
      scanToken,
      browserToken,
    }
  }

  async function getQrLoginRequestStatus(
    requestId: string,
    browserToken: string
  ): Promise<AuthQrLoginStatusResponse> {
    let row = await getQrLoginRequestById(requestId, browserToken)
    if (!row) {
      throw new AuthError(
        "QR login request not found",
        404,
        "QR_LOGIN_REQUEST_NOT_FOUND"
      )
    }

    row = await expireQrLoginRequestIfNeeded(row)
    return { request: mapAuthQrLoginRequestRow(row) }
  }

  async function resolveQrLoginRequest(
    scanToken: string,
    userId: string
  ): Promise<AuthQrLoginResolveResponse> {
    return withDbTransaction(async (trx) => {
      const runner = trx
      let row = await getQrLoginRequestByScanToken(scanToken, runner, true)
      if (!row) {
        throw new AuthError(
          "QR login request not found",
          404,
          "QR_LOGIN_REQUEST_NOT_FOUND"
        )
      }

      row = await expireQrLoginRequestIfNeeded(row, runner)

      if (row.status === "expired") {
        throw new AuthError(
          "QR login request expired",
          410,
          "QR_LOGIN_REQUEST_EXPIRED"
        )
      }

      if (row.status === "rejected") {
        throw new AuthError(
          "QR login request was rejected",
          409,
          "QR_LOGIN_REQUEST_REJECTED"
        )
      }

      if (row.status === "consumed") {
        throw new AuthError(
          "QR login request was already used",
          409,
          "QR_LOGIN_REQUEST_CONSUMED"
        )
      }

      if (row.resolver_user_id && row.resolver_user_id !== userId) {
        throw new AuthError(
          "QR login request is being confirmed from another account",
          409,
          "QR_LOGIN_REQUEST_CLAIMED"
        )
      }

      if (row.status === "pending_scan") {
        row =
          (await takeFirstOn<AuthQrLoginRequestRow>(
            runner,
            db
              .updateTable("auth_qr_login_requests")
              .set({
                status: "pending_confirm",
                resolver_user_id: userId,
                scanned_at: sql`COALESCE(scanned_at, NOW())`,
                updated_at: sql`NOW()`,
              })
              .where("id", "=", row.id)
              .returning(authQrLoginRequestSelection)
          )) ?? row
      }

      return {
        request: mapAuthQrLoginRequestRow(row),
        confirmation: {
          browserLabel: row.browser_label,
          requestedAt: toIsoString(row.created_at),
          expiresAt: toIsoString(row.expires_at),
        },
      }
    })
  }

  async function approveQrLoginRequest(
    scanToken: string,
    userId: string,
    sessionPersistence: AuthSessionPersistence
  ): Promise<AuthQrLoginStatusResponse> {
    return withDbTransaction(async (trx) => {
      const runner = trx
      let row = await getQrLoginRequestByScanToken(scanToken, runner, true)
      if (!row) {
        throw new AuthError(
          "QR login request not found",
          404,
          "QR_LOGIN_REQUEST_NOT_FOUND"
        )
      }

      row = await expireQrLoginRequestIfNeeded(row, runner)

      if (row.status === "expired") {
        throw new AuthError(
          "QR login request expired",
          410,
          "QR_LOGIN_REQUEST_EXPIRED"
        )
      }

      if (row.status === "rejected") {
        throw new AuthError(
          "QR login request was rejected",
          409,
          "QR_LOGIN_REQUEST_REJECTED"
        )
      }

      if (row.status === "consumed") {
        throw new AuthError(
          "QR login request was already used",
          409,
          "QR_LOGIN_REQUEST_CONSUMED"
        )
      }

      if (row.resolver_user_id && row.resolver_user_id !== userId) {
        throw new AuthError(
          "QR login request is being confirmed from another account",
          409,
          "QR_LOGIN_REQUEST_CLAIMED"
        )
      }

      if (row.status !== "approved") {
        row =
          (await takeFirstOn<AuthQrLoginRequestRow>(
            runner,
            db
              .updateTable("auth_qr_login_requests")
              .set({
                status: "approved",
                resolver_user_id: sql`COALESCE(resolver_user_id, ${userId})`,
                approved_by_user_id: userId,
                approved_session_persistence: sessionPersistence,
                scanned_at: sql`COALESCE(scanned_at, NOW())`,
                approved_at: sql`NOW()`,
                updated_at: sql`NOW()`,
              })
              .where("id", "=", row.id)
              .returning(authQrLoginRequestSelection)
          )) ?? row
      }

      return { request: mapAuthQrLoginRequestRow(row) }
    })
  }

  async function rejectQrLoginRequest(
    scanToken: string,
    userId: string
  ): Promise<AuthQrLoginStatusResponse> {
    return withDbTransaction(async (trx) => {
      const runner = trx
      let row = await getQrLoginRequestByScanToken(scanToken, runner, true)
      if (!row) {
        throw new AuthError(
          "QR login request not found",
          404,
          "QR_LOGIN_REQUEST_NOT_FOUND"
        )
      }

      row = await expireQrLoginRequestIfNeeded(row, runner)

      if (row.status === "expired") {
        throw new AuthError(
          "QR login request expired",
          410,
          "QR_LOGIN_REQUEST_EXPIRED"
        )
      }

      if (row.status === "consumed") {
        throw new AuthError(
          "QR login request was already used",
          409,
          "QR_LOGIN_REQUEST_CONSUMED"
        )
      }

      if (row.status === "approved") {
        throw new AuthError(
          "QR login request was already approved",
          409,
          "QR_LOGIN_REQUEST_APPROVED"
        )
      }

      if (row.resolver_user_id && row.resolver_user_id !== userId) {
        throw new AuthError(
          "QR login request is being confirmed from another account",
          409,
          "QR_LOGIN_REQUEST_CLAIMED"
        )
      }

      if (row.status !== "rejected") {
        row =
          (await takeFirstOn<AuthQrLoginRequestRow>(
            runner,
            db
              .updateTable("auth_qr_login_requests")
              .set({
                status: "rejected",
                resolver_user_id: sql`COALESCE(resolver_user_id, ${userId})`,
                scanned_at: sql`COALESCE(scanned_at, NOW())`,
                rejected_at: sql`NOW()`,
                updated_at: sql`NOW()`,
              })
              .where("id", "=", row.id)
              .returning(authQrLoginRequestSelection)
          )) ?? row
      }

      return { request: mapAuthQrLoginRequestRow(row) }
    })
  }

  async function finalizeQrLoginRequest(
    requestId: string,
    browserToken: string,
    request: FastifyRequest
  ): Promise<AuthServiceResult> {
    return withDbTransaction(async (trx) => {
      const runner = trx
      let row = await getQrLoginRequestById(
        requestId,
        browserToken,
        runner,
        true
      )
      if (!row) {
        throw new AuthError(
          "QR login request not found",
          404,
          "QR_LOGIN_REQUEST_NOT_FOUND"
        )
      }

      row = await expireQrLoginRequestIfNeeded(row, runner)

      if (row.status === "expired") {
        throw new AuthError(
          "QR login request expired",
          410,
          "QR_LOGIN_REQUEST_EXPIRED"
        )
      }

      if (row.status === "rejected") {
        throw new AuthError(
          "QR login request was rejected",
          409,
          "QR_LOGIN_REQUEST_REJECTED"
        )
      }

      if (row.status === "consumed") {
        throw new AuthError(
          "QR login request was already used",
          409,
          "QR_LOGIN_REQUEST_CONSUMED"
        )
      }

      if (row.status !== "approved" || !row.approved_by_user_id) {
        throw new AuthError(
          "QR login request is not approved yet",
          409,
          "QR_LOGIN_REQUEST_NOT_READY"
        )
      }

      const userRow = await getUserById(row.approved_by_user_id, runner)
      if (!userRow) {
        throw new AuthError("User not found", 404, "USER_NOT_FOUND")
      }

      const user = mapUserRow(userRow)
      const sessionPersistence = getSessionPersistence(
        row.approved_session_persistence
          ? (row.approved_session_persistence as AuthSessionPersistence)
          : undefined
      )
      await ensureConfiguredPlatformAdminForUser({
        id: user.id,
        email: user.email,
      })
      const { session, sessionToken } = await insertSession(
        user,
        {
          request,
          clientType: "web",
          transport: "cookie",
          sessionPersistence,
        },
        runner
      )

      await runBuilder(
        runner,
        db
          .updateTable("auth_qr_login_requests")
          .set({
            status: "consumed",
            consumed_at: sql`NOW()`,
            updated_at: sql`NOW()`,
          })
          .where("id", "=", row.id)
      )

      return { user, session, sessionToken, sessionPersistence }
    })
  }

  async function getProfile(userId: string): Promise<User> {
    const row = await getUserById(userId)
    if (!row) {
      throw new AuthError("User not found", 404, "USER_NOT_FOUND")
    }

    return mapUserRow(row)
  }

  async function updateProfile(
    userId: string,
    input: { name?: string; avatarFileId?: string | null }
  ): Promise<User> {
    const current = await getUserById(userId)
    if (!current) {
      throw new AuthError("User not found", 404, "USER_NOT_FOUND")
    }

    const nextName = input.name === undefined ? current.name : input.name.trim()
    const nextAvatarFileId =
      input.avatarFileId === undefined
        ? (current.avatar_file_id ?? null)
        : input.avatarFileId

    if (nextAvatarFileId) {
      const fileInfo = await getFileAccessInfo(nextAvatarFileId)
      if (!fileInfo) {
        throw new AuthError(
          "Avatar file not found",
          400,
          "AVATAR_FILE_NOT_FOUND"
        )
      }

      const canAccess = await canUserAccessFileWorkspace(
        fileInfo.workspaceId ?? null,
        userId
      )
      if (!canAccess) {
        throw new AuthError(
          "Avatar file is not accessible",
          403,
          "AVATAR_FILE_FORBIDDEN"
        )
      }
    }

    const row = await db
      .updateTable("users")
      .set({
        name: nextName,
        avatar_file_id: nextAvatarFileId ?? null,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", userId)
      .returning(userSelection)
      .executeTakeFirst()

    if (!row) {
      throw new AuthError("User not found", 404, "USER_NOT_FOUND")
    }

    return mapUserRow(row)
  }

  async function getCurrentSession(
    request: FastifyRequest
  ): Promise<AuthenticatedRequestSession> {
    const authenticated = await authenticateRequestSession(request)
    if (!authenticated) {
      throw new AuthError("Authentication required", 401, "UNAUTHENTICATED")
    }

    return authenticated
  }

  async function listSessions(
    userId: string,
    currentSessionId?: string
  ): Promise<AuthSessionSummary[]> {
    const rows = await db
      .selectFrom("auth_sessions")
      .select(authSessionReturning)
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute()

    return rows.map((row) => ({
      id: row.id,
      clientType: row.client_type as AuthClientType,
      transport: row.transport as AuthTransport,
      deviceName: row.device_name ?? undefined,
      platform: row.platform ?? undefined,
      current: row.id === currentSessionId,
      createdAt: toIsoString(row.created_at),
      lastSeenAt: toIsoString(row.last_seen_at),
      expiresAt: toIsoString(row.expires_at),
      revokedAt: toOptionalIsoString(row.revoked_at),
    }))
  }

  async function logoutCurrentSession(sessionId: string) {
    await revokeSessionById(sessionId, "logout")
    await disconnectSocketsBestEffort(
      disconnectSocketsForSession(sessionId, "Session logged out"),
      `logout of session ${sessionId}`
    )
  }

  async function logoutAllSessions(userId: string, exceptSessionId?: string) {
    await revokeAllSessionsForUser(userId, "logout_all", exceptSessionId)
    await disconnectSocketsBestEffort(
      disconnectSocketsForUser(
        userId,
        "All sessions were logged out",
        exceptSessionId
      ),
      `logout-all for user ${userId}`
    )
  }

  async function revokeSessionForUser(userId: string, sessionId: string) {
    const row = await db
      .selectFrom("auth_sessions")
      .select("id")
      .where("id", "=", sessionId)
      .where("user_id", "=", userId)
      .limit(1)
      .executeTakeFirst()

    if (!row) {
      throw new AuthError("Session not found", 404, "SESSION_NOT_FOUND")
    }

    await revokeSessionById(sessionId, "revoked_by_user")
    await disconnectSocketsBestEffort(
      disconnectSocketsForSession(sessionId, "Session revoked"),
      `revocation of session ${sessionId}`
    )
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
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message)
    this.name = "AuthError"
  }
}
