import crypto from "node:crypto"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG } from "../../infrastructure/database/seeds/actors/index.js"
import { getFileUrlById } from "../files/service.js"
import {
  INVITE_TRUST_LEVELS,
  normalizeActorDocs,
  parseJsonObject,
  slugify,
  type ActorDoc,
  type ActorDocInput,
  type ActorRole,
  type WorkspaceChiefActorPreference,
} from "@synapse/shared"
import { seedWorkspaceCapabilityConversationTypePolicies } from "../capabilities/conversation-type-policies.js"
import { markWorkspaceDeleted } from "../soft-delete/orchestration.js"
import { insertWorkspaceAppRoot } from "../workspace-apps/root-storage.js"
import {
  deriveWorkspaceTrustLevel,
  presentActorRow,
  presentMemberRow,
  presentWorkspaceChiefActorPreferenceRow,
  presentWorkspaceRow,
} from "./presenter.js"
import type {
  ActorRecord,
  ActorsConfig,
  ActorVersionsConfig,
  WorkspaceAccessKey,
  WorkspaceTrustLevel,
} from "./repo.types.js"
import { sql } from "kysely"
import { createLogger } from "../../infrastructure/logger/index.js"

const log = createLogger("workspace")

export interface CreateWorkspaceInput {
  name: string
  description?: string
  userId: string
}

export interface AddMemberInput {
  workspaceId: string
  userId: string
  trustLevel: WorkspaceTrustLevel
}

export type { WorkspaceAccessKey }

async function getWorkspaceMemberRowByUserId(
  workspaceId: string,
  userId: string
) {
  return (
    db
      .selectFrom("workspaceMembers")
      .select(["id", "workspaceId", "userId", "trustLevel", "joinedAt"])
      .where("workspaceId", "=", workspaceId)
      .where("userId", "=", userId)
      // Soft delete (§8.4): resolve only active memberships.
      .where("status", "=", "active")
      .limit(1)
      .executeTakeFirst()
  )
}

async function requireWorkspaceMemberRowByUserId(
  workspaceId: string,
  userId: string
) {
  const member = await getWorkspaceMemberRowByUserId(workspaceId, userId)
  if (!member) {
    throw new Error("Workspace membership not found")
  }
  return member
}

async function getWorkspaceMemberRowById(workspaceMemberId: string) {
  return db
    .selectFrom("workspaceMembers")
    .select(["id", "workspaceId", "userId", "trustLevel", "joinedAt"])
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
}

function generateSlug(name: string): string {
  const base = slugify(name)
  const suffix = crypto.randomBytes(4).toString("hex")
  return `${base}-${suffix}`
}

const OFFICIAL_ACTOR_PUBLISHER_SLUG = "synapse-official"
const OFFICIAL_CHIEF_ACTOR_CONFIG = { is_chief_actor: true } as const
const OFFICIAL_CHIEF_ACTOR_CONFIG_JSON = JSON.stringify(
  OFFICIAL_CHIEF_ACTOR_CONFIG
)

type LoadedOfficialActorTemplate = {
  packageId: string
  packageSlug: string
  versionId: string
  actorDisplayName: string
  actorRole: ActorRole
  actorAvatarFileId?: string
  actorAvatarEmoji?: string
  actorTitle: string
  canRepresentUser: boolean
  actorDocs: ActorDoc[]
  actorSpecialties: string[]
  actorConfig: Record<string, unknown>
  isChiefActor: boolean
}

function withOfficialChiefActorConfig(
  config: Record<string, unknown>,
  isChiefActor: boolean
) {
  return isChiefActor
    ? {
        ...config,
        ...OFFICIAL_CHIEF_ACTOR_CONFIG,
      }
    : config
}

async function findOfficialChiefActorId(
  executor: Executor,
  workspaceId: string
) {
  const result = await executor
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .leftJoin("actorSourceRefs as source_ref", "source_ref.actorId", "a.id")
    .leftJoin(
      "catalogItems as item",
      "item.id",
      "source_ref.sourceCatalogItemId"
    )
    .select("a.id")
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where((eb) =>
      eb.or([
        sql<boolean>`a.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb`,
        eb.and([
          eb("item.workspaceId", "is", null),
          eb("item.itemKind", "=", "actor_template"),
          eb("item.slug", "=", DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG),
        ]),
      ])
    )
    .orderBy(
      sql`case when a.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb then 0 else 1 end`
    )
    .orderBy("a.createdAt", "asc")
    .limit(1)
    .executeTakeFirst()

  return result?.id ?? null
}

