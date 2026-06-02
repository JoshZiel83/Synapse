import crypto from "node:crypto"
import {
  db,
  withDbTransaction,
  type Executor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import { DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG } from "../../infrastructure/database/seeds/actors/index.js"
import { getFileUrlById } from "../files/service.js"
import {
  INVITE_TRUST_LEVELS,
  normalizeActorDocs,
  RELATIONSHIP_ACCESS_POLICY,
  type ActorDoc,
  type ActorDocInput,
  type ActorRole,
  type WorkspaceChiefActorPreference,
} from "@synapse/shared"
import { seedWorkspaceCapabilityConversationTypePolicies } from "../capabilities/conversation-type-policies.js"
import { setAccessPolicy } from "../access/default-access-policy.js"
import type {
  WorkspaceAccessBindingsAccessKey,
  WorkspaceMembersTrustLevel,
} from "../../infrastructure/database/generated/db.js"
import { sql } from "kysely"

export interface CreateWorkspaceInput {
  name: string
  description?: string
  userId: string
}

export interface AddMemberInput {
  workspaceId: string
  userId: string
  trustLevel: WorkspaceMembersTrustLevel
}

export type WorkspaceAccessKey = WorkspaceAccessBindingsAccessKey

function deriveWorkspaceTrustLevel(row: {
  owner_id?: string | null
  user_id?: string | null
  trust_level?: string | null
}) {
  if (row.owner_id && row.user_id && row.owner_id === row.user_id) {
    return "owner"
  }
  return row.trust_level ?? null
}

async function getWorkspaceMemberRowByUserId(
  workspaceId: string,
  userId: string
) {
  return db
    .selectFrom("workspace_members")
    .select(["id", "workspace_id", "user_id", "trust_level", "joined_at"])
    .where("workspace_id", "=", workspaceId)
    .where("user_id", "=", userId)
    .limit(1)
    .executeTakeFirst()
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
    .selectFrom("workspace_members")
    .select(["id", "workspace_id", "user_id", "trust_level", "joined_at"])
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
}

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  const suffix = crypto.randomBytes(4).toString("hex")
  return `${base}-${suffix}`
}

