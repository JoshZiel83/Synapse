import crypto from "node:crypto"
import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG } from "../../infrastructure/database/seeds/actors/index.js"
import {
  normalizeActorDocs,
  slugify,
  type ActorDoc,
  type ActorDocInput,
  type ActorRole,
} from "@synapse/shared"
import { ActorDocInputSchema } from "@synapse/shared/schemas"
import { seedWorkspaceCapabilityConversationTypePolicies } from "../capabilities/conversation-type-policies.js"
import { markWorkspaceDeleted } from "../soft-delete/orchestration.js"
import { insertWorkspaceAppRoot } from "../workspace-apps/repo.js"
import type {
  ActorRecord,
  ActorsConfig,
  ActorVersionsConfig,
  WorkspaceAccessKey,
  WorkspaceChiefActorPreferenceRow,
  WorkspaceTrustLevel,
} from "./repo.types.js"

/**
 * Workspace data-access layer (repo). The ONLY workspace (non-invite) file
 * besides repo.types that may touch the db client / SQL (guard-layering r8).
 * Every query lives here and returns camelCase domain records with Date kept;
 * serialization stays in presenter.ts (r3). Multi-statement transactions
 * (create/add/delete) open `withDbTransaction` HERE so the cross-module
 * trx-threaded side effects stay atomic — never split across the boundary.
 */

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

// ---------------------------------------------------------------------------
// MEMBER reads
// ---------------------------------------------------------------------------

export async function getWorkspaceMemberRowByUserId(
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

export async function getWorkspaceMemberRowById(workspaceMemberId: string) {
  return db
    .selectFrom("workspaceMembers")
    .select(["id", "workspaceId", "userId", "trustLevel", "joinedAt"])
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
}

// ---------------------------------------------------------------------------
// Official actor template helpers (executor-injectable; used inside the
// create-workspace transaction and threaded out to invite/repo.ts).
// ---------------------------------------------------------------------------

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

export function parseStoredActorDocs(value: unknown) {
  if (value === null || value === undefined) return []

  let docsValue: unknown = value
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(
        "workspace actor template docs must be a valid JSON array"
      )
    }
    try {
      docsValue = JSON.parse(value) as unknown
    } catch {
      throw new Error(
        "workspace actor template docs must be a valid JSON array"
      )
    }
  }

  if (!Array.isArray(docsValue)) {
    throw new Error("workspace actor template docs must be a JSON array")
  }

  const parsed = ActorDocInputSchema.array().safeParse(docsValue)
  if (!parsed.success) {
    throw new Error(
      "workspace actor template docs must contain actor doc inputs"
    )
  }

  return normalizeActorDocs(parsed.data as ActorDocInput[])
}

