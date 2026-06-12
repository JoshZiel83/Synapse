// auth/repo.ts — DB-touching helpers for the auth module.
//
// The only auth file permitted to import the db client (guard r8). Owns the
// users-table reads/writes backing the custom /auth/me profile endpoints + the
// soft-delete session guard, and the OAuth `verification` cleanup delete.
// service.ts / index.ts hold the business logic and call these; they no longer
// import the db client. round-6 P1-6. Records keep Date columns (createdAt /
// updatedAt) — the presenter (presentUser) serializes for the wire.

import { db } from "../../infrastructure/database/kysely.js"
import type { UserRow } from "./presenter.js"
import { createGeneratedUserAvatarFile } from "../avatar/service.js"

const userSelection = [
  "id",
  "email",
  "name",
  "avatarFileId",
  "createdAt",
  "updatedAt",
] as const

/** A user's profile row by id (null if absent). */
export async function selectUserById(userId: string): Promise<UserRow | null> {
  const row = await db
    .selectFrom("users")
    .select(userSelection)
    .where("id", "=", userId)
    .executeTakeFirst()
  return (row as UserRow | undefined) ?? null
}

/** Update a user's name/avatar and return the updated profile row (null if absent). */
export async function updateUserProfileRow(
  userId: string,
  next: { name: string; avatarFileId: string | null }
): Promise<UserRow | null> {
  const row = await db
    .updateTable("users")
    .set({ name: next.name, avatarFileId: next.avatarFileId })
    .where("id", "=", userId)
    .returning(userSelection)
    .executeTakeFirst()
  return (row as UserRow | undefined) ?? null
}

/** True iff the user exists and is not soft-deleted (design §8.4 session guard). */
export async function isUserLive(userId: string): Promise<boolean> {
  const live = await db
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  return Boolean(live)
}

/** Delete the OAuth `verification` row for a state (early-error cleanup). */
export async function deleteVerificationByIdentifier(
  identifier: string
): Promise<void> {
  await db
    .deleteFrom("verification")
    .where("identifier", "=", identifier)
    .execute()
}

/**
 * Backfill a generated pixel-art avatar for a freshly-created user, if they have
 * none. Owns the read (current avatar) + the generate + the write — the
 * better-auth user.create.after hook calls this so the BA config holds no db.
 */
export async function backfillGeneratedUserAvatar(user: {
  id: string
  name: string
  email: string
}): Promise<void> {
  const existing = await db
    .selectFrom("users")
    .select("avatarFileId")
    .where("id", "=", user.id)
    .executeTakeFirst()
  if (existing?.avatarFileId) return
  const avatar = await createGeneratedUserAvatarFile(db, {
    userId: user.id,
    name: user.name,
    email: user.email,
  })
  await db
    .updateTable("users")
    .set({ avatarFileId: avatar.fileId })
    .where("id", "=", user.id)
    .execute()
}

/** Whether a user is soft-deleted (for the BA session.create.before guard). */
export async function selectUserDeletedState(
  userId: string
): Promise<{ id: string; deletedAt: Date | null } | undefined> {
  return db
    .selectFrom("users")
    .select(["id", "deletedAt"])
    .where("id", "=", userId)
    .executeTakeFirst()
}
