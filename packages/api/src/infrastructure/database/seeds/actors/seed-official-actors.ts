import { transaction } from "../../index.js"
import { executeSqlOn } from "../../kysely.js"
import { ensurePublisher } from "../../seed-utils.js"
import { createGeneratedOfficialActorAvatarFile } from "../../../../modules/avatar/service.js"
import { getOfficialActorAvatarTheme } from "./avatar-themes.js"
import {
  DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG,
  OFFICIAL_ACTOR_TEMPLATE_SEEDS,
  OFFICIAL_ACTOR_TEMPLATE_VERSION,
  type ActorCatalogRefs,
  type OfficialActorCatalogSeedResult,
  type RuntimeRefs,
} from "./index.js"

const SYNAPSE_PUBLISHER_SLUG = "synapse-official"

type DatabaseExecutor = {
  query: (text: string, params?: any[]) => Promise<any>
}

async function deactivateLegacyOfficialActorTemplates(
  client: DatabaseExecutor,
  publisherId: string
) {
  const activeSlugs = OFFICIAL_ACTOR_TEMPLATE_SEEDS.map(({ slug }) => slug)

  await executeSqlOn(
    client,
    `UPDATE catalog_items item
     SET is_active = FALSE,
         updated_at = NOW()
     WHERE item.publisher_id = $1
       AND item.workspace_id IS NULL
       AND item.item_kind = 'actor_template'
       AND item.source_kind = 'official'
       AND NOT (item.slug = ANY($2::text[]))`,
    [publisherId, activeSlugs]
  )

  await executeSqlOn(
    client,
    `UPDATE catalog_versions version
     SET status = 'deprecated'
     FROM catalog_items item
     WHERE version.catalog_item_id = item.id
       AND item.publisher_id = $1
       AND item.workspace_id IS NULL
       AND item.item_kind = 'actor_template'
       AND item.source_kind = 'official'
       AND NOT (item.slug = ANY($2::text[]))
       AND version.status = 'active'`,
    [publisherId, activeSlugs]
  )
}

function isChiefActorTemplate(refs: ActorCatalogRefs) {
  return (
    refs.actor.config?.is_chief_actor === true ||
    refs.slug === DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG
  )
}