function toIsoString(value: string | Date | null | undefined) {
  if (typeof value === "string") return value
  if (value instanceof Date) return value.toISOString()
  return undefined
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
  actorName: string
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

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
    .leftJoin("actor_source_refs as source_ref", "source_ref.actor_id", "a.id")
    .leftJoin(
      "catalog_items as item",
      "item.id",
      "source_ref.source_catalog_item_id"
    )
    .select("a.id")
    .where("a.workspace_id", "=", workspaceId)
    .where("a.is_active", "=", true)
    .where((eb) =>
      eb.or([
        sql<boolean>`a.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb`,
        eb.and([
          eb("item.workspace_id", "is", null),
          eb("item.item_kind", "=", "actor_template"),
          eb("item.slug", "=", DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG),
        ]),
      ])
    )
    .orderBy(
      sql`case when a.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb then 0 else 1 end`
    )
    .orderBy("a.created_at", "asc")
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
    .insertInto("workspace_member_preferences")
    .values({
      workspace_member_id: workspaceMemberId,
      chief_actor_id: chiefActorId,
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.column("workspace_member_id").doUpdateSet({
        chief_actor_id: chiefActorId,
        updated_at: sql`NOW()`,
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
  package_slug: string
  actor_config: unknown
}) {
  const config = parseJsonObject(row.actor_config)
  return (
    config.is_chief_actor === true ||
    row.package_slug === DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG
  )
}

async function loadOfficialActorTemplates(
  executor: Executor
): Promise<LoadedOfficialActorTemplate[]> {
  const rows = await executor
    .selectFrom("catalog_items as item")
    .innerJoin("publishers as publisher", "publisher.id", "item.publisher_id")
    .innerJoin(
      "catalog_versions as version",
      "version.id",
      "item.latest_version_id"
    )
    .innerJoin(
      "actor_template_version_specs as spec",
      "spec.catalog_version_id",
      "version.id"
    )
    .select([
      "item.id as package_id",
      "item.slug as package_slug",
      "version.id as version_id",
      "spec.role as actor_role",
      "spec.name as actor_name",
      "spec.avatar_file_id as actor_avatar_file_id",
      "spec.avatar_emoji as actor_avatar_emoji",
      "spec.title as actor_title",
      "spec.can_represent_user as actor_can_represent_user",
      "spec.docs as actor_docs",
      "spec.specialties as actor_specialties",
      "spec.config as actor_config",
    ])
    .where("publisher.slug", "=", OFFICIAL_ACTOR_PUBLISHER_SLUG)
    .where("item.workspace_id", "is", null)
    .where("item.item_kind", "=", "actor_template")
    .where("item.is_active", "=", true)
    .orderBy(
      sql`case when spec.config @> ${OFFICIAL_CHIEF_ACTOR_CONFIG_JSON}::jsonb or item.slug = ${DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG} then 0 else 1 end`
    )
    .orderBy("item.created_at", "asc")
    .orderBy("item.slug", "asc")
    .execute()

  if (rows.length === 0) {
    throw new Error("Official actor templates are missing.")
  }

  return rows.map((row) => {
    const isChiefActor = isOfficialChiefTemplate(row)
    return {
      packageId: row.package_id,
      packageSlug: row.package_slug,
      versionId: row.version_id,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      actorAvatarFileId: row.actor_avatar_file_id || undefined,
      actorAvatarEmoji: row.actor_avatar_emoji || undefined,
      actorTitle: row.actor_title,
      canRepresentUser: Boolean(row.actor_can_represent_user),
      actorDocs: parseStoredActorDocs(row.actor_docs),
      actorSpecialties: Array.isArray(row.actor_specialties)
        ? row.actor_specialties
        : [],
      actorConfig: withOfficialChiefActorConfig(
        parseJsonObject(row.actor_config),
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
        owner_id: input.userId,
      })
      .returningAll()
      .executeTakeFirst()
    if (!workspace) {
      throw new Error("Failed to create workspace.")
    }

    // 2. Add creator as admin member; owner is derived from workspaces.owner_id.
    const creatorMember = await trx
      .insertInto("workspace_members")
      .values({
        workspace_id: String(workspace.id),
        user_id: input.userId,
        trust_level: "admin",
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
      actorRow: Record<string, unknown>
      template: LoadedOfficialActorTemplate
    }> = []

    for (const template of officialActorTemplates) {
      const actorRow = await trx
        .insertInto("actors")
        .values({
          workspace_id: String(workspace.id),
          name: template.actorName,
          role: template.actorRole,
          title: template.actorTitle,
          avatar_file_id: template.actorAvatarFileId || null,
          avatar_emoji: template.actorAvatarEmoji || null,
          parent_id: null,
          can_represent_user: template.canRepresentUser,
          specialties: template.actorSpecialties,
          config: template.actorConfig as TableInsert<"actors">["config"],
          current_version: 1,
          created_by_workspace_member_id: String(creatorMember.id),
        })
        .returningAll()
        .executeTakeFirst()
      if (!actorRow) {
        throw new Error(`Failed to install actor ${template.actorName}`)
      }

      // P2 contract: bootstrap actors are workspace-open by default — write
      // the binding instead of relying on the legacy access_policy column.
      await setAccessPolicy(trx, {
        resourceType: "actor",
        resourceId: String(actorRow.id),
        workspaceId: String(workspace.id),
        policy: RELATIONSHIP_ACCESS_POLICY.WORKSPACE_OPEN,
        createdByWorkspaceMemberId: String(creatorMember.id),
      })

      const actorVersionResult = await trx
        .insertInto("actor_versions")
        .values({
          actor_id: String(actorRow.id),
          version: 1,
          name: template.actorName,
          role: template.actorRole,
          title: template.actorTitle,
          parent_id: null,
          can_represent_user: template.canRepresentUser,
          specialties: template.actorSpecialties,
          config:
            template.actorConfig as TableInsert<"actor_versions">["config"],
          created_by_workspace_member_id: String(creatorMember.id),
        })
        .returning("id")
        .executeTakeFirst()
      if (!actorVersionResult) {
        throw new Error(
          `Failed to create actor version for ${template.actorName}`
        )
      }
      const actorVersionId = actorVersionResult.id

      for (const doc of template.actorDocs) {
        await trx
          .insertInto("actor_version_docs")
          .values({
            actor_version_id: actorVersionId,
            doc_key: doc.key,
            title: doc.title,
            visibility: doc.visibility,
            priority: doc.priority,
            content_blocks: sql`${JSON.stringify(doc.content)}::jsonb`,
          })
          .execute()
      }

      await trx
        .insertInto("actor_source_refs")
        .values({
          actor_id: String(actorRow.id),
          source_catalog_item_id: template.packageId,
          source_catalog_version_id: template.versionId,
          sync_mode: "notify",
          baseline_actor_version: 1,
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
      workspace: mapWorkspaceRow(workspace),
      secretary: mapActorRow(
        chiefActor.actorRow,
        chiefActor.template.actorDocs
      ),
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
           SET download_count = download_count + 1,
               updated_at = NOW()
         WHERE id = ${templateId}`.execute(db)
    } catch (err) {
      console.warn(
        `[workspace.createWorkspace] best-effort download_count bump failed for catalog_item ${templateId}:`,
        err
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
    .selectFrom("workspace_members as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .selectAll("w")
    .select(["wm.id as current_workspace_member_id", "wm.trust_level"])
    .where("wm.user_id", "=", userId)
    .orderBy("w.created_at", "desc")
    .execute()
  return rows.map((row) => ({
    ...mapWorkspaceRow(row),
    currentWorkspaceMemberId: row.current_workspace_member_id ?? undefined,
    trustLevel: deriveWorkspaceTrustLevel(row),
  }))
}

export async function getWorkspaceById(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", workspaceId)
    .executeTakeFirst()
  return row ? mapWorkspaceRow(row) : null
}

export async function getWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string
): Promise<WorkspaceChiefActorPreference> {
  const member = await requireWorkspaceMemberRowByUserId(workspaceId, userId)
  const row = await db
    .selectFrom("workspace_member_preferences as pref")
    .innerJoin("workspace_members as wm", "wm.id", "pref.workspace_member_id")
    .leftJoin("actors as a", (join) =>
      join
        .onRef("a.id", "=", "pref.chief_actor_id")
        .onRef("a.workspace_id", "=", "wm.workspace_id")
        .on("a.is_active", "=", true)
    )
    .leftJoin(
      "file_assets as avatar_file",
      "avatar_file.id",
      "a.avatar_file_id"
    )
    .select([
      "wm.workspace_id",
      "wm.user_id",
      "wm.id as workspace_member_id",
      "pref.chief_actor_id",
      "pref.created_at",
      "pref.updated_at",
      "a.name as chief_actor_name",
      "a.role as chief_actor_role",
      "a.title as chief_actor_title",
      "avatar_file.id as chief_actor_avatar_file_id",
    ])
    .where("pref.workspace_member_id", "=", member.id)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    return {
      workspaceId,
      workspaceMemberId: member.id,
    }
  }

  return mapWorkspaceChiefActorPreferenceRow(row)
}

export async function updateWorkspaceChiefActorPreference(
  workspaceId: string,
  userId: string,
  chiefActorId?: string | null
): Promise<WorkspaceChiefActorPreference> {
  const member = await requireWorkspaceMemberRowByUserId(workspaceId, userId)
  if (!chiefActorId) {
    await db
      .deleteFrom("workspace_member_preferences")
      .where("workspace_member_id", "=", member.id)
      .execute()

    return {
      workspaceId,
      workspaceMemberId: member.id,
    }
  }

  const actorRow = await db
    .selectFrom("actors")
    .select("id")
    .where("id", "=", chiefActorId)
    .where("workspace_id", "=", workspaceId)
    .where("is_active", "=", true)
    .limit(1)
    .executeTakeFirst()

  if (!actorRow) {
    throw new Error("Chief actor is not available in this workspace")
  }

  await db
    .insertInto("workspace_member_preferences")
    .values({
      workspace_member_id: member.id,
      chief_actor_id: chiefActorId,
      created_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .onConflict((oc) =>
      oc.column("workspace_member_id").doUpdateSet({
        chief_actor_id: chiefActorId,
        updated_at: sql`NOW()`,
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
      updated_at: sql`NOW()`,
    })
    .where("id", "=", workspaceId)
    .returningAll()
    .executeTakeFirst()
  return row ? mapWorkspaceRow(row) : null
}

export async function checkMembership(workspaceId: string, userId: string) {
  const row = await db
    .selectFrom("workspaces as w")
    .leftJoin("workspace_members as wm", (join) =>
      join.onRef("wm.workspace_id", "=", "w.id").on("wm.user_id", "=", userId)
    )
    .select(["w.owner_id", "wm.user_id", "wm.trust_level"])
    .where("w.id", "=", workspaceId)
    .executeTakeFirst()
  return row ? deriveWorkspaceTrustLevel(row) : null
}

export async function addMember(input: AddMemberInput) {
  const result = await withDbTransaction(async (trx) => {
    const memberRow = await trx
      .insertInto("workspace_members")
      .values({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        trust_level: input.trustLevel,
      })
      .onConflict((oc) => oc.columns(["workspace_id", "user_id"]).doNothing())
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
      member: mapMemberRow(memberRow),
    }
  })

  if (!result) {
    return null
  }

  return result.member
}

export async function listMembers(workspaceId: string) {
  const accessMap = db
    .selectFrom("workspace_access_bindings")
    .select([
      "workspace_member_id",
      sql<string[]>`array_agg(access_key order by access_key)`.as(
        "access_keys"
      ),
    ])
    .groupBy(["workspace_member_id"])
    .as("access_map")

  const rows = await db
    .selectFrom("workspace_members as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .leftJoin(accessMap, (join) =>
      join.onRef("access_map.workspace_member_id", "=", "wm.id")
    )
    .select([
      "wm.id",
      "wm.workspace_id",
      "wm.user_id",
      "wm.trust_level",
      "w.owner_id",
      "wm.joined_at",
      "u.name as user_name",
      "u.email as user_email",
      "u.avatar_file_id",
      sql<
        string[]
      >`COALESCE(access_map.access_keys, ARRAY[]::workspace_access_bindings_access_key[])`.as(
        "access_keys"
      ),
    ])
    .where("wm.workspace_id", "=", workspaceId)
    .orderBy("wm.joined_at", "asc")
    .execute()
  return rows.map((row) => ({
    ...mapMemberRow(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_file_id ? getFileUrlById(row.avatar_file_id) : null,
    accessKeys: Array.isArray(row.access_keys) ? row.access_keys : [],
  }))
}

export async function listWorkspaceAccessBindings(workspaceId: string) {
  const rows = await db
    .selectFrom("workspace_access_bindings as wab")
    .innerJoin("workspace_members as wm", "wm.id", "wab.workspace_member_id")
    .innerJoin("workspaces as w", "w.id", "wm.workspace_id")
    .innerJoin("users as u", "u.id", "wm.user_id")
    .select([
      "wab.workspace_member_id",
      "wab.access_key",
      "wab.assigned_by_workspace_member_id",
      "wab.created_at",
      "wab.updated_at",
      "wm.id",
      "wm.workspace_id",
      "wm.user_id",
      "u.name as user_name",
      "u.email as user_email",
      "u.avatar_file_id",
      "w.owner_id",
      "wm.trust_level",
    ])
    .where("wm.workspace_id", "=", workspaceId)
    .orderBy("wab.access_key", "asc")
    .orderBy("wab.created_at", "asc")
    .execute()

  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    workspaceMemberId: row.workspace_member_id,
    userId: row.user_id,
    accessKey: row.access_key as WorkspaceAccessKey,
    assignedByWorkspaceMemberId: row.assigned_by_workspace_member_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trustLevel: deriveWorkspaceTrustLevel(row),
    userName: row.user_name,
    userEmail: row.user_email,
    avatarUrl: row.avatar_file_id ? getFileUrlById(row.avatar_file_id) : null,
  }))
}

export async function grantWorkspaceAccess(input: {
  workspaceId: string
  workspaceMemberId: string
  accessKey: WorkspaceAccessKey
  assignedByWorkspaceMemberId: string
}) {
  const membership = await getWorkspaceMemberRowById(input.workspaceMemberId)

  if (!membership || membership.workspace_id !== input.workspaceId) {
    throw new Error("Workspace member is not part of this workspace")
  }

  const row = await db
    .insertInto("workspace_access_bindings")
    .values({
      workspace_member_id: input.workspaceMemberId,
      access_key: input.accessKey,
      assigned_by_workspace_member_id: input.assignedByWorkspaceMemberId,
    })
    .onConflict((oc) =>
      oc.columns(["workspace_member_id", "access_key"]).doNothing()
    )
    .returningAll()
    .executeTakeFirst()

  if (!row) {
    throw new Error("Access already granted")
  }

  return {
    workspaceId: membership.workspace_id,
    workspaceMemberId: row.workspace_member_id,
    userId: membership.user_id,
    accessKey: row.access_key as WorkspaceAccessKey,
    assignedByWorkspaceMemberId: row.assigned_by_workspace_member_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function revokeWorkspaceAccess(
  workspaceId: string,
  workspaceMemberId: string,
  accessKey: WorkspaceAccessKey
) {
  const membership = await getWorkspaceMemberRowById(workspaceMemberId)
  if (!membership || membership.workspace_id !== workspaceId) {
    throw new Error("Access grant not found")
  }

  const row = await db
    .deleteFrom("workspace_access_bindings")
    .where("workspace_member_id", "=", workspaceMemberId)
    .where("access_key", "=", accessKey)
    .returning(["workspace_member_id", "access_key"])
    .executeTakeFirst()

  if (!row) {
    throw new Error("Access grant not found")
  }
}

// ── Row mappers ──

function mapWorkspaceRow(row: any) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    ownerId: row.owner_id,
    isTrusted: Boolean(row.is_trusted),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function mapActorRow(row: any, docs: ActorDoc[]) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    definition: {
      name: row.name,
      role: row.role,
      title: row.title,
      avatarFileId: row.avatar_file_id ?? undefined,
      parentId: row.parent_id ?? undefined,
      canRepresentUser: Boolean(row.can_represent_user),
      docs,
      specialties: Array.isArray(row.specialties) ? row.specialties : [],
      config: row.config
        ? typeof row.config === "string"
          ? JSON.parse(row.config)
          : row.config
        : {},
    },
    currentVersion: Number(row.current_version || 1),
    isActive: row.is_active,
    isPublicShared: Boolean(row.is_public_shared),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function mapMemberRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    trustLevel: deriveWorkspaceTrustLevel(row),
    accessKeys: Array.isArray(row.access_keys) ? row.access_keys : [],
    joinedAt: toIsoString(row.joined_at),
  }
}

function mapWorkspaceChiefActorPreferenceRow(
  row: any
): WorkspaceChiefActorPreference {
  const chiefActorId =
    row.chief_actor_id && row.chief_actor_name ? row.chief_actor_id : undefined

  return {
    workspaceId: row.workspace_id,
    workspaceMemberId: row.workspace_member_id,
    chiefActorId,
    chiefActor:
      chiefActorId && row.chief_actor_name
        ? {
            id: chiefActorId,
            name: row.chief_actor_name,
            role: row.chief_actor_role,
            title: row.chief_actor_title || row.chief_actor_role || "Actor",
            avatarUrl: row.chief_actor_avatar_file_id
              ? getFileUrlById(row.chief_actor_avatar_file_id)
              : undefined,
          }
        : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}
