import type { FastifyRequest } from "fastify"
import { Headers as UndiciHeaders } from "undici"
import { fromNodeHeaders } from "better-auth/node"
import type { User } from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import {
  canUserAccessFileWorkspace,
  getFileAccessInfo,
  getFileUrlById,
} from "../files/service.js"
import { sql } from "kysely"
import { auth } from "./better-auth.js"

/**
 * Auth service — Better Auth edition.
 *
 * Better Auth owns the user/account/session lifecycle (sign-up, sign-in,
 * sign-out, session issue/revoke, OAuth, device flow); those routes are served
 * by the mounted BA handler. This module keeps only:
 *   - profile read/update (`getProfile`/`updateProfile`) backing the custom
 *     GET/PUT /api/v1/auth/me endpoints, and
 *   - the request/header/token authentication helpers the Fastify middleware
 *     and WebSocket layers call to resolve a session into `{ user, session }`.
 *
 * All three auth helpers funnel through `auth.api.getSession`, so the only
 * trusted source of truth is Better Auth's (signed) session cookie or bearer
 * token — business code never parses the cookie by name (its production name
 * carries a `__Secure-` prefix).
 */

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

type UserRow = {
  id: string
  email: string
  name: string
  avatar_file_id: string | null
  created_at: string | Date | null
  updated_at: string | Date | null
}

const userSelection = [
  "id",
  "email",
  "name",
  "avatar_file_id",
  "created_at",
  "updated_at",
] as const

function toIsoString(value: string | Date | null | undefined): string {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return new Date(0).toISOString()
}

function mapUserRow(row: UserRow): User {
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

async function getUserById(userId: string): Promise<UserRow | null> {
  const row = await db
    .selectFrom("users")
    .select(userSelection)
    .where("id", "=", userId)
    .executeTakeFirst()
  return (row as UserRow | undefined) ?? null
}

export async function getProfile(userId: string): Promise<User> {
  const row = await getUserById(userId)
  if (!row) {
    throw new AuthError("User not found", 404, "USER_NOT_FOUND")
  }
  return mapUserRow(row)
}

export async function updateProfile(
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
      throw new AuthError("Avatar file not found", 400, "AVATAR_FILE_NOT_FOUND")
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
  return mapUserRow(row as UserRow)
}

/**
 * The minimal authenticated-session shape the middleware + WS layers consume:
 * `{ user: { id, email }, session: { id } }`. Preserved verbatim from the legacy
 * service so its downstream consumers (request.user / client.sessionId) keep
 * working unchanged.
 */
export interface AuthenticatedRequestSession {
  user: { id: string; email: string }
  session: { id: string }
}

function toAuthenticated(
  result: {
    user: { id: string; email: string }
    session: { id: string }
  } | null
): AuthenticatedRequestSession | null {
  if (!result?.user?.id || !result.session?.id) return null
  return {
    user: { id: result.user.id, email: result.user.email },
    session: { id: result.session.id },
  }
}

/**
 * Soft-delete guard (design §8.4): Better Auth's getSession/findUserById do NOT
 * filter users.deleted_at, so a session minted before account closure (or via a
 * residual device_code) could still resolve. Reject any session whose user is
 * soft-deleted, treating it as unauthenticated.
 */
async function rejectIfUserDeleted(
  authed: AuthenticatedRequestSession | null
): Promise<AuthenticatedRequestSession | null> {
  if (!authed) return null
  const live = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", authed.user.id)
    .where("deleted_at", "is", null)
    .executeTakeFirst()
  return live ? authed : null
}

/**
 * Resolve a session from a set of (Node) request headers — the cookie-only
 * path. Used by the Fastify middleware (HTTP) and by the WebSocket/ASR layers
 * when the client relies on the signed session cookie carried on the upgrade
 * request (web / Expo web).
 */
export async function authenticateSessionFromHeaders(
  headers: NodeJS.Dict<string | string[]>
): Promise<AuthenticatedRequestSession | null> {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(headers),
  })
  return rejectIfUserDeleted(toAuthenticated(result))
}

/**
 * Resolve a session from a raw bearer token — the token path. Used by native
 * mobile clients that carry the Better Auth session token in an app-level WS
 * auth frame (no cookie). Requires the `bearer()` plugin, which turns
 * `Authorization: Bearer <token>` into a session lookup.
 */
export async function authenticateSessionToken(
  token: string
): Promise<AuthenticatedRequestSession | null> {
  const headers = new UndiciHeaders({ authorization: `Bearer ${token}` })
  const result = await auth.api.getSession({
    headers: headers as unknown as Headers,
  })
  return rejectIfUserDeleted(toAuthenticated(result))
}

/**
 * Resolve the session for an incoming Fastify request from its headers.
 */
export async function authenticateRequestSession(
  request: FastifyRequest
): Promise<AuthenticatedRequestSession | null> {
  return authenticateSessionFromHeaders(request.headers)
}
