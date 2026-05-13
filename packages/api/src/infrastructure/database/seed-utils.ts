import { executeSqlOn } from "./kysely.js"

export async function ensurePublisher(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  input: {
    slug: string
    displayName: string
    description: string
    ownerUserId?: string | null
    isBuiltin?: boolean
    isVerified?: boolean
  }
) {
  const result = await executeSqlOn<{ id: string }>(
    client,
    `INSERT INTO publishers (
       slug, display_name, description, owner_user_id, workspace_id, is_builtin, is_verified
     )
     VALUES ($1, $2, $3, $4, NULL, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       owner_user_id = COALESCE(publishers.owner_user_id, EXCLUDED.owner_user_id),
       is_builtin = EXCLUDED.is_builtin,
       is_verified = EXCLUDED.is_verified,
       updated_at = NOW()
     RETURNING id`,
    [
      input.slug,
      input.displayName,
      input.description,
      input.ownerUserId || null,
      input.isBuiltin === true,
      input.isVerified !== false,
    ]
  )

  return result.rows[0]!.id
}
