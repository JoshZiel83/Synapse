import type { User } from "@synapse/shared"
import {
  requireInstantDate,
  serializeInstant,
} from "../../infrastructure/datetime.js"
import { getFileUrlById } from "../files/service.js"

/**
 * Structural shape of a selected `users` row used to present a {@link User}
 * DTO. Declared here (not via the generated table types) so the presenter stays
 * clear of the DB layer — the service selects exactly these columns.
 */
export type UserRow = {
  id: string
  email: string
  name: string
  avatarFileId: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

/**
 * Map a selected `users` row to the wire-facing {@link User} DTO, resolving the
 * avatar file id to a URL and serializing instants to ISO strings.
 */
export function presentUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : undefined,
    createdAt: serializeInstant(
      requireInstantDate(row.createdAt, "user.created_at")
    ),
    updatedAt: serializeInstant(
      requireInstantDate(row.updatedAt, "user.updated_at")
    ),
  }
}