export function parseWorkspaceJsonRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || value === undefined) return {}

  let candidate: unknown = value
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} must be a valid JSON object`)
    }
    try {
      candidate = JSON.parse(value) as unknown
    } catch {
      throw new Error(`${label} must be a valid JSON object`)
    }
  }

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new Error(`${label} must be a JSON object`)
  }

  return candidate as Record<string, unknown>
}

function isOfficialChiefTemplate(row: {
  packageSlug: string
  actorConfig: unknown
}) {
  const config = parseWorkspaceJsonRecord(
    row.actorConfig,
    "workspace actor template config"
  )
  return (
    config.is_chief_actor === true ||
    row.packageSlug === DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG
  )
}

function normalizeActorRecord(row: {
  [K in keyof ActorRecord]: K extends "config"
    ? unknown
    : K extends "specialties"
      ? string[] | null
      : ActorRecord[K]
}): ActorRecord {
  return {
    id: row.id,
    role: row.role,
    title: row.title,
    avatarFileId: row.avatarFileId,
    avatarEmoji: row.avatarEmoji,
    parentId: row.parentId,
    canRepresentUser: row.canRepresentUser,
    config: parseWorkspaceJsonRecord(row.config, "workspace actor config"),
    specialties: Array.isArray(row.specialties) ? row.specialties : [],
    currentVersion: row.currentVersion,
    isPublicShared: row.isPublicShared,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
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
        parseWorkspaceJsonRecord(
          row.actorConfig,
          "workspace actor template config"
        ),
        isChiefActor
      ),
      isChiefActor,
    } satisfies LoadedOfficialActorTemplate
  })
}

// ---------------------------------------------------------------------------
// TRANSACTIONAL writes — the entire multi-statement tx (plus its cross-module
// trx-threaded side effects) lives in ONE repo fn that opens withDbTransaction.
// ---------------------------------------------------------------------------

export async function createWorkspaceTx(input: CreateWorkspaceInput) {
  const slug = generateSlug(input.name)

  return withDbTransaction(async (trx) => {
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
      const normalizedActorRow = normalizeActorRecord(actorRow)

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
        actorRow: normalizedActorRow,
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
      workspace,
      secretary: {
        row: chiefActor.actorRow,
        workspaceId: String(workspace.id),
        displayName: chiefActor.template.actorDisplayName,
        docs: chiefActor.template.actorDocs,
      },
      installedTemplatePackageIds: officialActorTemplates.map(
        (template) => template.packageId
      ),
    }
  })
}

/**
 * Bump catalog_items.download_count for one template id. Best-effort, run
 * post-commit one row at a time in id-sorted order by the service to avoid the
 * concurrent-create deadlock (see createWorkspace caller comment).
 */
export async function bumpCatalogDownloadCount(templateId: string) {
  await sql`
        UPDATE catalog_items
           SET download_count = download_count + 1
         WHERE id = ${templateId}`.execute(db)
}

export async function addMemberTx(input: AddMemberInput) {
  return withDbTransaction(async (trx) => {
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
      member: memberRow,
    }
  })
}

// ---------------------------------------------------------------------------
// WORKSPACE reads / writes
// ---------------------------------------------------------------------------

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
  return rows
}

export async function getWorkspaceById(workspaceId: string) {
  const row = await db
    .selectFrom("workspaces")
    .selectAll()
    .where("id", "=", workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  return row ?? null
}

export async function updateWorkspaceRow(
  workspaceId: string,
  updates: { name?: string; description?: string }
) {
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
  return row ?? null
}

/**
 * Live-check for delete: returns true when the workspace exists and is not
 * already soft-deleted, false otherwise.
 */
export async function isWorkspaceLive(workspaceId: string): Promise<boolean> {
  const live = await db
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
  return Boolean(live)
}

/**
 * Run the markWorkspaceDeleted orchestration in one transaction so its
 * soft-delete of every workspace-scoped root + revokes stays atomic.
 */
export async function markWorkspaceDeletedTx(workspaceId: string) {
  await withDbTransaction((trx) => markWorkspaceDeleted(trx, workspaceId))
}

export async function checkMembershipRow(workspaceId: string, userId: string) {
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
  return row ?? null
}

// ---------------------------------------------------------------------------
// CHIEF-ACTOR-PREF
// ---------------------------------------------------------------------------

export async function getChiefActorPreferenceRow(
  workspaceMemberId: string
): Promise<WorkspaceChiefActorPreferenceRow | undefined> {
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
    .where("pref.workspaceMemberId", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
  return row as WorkspaceChiefActorPreferenceRow | undefined
}

/**
 * Clearing a preference physically removes the child row; routed through the
 * SECURITY DEFINER fn since sd_reject_delete forbids a naked DELETE (§7.5).
 */
export async function clearMemberPreferences(workspaceMemberId: string) {
  await sql`SELECT sd_clear_member_preferences(${workspaceMemberId}::uuid)`.execute(
    db
  )
}

export async function findActiveActorInWorkspace(
  workspaceId: string,
  actorId: string
) {
  return db
    .selectFrom("actors as actor")
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select("actor.id")
    .where("actor.id", "=", actorId)
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .limit(1)
    .executeTakeFirst()
}

export async function upsertChiefActorPreference(
  workspaceMemberId: string,
  chiefActorId: string
) {
  await db
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
}

// ---------------------------------------------------------------------------
// ACCESS BINDINGS
// ---------------------------------------------------------------------------

export async function listMembersWithAccess(workspaceId: string) {
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
  return rows
}

export async function listWorkspaceAccessBindingsRows(workspaceId: string) {
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
  return rows
}

export async function getActiveAccessBindingStatus(
  workspaceMemberId: string,
  accessKey: WorkspaceAccessKey
) {
  return db
    .selectFrom("workspaceAccessBindings")
    .select(["status"])
    .where("workspaceMemberId", "=", workspaceMemberId)
    .where("accessKey", "=", accessKey)
    .executeTakeFirst()
}

export async function upsertAccessBinding(input: {
  workspaceMemberId: string
  accessKey: WorkspaceAccessKey
  assignedByWorkspaceMemberId: string
}) {
  // Re-grant must revive a previously-revoked row (design §6.2): the composite
  // PK is kept, so onConflict updates status back to 'active' rather than
  // doNothing (which would let a revoked row permanently block re-granting).
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
  return row ?? null
}

/**
 * Soft revoke (design §6.2 option A): flip status instead of hard-deleting the
 * row (which sd_reject_delete forbids). Re-granting revives the row. Returns
 * the revoked row's identifiers, or undefined when no active binding matched.
 */
export async function softRevokeAccessBinding(
  workspaceMemberId: string,
  accessKey: WorkspaceAccessKey
) {
  return db
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
}
