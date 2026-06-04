import { sql } from "kysely"
import type { Executor } from "./kysely.js"

export async function ensurePublisher(
  executor: Executor,
  input: {
    slug: string
    displayName: string
    description: string
    ownerUserId?: string | null
    isBuiltin?: boolean
    isVerified?: boolean
  }
) {
  const result = await sql<{ id: string }>`
    INSERT INTO publishers (
      slug, display_name, description, owner_user_id, workspace_id, is_builtin, is_verified
    )
    VALUES (
      ${input.slug},
      ${input.displayName},
      ${input.description},
      ${input.ownerUserId || null},
      NULL,
      ${input.isBuiltin === true},
      ${input.isVerified !== false}
    )
    ON CONFLICT (slug) WHERE deleted_at IS NULL DO UPDATE SET
      display_name = EXCLUDED.display_name,
      description = EXCLUDED.description,
      owner_user_id = COALESCE(publishers.owner_user_id, EXCLUDED.owner_user_id),
      is_builtin = EXCLUDED.is_builtin,
      is_verified = EXCLUDED.is_verified,
      updated_at = NOW()
    RETURNING id`.execute(executor)

  return result.rows[0]!.id
}
