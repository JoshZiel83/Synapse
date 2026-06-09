import { sql } from "kysely"
import { withDbTransaction, type Executor } from "../../kysely.js"
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

async function deactivateLegacyOfficialActorTemplates(
  client: Executor,
  publisherId: string
) {
  const activeSlugs = OFFICIAL_ACTOR_TEMPLATE_SEEDS.map(({ slug }) => slug)

  await sql`
    UPDATE catalog_items item
    SET is_active = FALSE,
        updated_at = NOW()
    WHERE item.publisher_id = ${publisherId}
      AND item.workspace_id IS NULL
      AND item.item_kind = 'actor_template'
      AND item.source_kind = 'official'
      AND NOT (item.slug = ANY(${activeSlugs}::text[]))`.execute(client)

  await sql`
    UPDATE catalog_versions version
    SET status = 'deprecated'
    FROM catalog_items item
    WHERE version.catalog_item_id = item.id
      AND item.publisher_id = ${publisherId}
      AND item.workspace_id IS NULL
      AND item.item_kind = 'actor_template'
      AND item.source_kind = 'official'
      AND NOT (item.slug = ANY(${activeSlugs}::text[]))
      AND version.status = 'active'`.execute(client)
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
  return withDbTransaction(async (client) => {
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
        actorDisplayName: actorSeed.actor.displayName,
        actorTitle: actorSeed.actor.title,
        uploaderUserId: userId,
        theme: getOfficialActorAvatarTheme(actorSeed.slug),
      })

      const actorProfile = {
        ...actorSeed.actor,
        avatarFileId: avatarFile.fileId,
        avatarEmoji: undefined,
      }

      const actorItem = await sql<{ id: string }>`
        INSERT INTO catalog_items (
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
          ${publisherId},
          NULL,
          'actor_template',
          ${actorSeed.slug},
          ${actorSeed.displayName},
          ${actorSeed.summary},
          ${actorSeed.longDescription},
          ${avatarFile.fileId},
          'official',
          'public',
          ${actorSeed.tags},
          ${JSON.stringify(actorSeed.itemMetadata)}::jsonb
        )
        ON CONFLICT (publisher_id, item_kind, slug) WHERE workspace_id IS NULL AND deleted_at IS NULL
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          summary = EXCLUDED.summary,
          long_description = EXCLUDED.long_description,
          icon_file_id = EXCLUDED.icon_file_id,
          tags = EXCLUDED.tags,
          is_active = TRUE,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING id`.execute(client)
      const actorItemId = actorItem.rows[0]!.id

      const versionMetadata = {
        ...actorSeed.versionMetadata,
        setupGuide: actorSeed.setupGuide,
        releaseNotes: actorSeed.releaseNotes,
      }

      const actorVersion = await sql<{ id: string }>`
        INSERT INTO catalog_versions (
          catalog_item_id, version, status, changelog, metadata, created_by_user_id
        )
        VALUES (
          ${actorItemId},
          ${OFFICIAL_ACTOR_TEMPLATE_VERSION},
          'active',
          'Initial official actor marketplace seed',
          ${JSON.stringify(versionMetadata)}::jsonb,
          ${userId}
        )
        ON CONFLICT (catalog_item_id, version) DO UPDATE SET
          status = 'active',
          changelog = EXCLUDED.changelog,
          metadata = EXCLUDED.metadata
        RETURNING id`.execute(client)
      const actorVersionId = actorVersion.rows[0]!.id

      await sql`
        UPDATE catalog_items
        SET latest_version_id = ${actorVersionId},
            updated_at = NOW()
        WHERE id = ${actorItemId}`.execute(client)

      await sql`
        INSERT INTO actor_template_version_specs (
          catalog_version_id,
          role,
          display_name,
          avatar_file_id,
          avatar_emoji,
          title,
          can_represent_user,
          docs,
          specialties,
          config,
          metadata
        )
        VALUES (
          ${actorVersionId},
          ${actorProfile.role},
          ${actorProfile.displayName},
          ${actorProfile.avatarFileId || null},
          ${actorProfile.avatarEmoji || null},
          ${actorProfile.title},
          ${actorProfile.canRepresentUser},
          ${JSON.stringify(actorProfile.docs)}::jsonb,
          ${actorProfile.specialties},
          ${JSON.stringify(actorProfile.config)}::jsonb,
          ${JSON.stringify(actorSeed.actorMetadata)}::jsonb
        )
        ON CONFLICT (catalog_version_id) DO UPDATE SET
          role = EXCLUDED.role,
          display_name = EXCLUDED.display_name,
          avatar_file_id = EXCLUDED.avatar_file_id,
          avatar_emoji = EXCLUDED.avatar_emoji,
          title = EXCLUDED.title,
          can_represent_user = EXCLUDED.can_represent_user,
          docs = EXCLUDED.docs,
          specialties = EXCLUDED.specialties,
          config = EXCLUDED.config,
          metadata = EXCLUDED.metadata`.execute(client)

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
  return withDbTransaction(async (client) => {
    const actorIds: string[] = []
    let chiefActorId: string | null = null

    for (const refs of refsList) {
      const actorSeed = refs.actor
      const actorId = crypto.randomUUID()
      await sql`
        INSERT INTO workspace_apps (
          id,
          workspace_id,
          kind,
          display_name,
          owner_workspace_member_id,
          status
        )
        VALUES (
          ${actorId},
          ${workspaceId},
          'actor',
          ${actorSeed.displayName},
          ${workspaceMemberId},
          'active'
        )`.execute(client)
      const actor = await sql<{ id: string }>`
        INSERT INTO actors (
          id,
          role,
          title,
          avatar_file_id,
          avatar_emoji,
          can_represent_user,
          specialties,
          config,
          current_version
        )
        VALUES (
          ${actorId},
          ${actorSeed.role},
          ${actorSeed.title},
          ${actorSeed.avatarFileId || null},
          ${actorSeed.avatarEmoji || null},
          ${actorSeed.canRepresentUser},
          ${actorSeed.specialties},
          ${JSON.stringify(actorSeed.config)}::jsonb,
          1
        )
        RETURNING id`.execute(client)
      const insertedActorId = actor.rows[0]!.id

      const actorVersion = await sql<{ id: string }>`
        INSERT INTO actor_versions (
          actor_id,
          version,
          display_name,
          role,
          title,
          can_represent_user,
          specialties,
          config,
          created_by_workspace_member_id
        )
        VALUES (
          ${insertedActorId},
          1,
          ${actorSeed.displayName},
          ${actorSeed.role},
          ${actorSeed.title},
          ${actorSeed.canRepresentUser},
          ${actorSeed.specialties},
          ${JSON.stringify(actorSeed.config)}::jsonb,
          ${workspaceMemberId}
        )
        RETURNING id`.execute(client)
      const actorVersionId = actorVersion.rows[0]!.id

      for (const doc of actorSeed.docs) {
        await sql`
          INSERT INTO actor_version_docs (
            actor_version_id, doc_key, title, visibility, priority, content_blocks
          )
          VALUES (
            ${actorVersionId},
            ${doc.key},
            ${doc.title},
            ${doc.visibility},
            ${doc.priority},
            ${JSON.stringify(doc.content)}::jsonb
          )`.execute(client)
      }

      await sql`
        INSERT INTO actor_source_refs (
          actor_id,
          source_catalog_item_id,
          source_catalog_version_id,
          sync_mode,
          baseline_actor_version
        )
        VALUES (${insertedActorId}, ${refs.actorItemId}, ${refs.actorVersionId}, 'notify', 1)`.execute(
        client
      )

      actorIds.push(insertedActorId)
      if (!chiefActorId && isChiefActorTemplate(refs)) {
        chiefActorId = insertedActorId
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