export async function seedOfficialActorCatalog(
  userId: string
): Promise<OfficialActorCatalogSeedResult> {
  return transaction(async (client) => {
    const publisherId = await ensurePublisher(client, {
      slug: SYNAPSE_PUBLISHER_SLUG,
      displayName: "Synapse Official",
      description: "Official Synapse catalog publisher",
      ownerUserId: userId,
      isVerified: true,
    })

    const actorRefs: ActorCatalogRefs[] = []
    let defaultActorRefs: ActorCatalogRefs | null = null

    for (const actorSeed of OFFICIAL_ACTOR_TEMPLATE_SEEDS) {
      const avatarFile = await createGeneratedOfficialActorAvatarFile(client, {
        actorSlug: actorSeed.slug,
        actorName: actorSeed.actor.name,
        actorTitle: actorSeed.actor.title,
        uploaderUserId: userId,
        theme: getOfficialActorAvatarTheme(actorSeed.slug),
      })

      const actorProfile = {
        ...actorSeed.actor,
        avatarFileId: avatarFile.fileId,
        avatarEmoji: undefined,
      }

      const actorItem = await executeSqlOn<{ id: string }>(
        client,
        `INSERT INTO catalog_items (
           publisher_id,
           workspace_id,
           item_kind,
           slug,
           display_name,
           summary,
           long_description,
           icon_file_id,
           source_kind,
           visibility,
           tags,
           metadata
         )
         VALUES (
           $1,
           NULL,
           'actor_template',
           $2,
           $3,
           $4,
           $5,
           $6,
           'official',
           'public',
           $7,
           $8::jsonb
         )
         ON CONFLICT (publisher_id, item_kind, slug) WHERE workspace_id IS NULL
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           summary = EXCLUDED.summary,
           long_description = EXCLUDED.long_description,
           icon_file_id = EXCLUDED.icon_file_id,
           tags = EXCLUDED.tags,
           is_active = TRUE,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id`,
        [
          publisherId,
          actorSeed.slug,
          actorSeed.displayName,
          actorSeed.summary,
          actorSeed.longDescription,
          avatarFile.fileId,
          actorSeed.tags,
          JSON.stringify(actorSeed.itemMetadata),
        ]
      )
      const actorItemId = actorItem.rows[0]!.id

      const versionMetadata = {
        ...actorSeed.versionMetadata,
        setupGuide: actorSeed.setupGuide,
        releaseNotes: actorSeed.releaseNotes,
      }

      const actorVersion = await executeSqlOn<{ id: string }>(
        client,
        `INSERT INTO catalog_versions (
           catalog_item_id, version, status, changelog, metadata, created_by_user_id
         )
         VALUES ($1, $2, 'active', 'Initial official actor marketplace seed', $3::jsonb, $4)
         ON CONFLICT (catalog_item_id, version) DO UPDATE SET
           status = 'active',
           changelog = EXCLUDED.changelog,
           metadata = EXCLUDED.metadata
         RETURNING id`,
        [
          actorItemId,
          OFFICIAL_ACTOR_TEMPLATE_VERSION,
          JSON.stringify(versionMetadata),
          userId,
        ]
      )
      const actorVersionId = actorVersion.rows[0]!.id

      await executeSqlOn(
        client,
        `UPDATE catalog_items
         SET latest_version_id = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [actorVersionId, actorItemId]
      )

      await executeSqlOn(
        client,
        `INSERT INTO actor_template_version_specs (
           catalog_version_id,
           role,
           name,
           avatar_file_id,
           avatar_emoji,
           title,
           can_represent_user,
           docs,
           specialties,
           config,
           metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb)
         ON CONFLICT (catalog_version_id) DO UPDATE SET
           role = EXCLUDED.role,
           name = EXCLUDED.name,
           avatar_file_id = EXCLUDED.avatar_file_id,
           avatar_emoji = EXCLUDED.avatar_emoji,
           title = EXCLUDED.title,
           can_represent_user = EXCLUDED.can_represent_user,
           docs = EXCLUDED.docs,
           specialties = EXCLUDED.specialties,
           config = EXCLUDED.config,
           metadata = EXCLUDED.metadata`,
        [
          actorVersionId,
          actorProfile.role,
          actorProfile.name,
          actorProfile.avatarFileId || null,
          actorProfile.avatarEmoji || null,
          actorProfile.title,
          actorProfile.canRepresentUser,
          JSON.stringify(actorProfile.docs),
          actorProfile.specialties,
          JSON.stringify(actorProfile.config),
          JSON.stringify(actorSeed.actorMetadata),
        ]
      )

      const refs = {
        slug: actorSeed.slug,
        actorItemId,
        actorVersionId,
        actor: actorProfile,
      } satisfies ActorCatalogRefs

      actorRefs.push(refs)

      if (actorSeed.slug === DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG) {
        defaultActorRefs = refs
      }
    }

    await deactivateLegacyOfficialActorTemplates(client, publisherId)

    if (!defaultActorRefs) {
      throw new Error("Default official actor template seed is missing.")
    }

    return {
      actorRefs,
      defaultActorRefs,
    } satisfies OfficialActorCatalogSeedResult
  })
}

export async function seedOfficialRuntimeActors(
  workspaceId: string,
  workspaceMemberId: string,
  refsList: ActorCatalogRefs[]
): Promise<RuntimeRefs> {
  return transaction(async (client) => {
    const actorIds: string[] = []
    let chiefActorId: string | null = null

    for (const refs of refsList) {
      const actorSeed = refs.actor
      const actor = await executeSqlOn<{ id: string }>(
        client,
        `INSERT INTO actors (
           workspace_id,
           name,
           role,
           title,
           avatar_file_id,
           avatar_emoji,
           can_represent_user,
           specialties,
           config,
           created_by_workspace_member_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING id`,
        [
          workspaceId,
          actorSeed.name,
          actorSeed.role,
          actorSeed.title,
          actorSeed.avatarFileId || null,
          actorSeed.avatarEmoji || null,
          actorSeed.canRepresentUser,
          actorSeed.specialties,
          JSON.stringify(actorSeed.config),
          workspaceMemberId,
        ]
      )
      const actorId = actor.rows[0]!.id

      const actorVersion = await executeSqlOn<{ id: string }>(
        client,
        `INSERT INTO actor_versions (
           actor_id,
           version,
           name,
           role,
           title,
           can_represent_user,
           specialties,
           config,
           created_by_workspace_member_id
         )
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id`,
        [
          actorId,
          actorSeed.name,
          actorSeed.role,
          actorSeed.title,
          actorSeed.canRepresentUser,
          actorSeed.specialties,
          JSON.stringify(actorSeed.config),
          workspaceMemberId,
        ]
      )
      const actorVersionId = actorVersion.rows[0]!.id

      for (const doc of actorSeed.docs) {
        await executeSqlOn(
          client,
          `INSERT INTO actor_version_docs (
             actor_version_id, doc_key, title, visibility, priority, content_blocks
           )
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            actorVersionId,
            doc.key,
            doc.title,
            doc.visibility,
            doc.priority,
            JSON.stringify(doc.content),
          ]
        )
      }

      await executeSqlOn(
        client,
        `INSERT INTO actor_source_refs (
           actor_id,
           source_catalog_item_id,
           source_catalog_version_id,
           sync_mode,
           baseline_actor_version
         )
         VALUES ($1, $2, $3, 'notify', 1)`,
        [actorId, refs.actorItemId, refs.actorVersionId]
      )

      actorIds.push(actorId)
      if (!chiefActorId && isChiefActorTemplate(refs)) {
        chiefActorId = actorId
      }
    }

    if (!chiefActorId) {
      chiefActorId = actorIds[0] || null
    }
    if (!chiefActorId) {
      throw new Error("Official runtime actors are missing.")
    }

    return {
      actorIds,
      chiefActorId,
    } satisfies RuntimeRefs
  })
}