export async function assignOfficialChiefActorPreference(
  executor: Executor,
  workspaceId: string,
  workspaceMemberId: string,
  actorId?: string | null
) {
  const chiefActorId =
    typeof actorId === "string" && actorId.trim().length > 0
      ? actorId
      : await findOfficialChiefActorId(executor, workspaceId)

  if (!chiefActorId) {
    return null
  }

  await executor
    .insertInto("workspaceMemberPreferences")
    .values({
      workspaceMemberId: workspaceMemberId,
      chiefActorId: chiefActorId,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.column("workspaceMemberId").doUpdateSet({
        chiefActorId: chiefActorId,
      })
    )
    .execute()

  return chiefActorId
}

function parseStoredActorDocs(value: unknown) {
  const docsValue =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value
  return normalizeActorDocs(
    Array.isArray(docsValue) ? (docsValue as ActorDocInput[]) : []
  )
}

function isOfficialChiefTemplate(row: {
  packageSlug: string
  actorConfig: unknown
}) {
  const config = parseJsonObject(row.actorConfig)
  return (
    config.is_chief_actor === true ||
    row.packageSlug === DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG
  )
}

async function loadOfficialActorTemplates(
  executor: Executor
): Promise<LoadedOfficialActorTemplate[]> {
  const rows = await executor
    .selectFrom("catalogItems as item")
    .innerJoin("publishers as publisher", "publisher.id", "item.publisherId")
    .innerJoin(
      "catalogVersions as version",
      "version.id",
      "item.latestVersionId"
    )
    .innerJoin(
      "actorTemplateVersionSpecs as spec",
      "spec.catalogVersionId",
      "version.id"
    )
    .select([
      "item.id as packageId",
      "item.slug as packageSlug",
      "version.id as versionId",
      "spec.role as actorRole",
      "spec.displayName as actorTemplateDisplayName",
      "spec.avatarFileId as actorAvatarFileId",
      "spec.avatarEmoji as actorAvatarEmoji",
      "spec.title as actorTitle",
      "spec.canRepresentUser as actorCanRepresentUser",
      "spec.docs as actorDocs",
      "spec.specialties as actorSpecialties",
      "spec.config as actorConfig",
    ])
    .where("publisher.slug", "=", OFFICIAL_ACTOR_PUBLISHER_SLUG)
    .where("item.workspaceId", "is", null)
    .where("item.itemKind", "=", "actor_template")
    .where("item.isActive", "=", true)
    .orderBy(
      sql`case when spec.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb or item.slug = ${DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG} then 0 else 1 end`
    )
    .orderBy("item.createdAt", "asc")
    .orderBy("item.slug", "asc")
    .execute()

  if (rows.length === 0) {
    throw new Error("Official actor templates are missing.")
  }

  return rows.map((row) => {
    const isChiefActor = isOfficialChiefTemplate(row)
    return {
      packageId: row.packageId,
      packageSlug: row.packageSlug,
      versionId: row.versionId,
      actorDisplayName: row.actorTemplateDisplayName,
      actorRole: row.actorRole,
      actorAvatarFileId: row.actorAvatarFileId || undefined,
      actorAvatarEmoji: row.actorAvatarEmoji || undefined,
      actorTitle: row.actorTitle,
      canRepresentUser: Boolean(row.actorCanRepresentUser),
      actorDocs: parseStoredActorDocs(row.actorDocs),
      actorSpecialties: Array.isArray(row.actorSpecialties)
        ? row.actorSpecialties
        : [],
      actorConfig: withOfficialChiefActorConfig(
        parseJsonObject(row.actorConfig),
        isChiefActor
      ),
      isChiefActor,
    } satisfies LoadedOfficialActorTemplate
  })
}

export async function createWorkspace(input: CreateWorkspaceInput) {
  const slug = generateSlug(input.name)

  const result = await withDbTransaction(async (trx) => {
    // 1. Create workspace
    const workspace = await trx
      .insertInto("workspaces")
      .values({
        name: input.name,
        slug,
        description: input.description ?? null,
        ownerId: input.userId,
      })
      .returningAll()
      .executeTakeFirst()
    if (!workspace) {
      throw new Error("Failed to create workspace.")
    }

    // 2. Add creator as admin member; owner is derived from workspaces.owner_id.
    const creatorMember = await trx
      .insertInto("workspaceMembers")
      .values({
        workspaceId: String(workspace.id),
        userId: input.userId,
        trustLevel: "admin",
      })
      .returningAll()
      .executeTakeFirst()
    if (!creatorMember) {
      throw new Error("Failed to create workspace member.")
    }

    await seedWorkspaceCapabilityConversationTypePolicies(
      trx,
      String(workspace.id)
    )

    const officialActorTemplates = await loadOfficialActorTemplates(trx)
    const installedActors: Array<{
      actorRow: ActorRecord
      template: LoadedOfficialActorTemplate
    }> = []

    for (const template of officialActorTemplates) {
      const actorId = crypto.randomUUID()
      await insertWorkspaceAppRoot(trx, {
        id: actorId,
        workspaceId: String(workspace.id),
        kind: "actor",
        displayName: template.actorDisplayName,
        ownerWorkspaceMemberId: String(creatorMember.id),
        status: "active",
      })
      const actorRow = await trx
        .insertInto("actors")
        .values({
          id: actorId,
          role: template.actorRole,
          title: template.actorTitle,
          avatarFileId: template.actorAvatarFileId || null,
          avatarEmoji: template.actorAvatarEmoji || null,
          parentId: null,
          canRepresentUser: template.canRepresentUser,
          specialties: template.actorSpecialties,
          config: template.actorConfig as ActorsConfig,
          currentVersion: 1,
        })
        .returningAll()
        .executeTakeFirst()
      if (!actorRow) {
        throw new Error(`Failed to install actor ${template.actorDisplayName}`)
      }

      const actorVersionResult = await trx
        .insertInto("actorVersions")
        .values({
          actorId: String(actorRow.id),
          version: 1,
          displayName: template.actorDisplayName,
          role: template.actorRole,
          title: template.actorTitle,
          parentId: null,
          canRepresentUser: template.canRepresentUser,
          specialties: template.actorSpecialties,
          config: template.actorConfig as ActorVersionsConfig,
          createdByWorkspaceMemberId: String(creatorMember.id),
        })
        .returning("id")
        .executeTakeFirst()
      if (!actorVersionResult) {
        throw new Error(
          `Failed to create actor version for ${template.actorDisplayName}`
        )
      }
      const actorVersionId = actorVersionResult.id

      for (const doc of template.actorDocs) {
        await trx
          .insertInto("actorVersionDocs")
          .values({
            actorVersionId: actorVersionId,
            docKey: doc.key,
            title: doc.title,
            visibility: doc.visibility,
            priority: doc.priority,
            contentBlocks: sql`${JSON.stringify(doc.content)}::jsonb`,
          })
          .execute()
      }

      await trx
        .insertInto("actorSourceRefs")
        .values({
          actorId: String(actorRow.id),
          sourceCatalogItemId: template.packageId,
          sourceCatalogVersionId: template.versionId,
          syncMode: "notify",
          baselineActorVersion: 1,
        })
        .execute()

      installedActors.push({
        actorRow,
        template,
      })
    }

    if (installedActors.length === 0) {
      throw new Error("Failed to install official actors for workspace.")
    }

    const chiefActor =
      installedActors.find(({ template }) => template.isChiefActor) ||
      installedActors[0]!

    await assignOfficialChiefActorPreference(
      trx,
      String(workspace.id),
      String(creatorMember.id),
      String(chiefActor.actorRow.id)
    )

    return {
      workspace: presentWorkspaceRow(workspace),
      secretary: presentActorRow({
        row: chiefActor.actorRow,
        workspaceId: String(workspace.id),
        displayName: chiefActor.template.actorDisplayName,
        docs: chiefActor.template.actorDocs,
      }),
      installedTemplatePackageIds: officialActorTemplates.map(
        (template) => template.packageId
      ),
    }
  })

  // Bump catalog_items.download_count outside the workspace-creation
  // transaction. This used to live inline before the return and
  // deadlocked under concurrent workspace creates: two transactions
  // both ran `UPDATE catalog_items WHERE id IN (a, b, ...)` and
  // Postgres acquired the row locks in whatever order the planner
  // chose, so two simultaneous calls could lock {a then b} vs {b then
  // a} and one would always be killed by the deadlock detector.
  //
  // The count is best-effort observability — it must not roll back a
  // workspace create. Running it post-commit, one row at a time in
  // id-sorted order, removes the cycle (each tx grabs locks in the
  // same order) and a transient failure now just leaves the counter a
  // step behind instead of failing the user-visible request.
  const sortedTemplateIds = [...result.installedTemplatePackageIds].sort()
  for (const templateId of sortedTemplateIds) {
    try {
      await sql`
        UPDATE catalog_items
           SET download_count = download_count + 1
         WHERE id = ${templateId}`.execute(db)
    } catch (err) {
      log.warn(
        { err },
        `[workspace.createWorkspace] best-effort download_count bump failed for catalog_item ${templateId}`
      )
    }
  }

  return {
    ...result.workspace,
    secretary: result.secretary,
  }
}

export async function listUserWorkspaces(userId: string) {
  const rows = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .selectAll("w")
    .select(["wm.id as currentWorkspaceMemberId", "wm.trustLevel"])
    .where("wm.userId", "=", userId)
    // Soft delete (§8.4): only active memberships of live workspaces are listed.
    .where("wm.status", "=", "active")
    .where("w.deletedAt", "is", null)
    .orderBy("w.createdAt", "desc")
    .execute()
  return rows.map((row) => ({
    ...presentWorkspaceRow(row),
    currentWorkspaceMemberId: row.currentWorkspaceMemberId ?? undefined,
    trustLevel: deriveWorkspaceTrustLevel(row),
  }))
}

export async function getWorkspaceById(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  return row ? presentWorkspaceRow(row) : null
}

export async function getWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string
): Promise<WorkspaceChiefActorPreference> {
  const member = await requireWorkspaceMemberRowByUserId(workspaceId, userId)
  const row = await db
    .selectFrom("workspaceMemberPreferences as pref")
    .innerJoin("workspaceMembers as wm", "wm.id", "pref.workspaceMemberId")
    .leftJoin("actors as a", (join) =>
      join.onRef("a.id", "=", "pref.chiefActorId").on(
        sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_apps_live app
            WHERE app.id = a.id
              AND app.workspace_id = wm.workspace_id
              AND app.deleted_at IS NULL
              AND app.status = 'active'
          )`
      )
    )
    .leftJoin("workspaceApps as chief_actor_app", "chief_actor_app.id", "a.id")
    .leftJoin("fileAssets as avatar_file", "avatar_file.id", "a.avatarFileId")
    .select([
      "wm.workspaceId",
      "wm.userId",
      "wm.id as workspaceMemberId",
      "pref.chiefActorId",
      "pref.createdAt",
      "pref.updatedAt",
      "chief_actor_app.displayName as chiefActorDisplayName",
      "a.role as chiefActorRole",
      "a.title as chiefActorTitle",
      "avatar_file.id as chiefActorAvatarFileId",
    ])
    .where("pref.workspaceMemberId", "=", member.id)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    return {
      workspaceId,
      workspaceMemberId: member.id,
    }
  }

  return presentWorkspaceChiefActorPreferenceRow(row)
}

export async function updateWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string,
  chiefActorId?: string | null
): Promise<WorkspaceChiefActorPreference> {
  const member = await requireWorkspaceMemberRowByUserId(workspaceId, userId)
  if (!chiefActorId) {
    // Clearing a preference physically removes the child row; routed through the
    // SECURITY DEFINER fn since sd_reject_delete forbids a naked DELETE (§7.5).
    await sql`SELECT sd_clear_member_preferences(${member.id}::uuid)`.execute(
      db
    )

    return {
      workspaceId,
      workspaceMemberId: member.id,
    }
  }

  const actorRow = await db
    .selectFrom("actors as actor")
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select("actor.id")
    .where("actor.id", "=", chiefActorId)
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .limit(1)
    .executeTakeFirst()

  if (!actorRow) {
    throw new Error("Chief actor is not available in this workspace")
  }

  await db
    .insertInto("workspaceMemberPreferences")
    .values({
      workspaceMemberId: member.id,
      chiefActorId: chiefActorId,
      createdAt: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.column("workspaceMemberId").doUpdateSet({
        chiefActorId: chiefActorId,
      })
    )
    .execute()

  return getWorkspaceChiefActorPreference(workspaceId, userId)
}

export async function updateWorkspace(
  workspaceId: string,
  updates: { name?: string; description?: string }
) {
  if (updates.name === undefined && updates.description === undefined) {
    return getWorkspaceById(workspaceId)
  }

  const row = await db
    .updateTable("workspaces")
    .set({
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined
        ? { description: updates.description }
        : {}),
    })
    .where("id", "=", workspaceId)
    .returningAll()
    .executeTakeFirst()
  return row ? presentWorkspaceRow(row) : null
}

/**
 * Soft-delete a workspace and its entire tenant footprint (design §5.5). Runs
 * the markWorkspaceDeleted orchestration in one transaction: soft-deletes every
 * workspace-scoped root, revokes memberships/bindings/grants, stops runtime.
 * Returns false if the workspace was already gone / not live.
 */
export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  const live = await db
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  if (!live) return false
  await withDbTransaction((trx) => markWorkspaceDeleted(trx, workspaceId))
  return true
}

export async function checkMembership(workspaceId: string, userId: string) {
  const row = await db
    .selectFrom("workspaces as w")
    .leftJoin("workspaceMembers as wm", (join) =>
      join
        .onRef("wm.workspaceId", "=", "w.id")
        .on("wm.userId", "=", userId)
        // Soft delete (§8.4): only an active membership counts.
        .on("wm.status", "=", "active")
    )
    .select(["w.ownerId", "wm.userId", "wm.trustLevel"])
    .where("w.id", "=", workspaceId)
    .where("w.deletedAt", "is", null)
    .executeTakeFirst()
  return row ? deriveWorkspaceTrustLevel(row) : null
}

export async function addMember(input: AddMemberInput) {
  const result = await withDbTransaction(async (trx) => {
    // Single durable membership row (design §6): re-joining a previously
    // left/removed member REVIVES the row (status→active) rather than failing.
    // "already an active member" is detected via the pre-existing status.
    const existing = await trx
      .selectFrom("workspaceMembers")
      .select(["id", "status"])
      .where("workspaceId", "=", input.workspaceId)
      .where("userId", "=", input.userId)
      .executeTakeFirst()
    if (existing?.status === "active") {
      return null
    }

    const memberRow = await trx
      .insertInto("workspaceMembers")
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        trustLevel: input.trustLevel,
      })
      .onConflict((oc) =>
        oc.columns(["workspaceId", "userId"]).doUpdateSet({
          status: "active",
          trustLevel: input.trustLevel,
          leftAt: null,
          removedAt: null,
        })
      )
      .returningAll()
      .executeTakeFirst()

    if (!memberRow) {
      return null
    }

    await assignOfficialChiefActorPreference(
      trx,
      input.workspaceId,
      String(memberRow.id)
    )

    return {
      member: presentMemberRow(memberRow),
    }
  })

  if (!result) {
    return null
  }

  return result.member
}

export async function listMembers(workspaceId: string) {
  const accessMap = db
    .selectFrom("workspaceAccessBindings")
    .select([
      "workspaceMemberId",
      sql<string[]>`array_agg(access_key order by access_key)`.as(
        "access_keys"
      ),
    ])
    .where("status", "=", "active")
    .groupBy(["workspaceMemberId"])
    .as("access_map")

  const rows = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .innerJoin("users as u", "u.id", "wm.userId")
    .leftJoin(accessMap, (join) =>
      join.onRef("access_map.workspaceMemberId", "=", "wm.id")
    )
    .select([
      "wm.id",
      "wm.workspaceId",
      "wm.userId",
      "wm.trustLevel",
      "w.ownerId",
      "wm.joinedAt",
      "u.name as userName",
      "u.email as userEmail",
      "u.avatarFileId",
      sql<
        string[]
      >`COALESCE(access_map.access_keys, ARRAY[]::workspace_access_bindings_access_key[])`.as(
        "accessKeys"
      ),
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .orderBy("wm.joinedAt", "asc")
    .execute()
  return rows.map((row) => ({
    ...presentMemberRow(row),
    userName: row.userName,
    userEmail: row.userEmail,
    avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : null,
    accessKeys: Array.isArray(row.accessKeys) ? row.accessKeys : [],
  }))
}

export async function listWorkspaceAccessBindings(workspaceId: string) {
  const rows = await db
    .selectFrom("workspaceAccessBindings as wab")
    .innerJoin("workspaceMembers as wm", "wm.id", "wab.workspaceMemberId")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .innerJoin("users as u", "u.id", "wm.userId")
    .select([
      "wab.workspaceMemberId",
      "wab.accessKey",
      "wab.assignedByWorkspaceMemberId",
      "wab.createdAt",
      "wab.updatedAt",
      "wm.id",
      "wm.workspaceId",
      "wm.userId",
      "u.name as userName",
      "u.email as userEmail",
      "u.avatarFileId",
      "w.ownerId",
      "wm.trustLevel",
    ])
    .where("wm.workspaceId", "=", workspaceId)
    .orderBy("wab.accessKey", "asc")
    .orderBy("wab.createdAt", "asc")
    .execute()

  return rows.map((row) => ({
    workspaceId: row.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
    userId: row.userId,
    accessKey: row.accessKey as WorkspaceAccessKey,
    assignedByWorkspaceMemberId: row.assignedByWorkspaceMemberId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    trustLevel: deriveWorkspaceTrustLevel(row),
    userName: row.userName,
    userEmail: row.userEmail,
    avatarUrl: row.avatarFileId ? getFileUrlById(row.avatarFileId) : null,
  }))
}

export async function grantWorkspaceAccess(input: {
  workspaceId: string
  workspaceMemberId: string
  accessKey: WorkspaceAccessKey
  assignedByWorkspaceMemberId: string
}) {
  const membership = await getWorkspaceMemberRowById(input.workspaceMemberId)

  if (!membership || membership.workspaceId !== input.workspaceId) {
    throw new Error("Workspace member is not part of this workspace")
  }

  // Re-grant must revive a previously-revoked row (design §6.2): the composite
  // PK is kept, so onConflict updates status back to 'active' rather than
  // doNothing (which would let a revoked row permanently block re-granting).
  // "Already granted" is now detected by checking the pre-existing active state.
  const existing = await db
    .selectFrom("workspaceAccessBindings")
    .select(["status"])
    .where("workspaceMemberId", "=", input.workspaceMemberId)
    .where("accessKey", "=", input.accessKey)
    .executeTakeFirst()
  if (existing?.status === "active") {
    throw new Error("Access already granted")
  }

  const row = await db
    .insertInto("workspaceAccessBindings")
    .values({
      workspaceMemberId: input.workspaceMemberId,
      accessKey: input.accessKey,
      assignedByWorkspaceMemberId: input.assignedByWorkspaceMemberId,
    })
    .onConflict((oc) =>
      oc.columns(["workspaceMemberId", "accessKey"]).doUpdateSet({
        status: "active",
        revokedAt: null,
        assignedByWorkspaceMemberId: input.assignedByWorkspaceMemberId,
      })
    )
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    throw new Error("Access already granted")
  }

  return {
    workspaceId: membership.workspaceId,
    workspaceMemberId: row.workspaceMemberId,
    userId: membership.userId,
    accessKey: row.accessKey as WorkspaceAccessKey,
    assignedByWorkspaceMemberId: row.assignedByWorkspaceMemberId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function revokeWorkspaceAccess(
  workspaceId: string,
  workspaceMemberId: string,
  accessKey: WorkspaceAccessKey
) {
  const membership = await getWorkspaceMemberRowById(workspaceMemberId)
  if (!membership || membership.workspaceId !== workspaceId) {
    throw new Error("Access grant not found")
  }

  // Soft revoke (design §6.2 option A): flip status instead of hard-deleting the
  // row (which sd_reject_delete forbids). Re-granting revives the row. The
  // revoker identity is not threaded to this layer; audit_logs records the actor.
  const row = await db
    .updateTable("workspaceAccessBindings")
    .set({
      status: "revoked",
      revokedAt: sql`NOW()`,
    })
    .where("workspaceMemberId", "=", workspaceMemberId)
    .where("accessKey", "=", accessKey)
    .where("status", "=", "active")
    .returning(["workspaceMemberId", "accessKey"])
    .executeTakeFirst()

  if (!row) {
    throw new Error("Access grant not found")
  }
}
