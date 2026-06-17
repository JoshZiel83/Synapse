/**
 * Model-groups module repo.
 *
 * Owns the resolver's read queries against the DB client (guard r8 exempts
 * files whose basename matches /repo[^/]*\.ts$/, so this file MAY import `db`).
 * Repo functions return camelCase DOMAIN records and KEEP Date objects — time
 * serialization belongs to presenters (guard r3), not the repo.
 */

import { sql } from "kysely"
import {
  db,
  withDbTransaction,
  type KyselyDb,
} from "../../infrastructure/database/kysely.js"
import type { SubjectRef } from "@synapse/shared"
import type { ModelGroupOwnerType } from "@synapse/shared/types"
import {
  actorSubject,
  listAuthorizedResourceIds,
  workspaceMemberSubject,
} from "../access/service.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import type {
  ModelBindingVersionsFeatures,
  ModelBindingVersionsProviderOptions,
  ModelGroupsAttemptPolicy,
} from "./repo.types.js"
import type {
  ActorModelGroupAssignmentRow,
  ModelGroupGrantDbRow,
  ModelGroupItemVersionRow,
  ModelGroupRow,
} from "./presenter.js"

type RoutingStrategy = "weighted_random" | "priority_failover"

export type ModelGroupCandidateRow = {
  id: string
  ownerType: "platform" | "workspace" | "workspace_member"
  ownerWorkspaceId: string | null
  ownerWorkspaceMemberId: string | null
  name: string
  routingStrategy: RoutingStrategy
  attemptPolicy: Record<string, unknown> | null
  isDefault: boolean
  isEnabled: boolean
  createdAt: Date
  updatedAt: Date
}

export type ModelGroupItemRow = {
  groupId: string
  groupName: string
  routingStrategy: RoutingStrategy
  attemptPolicy: Record<string, unknown> | null
  itemId: string
  priority: number
  weight: number
  itemEnabled: boolean
  bindingId: string
  displayName: string
  currentVersionId: string | null
  providerKind: string | null
  vendor: string | null
  apiKey: string | null
  baseUrl: string | null
  modelName: string | null
  maxOutputTokens: number | null
  capabilityTags: string[] | null
  features: Record<string, unknown> | null
  providerOptions: Record<string, unknown> | null
  requestTimeoutMs: number | null
  maxRetries: number | null
}

export type ListCandidateGroupRowsResult = {
  groups: ModelGroupCandidateRow[]
  assignments: { groupId: string; priority: number }[]
  workspaceDefaultGroupId?: string
  platformDefaultGroupId?: string
  workspaceMemberDefaultGroupId?: string
}

export function decodeNullableModelGroupJsonRecord(
  value: unknown
): Record<string, unknown> | null {
  if (value === null || typeof value === "undefined") return null
  const parsed =
    typeof value === "string" ? parseModelGroupJsonRecord(value) : value
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("model group JSON record must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function parseModelGroupJsonRecord(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error("model group JSON record must be valid JSON")
  }
}

export function normalizeModelGroupRowJson<
  T extends { attemptPolicy?: unknown },
>(
  row: T
): Omit<T, "attemptPolicy"> & {
  attemptPolicy: Record<string, unknown> | null
} {
  const normalized = row as Omit<T, "attemptPolicy"> & {
    attemptPolicy: Record<string, unknown> | null
  }
  normalized.attemptPolicy = decodeNullableModelGroupJsonRecord(
    row.attemptPolicy
  )
  return normalized
}

export function normalizeModelGroupItemJson<
  T extends { features?: unknown; providerOptions?: unknown },
>(
  row: T
): Omit<T, "features" | "providerOptions"> & {
  features: Record<string, unknown> | null
  providerOptions: Record<string, unknown> | null
} {
  const normalized = row as Omit<T, "features" | "providerOptions"> & {
    features: Record<string, unknown> | null
    providerOptions: Record<string, unknown> | null
  }
  normalized.features = decodeNullableModelGroupJsonRecord(row.features)
  normalized.providerOptions = decodeNullableModelGroupJsonRecord(
    row.providerOptions
  )
  return normalized
}

/**
 * Merge of the actor- and (optional) workspace-member-scoped authorized
 * model_group ids. listAuthorizedResourceIds is the access-service injectable
 * (takes its executor explicitly), so it threads `run` straight through.
 */
export async function listAuthorizedModelGroupIds(
  params: { actorId: string; workspaceMemberId?: string },
  run: KyselyDb = db
): Promise<Set<string>> {
  const authorized = new Set<string>()

  const actorResults = await listAuthorizedResourceIds(run, {
    subject: actorSubject(params.actorId),
    action: "model_group.use",
  })
  for (const id of actorResults) {
    authorized.add(id)
  }

  if (params.workspaceMemberId) {
    const userResults = await listAuthorizedResourceIds(run, {
      subject: workspaceMemberSubject(params.workspaceMemberId),
      action: "model_group.use",
    })
    for (const id of userResults) {
      authorized.add(id)
    }
  }

  return authorized
}

/**
 * The 5 candidate-group reads (authorized groups, actor assignments, and the
 * workspace / platform / workspace-member default ids). Returns raw camelCase
 * rows + the default ids; the ranking comparator stays in resolver.ts as
 * business logic.
 */
export async function listCandidateGroupRows(
  params: {
    actorId: string
    workspaceId: string
    workspaceMemberId?: string
    authorizedGroupIds: readonly string[]
  },
  run: KyselyDb = db
): Promise<ListCandidateGroupRowsResult> {
  const [
    groupsResult,
    assignmentsResult,
    workspaceDefaultResult,
    platformDefaultResult,
    workspaceMemberDefaultResult,
  ] = await Promise.all([
    params.authorizedGroupIds.length > 0
      ? run
          .selectFrom("modelGroupsLive")
          .selectAll()
          .where("isEnabled", "=", true)
          .where("id", "in", Array.from(params.authorizedGroupIds))
          .execute()
      : Promise.resolve([] as ModelGroupCandidateRow[]),
    run
      .selectFrom("actorModelGroupAssignments")
      .select(["groupId", "priority"])
      .where("actorId", "=", params.actorId)
      .orderBy("priority", "asc")
      .execute(),
    run
      .selectFrom("modelGroupsLive")
      .select("id")
      .where("ownerType", "=", "workspace")
      .where("ownerWorkspaceId", "=", params.workspaceId)
      .where("isDefault", "=", true)
      .where("isEnabled", "=", true)
      .executeTakeFirst(),
    run
      .selectFrom("modelGroupsLive")
      .select("id")
      .where("ownerType", "=", "platform")
      .where("isDefault", "=", true)
      .where("isEnabled", "=", true)
      .executeTakeFirst(),
    params.workspaceMemberId
      ? run
          .selectFrom("modelGroupsLive")
          .select("id")
          .where("ownerType", "=", "workspace_member")
          .where("ownerWorkspaceMemberId", "=", params.workspaceMemberId)
          .where("isDefault", "=", true)
          .where("isEnabled", "=", true)
          .executeTakeFirst()
      : Promise.resolve(undefined),
  ])

  return {
    groups: (groupsResult as ModelGroupCandidateRow[]).map(
      normalizeModelGroupRowJson
    ),
    assignments: assignmentsResult as Array<{
      groupId: string
      priority: number
    }>,
    workspaceDefaultGroupId: workspaceDefaultResult?.id || undefined,
    platformDefaultGroupId: platformDefaultResult?.id || undefined,
    workspaceMemberDefaultGroupId:
      workspaceMemberDefaultResult?.id || undefined,
  }
}

/**
 * Flat read: model_bindings (the item) joined to its current version row.
 * Reads go through the soft-delete _live view so deleted bindings are excluded.
 * The field-coalescing/normalization travels with the query so the repo emits
 * clean domain records.
 */
export async function listGroupItemRows(
  groupId: string,
  run: KyselyDb = db
): Promise<ModelGroupItemRow[]> {
  const result = await run
    .selectFrom("modelBindingsLive as mb")
    .innerJoin("modelGroupsLive as mg", "mg.id", "mb.groupId")
    .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
    .select([
      "mg.id as groupId",
      "mg.name as groupName",
      "mg.routingStrategy",
      "mg.attemptPolicy",
      "mb.id as itemId",
      "mb.priority",
      "mb.weight",
      "mb.isEnabled as itemEnabled",
      "mb.id as bindingId",
      "mb.displayName",
      "mb.currentVersionId",
      "v.providerKind",
      "v.vendor",
      "v.apiKey",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
    ])
    .where("mb.groupId", "=", groupId)
    .where("mb.isEnabled", "=", true)
    .where("mb.currentVersionId", "is not", null)
    .execute()
  return result.map((row) => ({
    groupId: row.groupId || "",
    groupName: row.groupName || "",
    routingStrategy: row.routingStrategy || "priority_failover",
    attemptPolicy: decodeNullableModelGroupJsonRecord(row.attemptPolicy),
    itemId: row.itemId || "",
    priority: row.priority ?? 0,
    weight: row.weight ?? 1,
    itemEnabled: row.itemEnabled ?? false,
    bindingId: row.bindingId || row.itemId || "",
    displayName: row.displayName || "",
    currentVersionId: row.currentVersionId,
    providerKind: row.providerKind,
    vendor: row.vendor,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl,
    modelName: row.modelName,
    maxOutputTokens: row.maxOutputTokens,
    capabilityTags: Array.isArray(row.capabilityTags)
      ? row.capabilityTags.filter(
          (item): item is string => typeof item === "string"
        )
      : null,
    features: decodeNullableModelGroupJsonRecord(row.features),
    providerOptions: decodeNullableModelGroupJsonRecord(row.providerOptions),
    requestTimeoutMs: row.requestTimeoutMs,
    maxRetries: row.maxRetries,
  }))
}

// ---------------------------------------------------------------------------
// model-groups/service.ts query extraction (guard r8).
//
// Each fn keeps the service's WHERE clauses / raw-sql fragments / JSONB casts
// verbatim and returns camelCase domain rows with Date objects intact (the
// presenter serializes time, not the repo). Multi-statement write flows that
// the service ran without an explicit transaction are wrapped in ONE
// withDbTransaction here so they stay atomic.
// ---------------------------------------------------------------------------

/** Shared OR-filter for "is this group visible in the workspace" reads. */
function applyWorkspaceGroupVisibility(
  eb: any,
  workspaceId: string,
  includeWorkspaceMember: boolean
) {
  const branches = [
    eb.and([
      eb("mg.ownerType", "=", "workspace"),
      eb("mg.ownerWorkspaceId", "=", workspaceId),
    ]),
    eb("mgs.kind", "=", "platform"),
    eb.and([
      eb("mgs.kind", "=", "workspace"),
      eb("mgs.workspaceId", "=", workspaceId),
    ]),
  ]
  if (includeWorkspaceMember) {
    branches.push(
      eb.and([
        eb("mgs.kind", "=", "workspace_member"),
        sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.id = mgs.workspace_member_id
              AND wm.workspace_id = ${workspaceId}
          )`,
      ])
    )
  }
  branches.push(
    eb.and([
      eb("mgs.kind", "=", "actor"),
      eb("mgs.workspaceId", "=", workspaceId),
    ])
  )
  return eb.or(branches)
}

export async function listPlatformModelGroupRows(
  run: KyselyDb = db
): Promise<ModelGroupRow[]> {
  const result = await run
    .selectFrom("modelGroups")
    .selectAll()
    .where("ownerType", "=", "platform")
    .where("isEnabled", "=", true)
    .orderBy("isDefault", "desc")
    .orderBy("name")
    .execute()
  return result.map((row) => normalizeModelGroupRowJson(row) as ModelGroupRow)
}

export async function listPlatformModelGroupImportRows(
  run: KyselyDb = db
): Promise<
  Array<{ id: string; name: string; isDefault: boolean; isEnabled: boolean }>
> {
  const rows = await run
    .selectFrom("modelGroups")
    .select(["id", "name", "isDefault", "isEnabled"])
    .where("ownerType", "=", "platform")
    .where("deletedAt", "is", null)
    .execute()
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    isDefault: Boolean(row.isDefault),
    isEnabled: Boolean(row.isEnabled),
  }))
}

export async function listWorkspaceModelGroupRows(
  workspaceId: string,
  run: KyselyDb = db
): Promise<ModelGroupRow[]> {
  const result = await run
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .selectAll("mg")
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as("owner_rank")
    )
    .where("mg.isEnabled", "=", true)
    .where((eb) => applyWorkspaceGroupVisibility(eb, workspaceId, true))
    .orderBy("owner_rank")
    .orderBy("mg.isDefault", "desc")
    .orderBy("mg.name")
    .execute()
  return result.map((row) => normalizeModelGroupRowJson(row) as ModelGroupRow)
}

export async function listWorkspaceMemberOwnedModelGroupRows(
  workspaceMemberId: string,
  run: KyselyDb = db
): Promise<ModelGroupRow[]> {
  const result = await run
    .selectFrom("modelGroups")
    .selectAll()
    .where("ownerType", "=", "workspace_member")
    .where("ownerWorkspaceMemberId", "=", workspaceMemberId)
    .where("isEnabled", "=", true)
    .orderBy("isDefault", "desc")
    .orderBy("name")
    .execute()
  return result.map((row) => normalizeModelGroupRowJson(row) as ModelGroupRow)
}

export async function getModelGroupRow(
  groupId: string,
  run: KyselyDb = db
): Promise<ModelGroupRow | undefined> {
  const row = await run
    .selectFrom("modelGroups")
    .selectAll()
    .where("id", "=", groupId)
    .limit(1)
    .executeTakeFirst()
  return row ? (normalizeModelGroupRowJson(row) as ModelGroupRow) : undefined
}

export async function getModelGroupDetailRows(
  groupId: string,
  run: KyselyDb = db
): Promise<{ items: any[]; grants: ModelGroupGrantDbRow[] }> {
  const [itemsResult, grantsResult] = await Promise.all([
    run
      .selectFrom("modelBindingsLive as mb")
      .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
      .select([
        "mb.id as itemId",
        "mb.groupId",
        "mb.priority",
        "mb.weight",
        "mb.isEnabled as itemEnabled",
        "mb.createdAt",
        "mb.updatedAt",
        "mb.id as bindingId",
        "mb.displayName",
        "mb.currentVersionId",
        "v.version",
        "v.providerKind",
        "v.vendor",
        "v.baseUrl",
        "v.modelName",
        "v.maxOutputTokens",
        "v.capabilityTags",
        "v.features",
        "v.providerOptions",
        "v.requestTimeoutMs",
        "v.maxRetries",
      ])
      .where("mb.groupId", "=", groupId)
      .where("mb.deletedAt", "is", null)
      .orderBy("mb.priority", "asc")
      .orderBy("mb.displayName")
      .execute(),
    run
      .selectFrom("modelGroupGrants as mgg")
      .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
      .select([
        "mgg.id",
        "mgg.groupId",
        "mgg.status",
        "mgg.reason",
        "mgg.createdAt",
        "mgg.revokedAt",
        "mgg.subjectId",
        "mgg.grantedByWorkspaceMemberId",
        "mgs.kind as mgsKind",
        "mgs.workspaceId as mgsWorkspaceId",
        "mgs.workspaceMemberId as mgsWorkspaceMemberId",
        "mgs.actorId as mgsActorId",
      ])
      .where("mgg.groupId", "=", groupId)
      .orderBy("mgg.createdAt", "desc")
      .execute(),
  ])
  return {
    items: itemsResult.map((row) => normalizeModelGroupItemJson(row)),
    grants: grantsResult as ModelGroupGrantDbRow[],
  }
}

export async function isModelGroupGrantedInWorkspace(
  groupId: string,
  workspaceId: string,
  run: KyselyDb = db
): Promise<boolean> {
  const row = await run
    .selectFrom("modelGroups as mg")
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select("mg.id")
    .where("mg.id", "=", groupId)
    .where("mg.isEnabled", "=", true)
    .where((eb) => applyWorkspaceGroupVisibility(eb, workspaceId, true))
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/**
 * Returns the matched assignable model_group ids for the given candidate ids;
 * the service compares the count to the requested set. The actor branch adds
 * an optional actorId predicate.
 */
export async function listAssignableModelGroupIds(
  workspaceId: string,
  groupIds: string[],
  actorId: string | undefined,
  run: KyselyDb = db
): Promise<string[]> {
  const result = await run
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select("mg.id")
    .where("mg.id", "in", groupIds)
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "workspace_member"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM workspace_members wm
            WHERE wm.id = mgs.workspace_member_id
              AND wm.workspace_id = ${workspaceId}
          )`,
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspaceId", "=", workspaceId),
          actorId ? eb("mgs.actorId", "=", actorId) : sql<boolean>`TRUE`,
        ]),
      ])
    )
    .execute()
  return result.map((row) => row.id as string)
}

export async function listVisibleActorModelGroupRows(
  actorId: string,
  workspaceId: string,
  run: KyselyDb = db
): Promise<ModelGroupRow[]> {
  const result = await run
    .selectFrom("modelGroups as mg")
    .distinct()
    .leftJoin("modelGroupGrants as mgg", (join) =>
      join.onRef("mgg.groupId", "=", "mg.id").on("mgg.status", "=", "active")
    )
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .selectAll("mg")
    .select(
      sql<number>`CASE mg.owner_type
        WHEN 'workspace' THEN 0
        WHEN 'platform' THEN 1
        ELSE 2
      END`.as("owner_rank")
    )
    .where("mg.isEnabled", "=", true)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        eb("mgs.kind", "=", "platform"),
        eb.and([
          eb("mgs.kind", "=", "workspace"),
          eb("mgs.workspaceId", "=", workspaceId),
        ]),
        eb.and([
          eb("mgs.kind", "=", "actor"),
          eb("mgs.workspaceId", "=", workspaceId),
          eb("mgs.actorId", "=", actorId),
        ]),
      ])
    )
    .orderBy("owner_rank")
    .orderBy("mg.isDefault", "desc")
    .orderBy("mg.name")
    .execute()
  return result.map((row) => normalizeModelGroupRowJson(row) as ModelGroupRow)
}

export async function listModelGroupGrantDbRows(
  groupId: string,
  run: KyselyDb = db
): Promise<ModelGroupGrantDbRow[]> {
  const result = await run
    .selectFrom("modelGroupGrants as mgg")
    .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
    .select([
      "mgg.id",
      "mgg.groupId",
      "mgg.status",
      "mgg.reason",
      "mgg.createdAt",
      "mgg.revokedAt",
      "mgg.subjectId",
      "mgg.grantedByWorkspaceMemberId",
      "mgs.kind as mgsKind",
      "mgs.workspaceId as mgsWorkspaceId",
      "mgs.workspaceMemberId as mgsWorkspaceMemberId",
      "mgs.actorId as mgsActorId",
    ])
    .where("mgg.groupId", "=", groupId)
    .orderBy("mgg.createdAt", "desc")
    .execute()
  return result as ModelGroupGrantDbRow[]
}

// --- existence / validation reads (ensure*) ---

export async function workspaceExists(
  workspaceId: string,
  run: KyselyDb = db
): Promise<boolean> {
  const row = await run
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function getWorkspaceMemberWorkspaceId(
  workspaceMemberId: string,
  run: KyselyDb = db
): Promise<{ id: string; workspaceId: string } | undefined> {
  return await run
    .selectFrom("workspaceMembers")
    .select(["id", "workspaceId"])
    .where("id", "=", workspaceMemberId)
    .limit(1)
    .executeTakeFirst()
}

export async function actorExistsInWorkspace(
  actorId: string,
  workspaceId: string,
  run: KyselyDb = db
): Promise<boolean> {
  const row = await run
    .selectFrom("actors as actor")
    .innerJoin("workspaceApps as app", "app.id", "actor.id")
    .select("actor.id")
    .where("actor.id", "=", actorId)
    .where("app.workspaceId", "=", workspaceId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/**
 * Resolve the active-grant duplicate check: returns true when an active
 * model_group_grants row already targets the given subject id for the group.
 */
export async function activeGrantExistsForSubject(
  groupId: string,
  subjectId: string,
  run: KyselyDb = db
): Promise<boolean> {
  const row = await run
    .selectFrom("modelGroupGrants")
    .select("groupId")
    .where("groupId", "=", groupId)
    .where("status", "=", "active")
    .where("subjectId", "=", subjectId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

// --- actor model-group assignment reads/writes ---

export async function listActorModelGroupAssignmentRows(
  actorId: string,
  workspaceId: string | undefined,
  run: KyselyDb = db
): Promise<ActorModelGroupAssignmentRow[]> {
  let statement = run
    .selectFrom("actorModelGroupAssignments as amga")
    .innerJoin("modelGroups as mg", "mg.id", "amga.groupId")
    .select([
      "amga.actorId",
      "amga.groupId",
      "amga.priority",
      "amga.createdAt",
      "mg.name as groupName",
      "mg.routingStrategy",
      "mg.isDefault",
      "mg.ownerWorkspaceId as workspaceId",
      "mg.ownerType",
      "mg.ownerWorkspaceMemberId",
    ])
    .where("amga.actorId", "=", actorId)
    .where("mg.isEnabled", "=", true)

  if (workspaceId) {
    statement = statement.where((eb) =>
      eb.or([
        eb.and([
          eb("mg.ownerType", "=", "workspace"),
          eb("mg.ownerWorkspaceId", "=", workspaceId),
        ]),
        sql<boolean>`EXISTS (
          SELECT 1
          FROM model_group_grants mgg
          JOIN access_subjects mgs2 ON mgs2.id = mgg.subject_id
          WHERE mgg.group_id = mg.id
            AND mgg.status = 'active'
            AND (
              mgs2.kind = 'platform'
              OR (mgs2.kind = 'workspace' AND mgs2.workspace_id = ${workspaceId})
              OR (
                mgs2.kind = 'workspace_member'
                AND EXISTS (
                  SELECT 1
                  FROM workspace_members wm
                  WHERE wm.id = mgs2.workspace_member_id
                    AND wm.workspace_id = ${workspaceId}
                )
              )
              OR (mgs2.kind = 'actor' AND mgs2.workspace_id = ${workspaceId})
            )
        )`,
      ])
    )
  }

  const rows = await statement.orderBy("amga.priority", "asc").execute()
  return rows.map((row) => row as ActorModelGroupAssignmentRow)
}

/**
 * Atomically replace an actor's model-group assignments: the
 * sd_replace_actor_model_groups SECURITY DEFINER proc (clears existing rows)
 * followed by the new inserts run in ONE transaction so a partial set is never
 * left behind.
 */
export async function replaceActorModelGroups(
  actorId: string,
  groups: { groupId: string; priority: number }[]
): Promise<void> {
  await withDbTransaction(async (trx) => {
    await sql`SELECT sd_replace_actor_model_groups(${actorId}::uuid)`.execute(
      trx
    )
    for (const group of groups) {
      await trx
        .insertInto("actorModelGroupAssignments")
        .values({
          actorId: actorId,
          groupId: group.groupId,
          priority: group.priority,
        })
        .execute()
    }
  })
}

// --- item / version reads ---

export async function getModelGroupItemForUpdate(
  itemId: string,
  groupId: string,
  run: KyselyDb = db
) {
  const row = await run
    .selectFrom("modelBindingsLive as mb")
    .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
    .select([
      "mb.id as itemId",
      "mb.groupId",
      "mb.priority",
      "mb.weight",
      "mb.isEnabled as itemEnabled",
      "mb.displayName",
      "mb.currentVersionId",
      "v.version",
      "v.providerKind",
      "v.vendor",
      "v.apiKey",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
    ])
    .where("mb.id", "=", itemId)
    .where("mb.groupId", "=", groupId)
    .where("mb.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return row ? normalizeModelGroupItemJson(row) : undefined
}

export async function getModelGroupItemFullRow(
  itemId: string,
  run: KyselyDb = db
) {
  const row = await run
    .selectFrom("modelBindingsLive as mb")
    .leftJoin("modelBindingVersions as v", "v.id", "mb.currentVersionId")
    .select([
      "mb.id as itemId",
      "mb.groupId",
      "mb.priority",
      "mb.weight",
      "mb.isEnabled as itemEnabled",
      "mb.createdAt",
      "mb.updatedAt",
      "mb.id as bindingId",
      "mb.displayName",
      "mb.currentVersionId",
      "v.version",
      "v.providerKind",
      "v.vendor",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
    ])
    .where("mb.id", "=", itemId)
    .limit(1)
    .executeTakeFirstOrThrow()
  return normalizeModelGroupItemJson(row)
}

export async function modelGroupItemExists(
  itemId: string,
  groupId: string,
  run: KyselyDb = db
): Promise<boolean> {
  const item = await run
    .selectFrom("modelBindingsLive as mb")
    .select(["mb.id", "mb.isEnabled as itemEnabled"])
    .where("mb.id", "=", itemId)
    .where("mb.groupId", "=", groupId)
    .where("mb.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return Boolean(item)
}

export async function bindingExistsForVersions(
  itemId: string,
  groupId: string | undefined,
  run: KyselyDb = db
): Promise<boolean> {
  let bindingLookup = run
    .selectFrom("modelBindingsLive")
    .select("id")
    .where("id", "=", itemId)
    .where("deletedAt", "is", null)
  if (groupId) {
    bindingLookup = bindingLookup.where("groupId", "=", groupId)
  }
  const bindingRow = await bindingLookup.limit(1).executeTakeFirst()
  return Boolean(bindingRow)
}

export async function listBindingVersionRows(
  itemId: string,
  run: KyselyDb = db
): Promise<ModelGroupItemVersionRow[]> {
  const rows = await run
    .selectFrom("modelBindingVersions as v")
    .select([
      "v.id",
      "v.bindingId",
      "v.version",
      "v.providerKind",
      "v.vendor",
      "v.baseUrl",
      "v.modelName",
      "v.maxOutputTokens",
      "v.capabilityTags",
      "v.features",
      "v.providerOptions",
      "v.requestTimeoutMs",
      "v.maxRetries",
      "v.createdAt",
    ])
    .where("v.bindingId", "=", itemId)
    .orderBy("v.version", "desc")
    .execute()
  return rows.map((row) =>
    normalizeModelGroupItemJson(row)
  ) as ModelGroupItemVersionRow[]
}

export async function getBindingVersionVendorModel(
  bindingVersionId: string,
  run: KyselyDb = db
): Promise<{ vendor: string | null; modelName: string | null } | undefined> {
  const versionRow = await run
    .selectFrom("modelBindingVersions")
    .select(["vendor", "modelName"])
    .where("id", "=", bindingVersionId)
    .limit(1)
    .executeTakeFirst()
  if (!versionRow) return undefined
  return {
    vendor: (versionRow.vendor as string | null) ?? null,
    modelName: (versionRow.modelName as string | null) ?? null,
  }
}

// --- group writes ---

export async function clearDefaultModelGroups(
  ownerType: ModelGroupOwnerType,
  ownerWorkspaceId: string | null,
  ownerWorkspaceMemberId: string | null,
  run: KyselyDb = db
): Promise<void> {
  if (ownerType === "platform") {
    await run
      .updateTable("modelGroups")
      .set({ isDefault: false })
      .where("ownerType", "=", "platform")
      .where("isDefault", "=", true)
      .execute()
    return
  }
  if (ownerType === "workspace") {
    await run
      .updateTable("modelGroups")
      .set({ isDefault: false })
      .where("ownerType", "=", "workspace")
      .where("ownerWorkspaceId", "=", ownerWorkspaceId)
      .where("isDefault", "=", true)
      .execute()
    return
  }
  await run
    .updateTable("modelGroups")
    .set({ isDefault: false })
    .where("ownerType", "=", "workspace_member")
    .where("ownerWorkspaceMemberId", "=", ownerWorkspaceMemberId)
    .where("isDefault", "=", true)
    .execute()
}

/**
 * createModelGroup's write flow as ONE transaction: optional clear-existing
 * default, insert the group, upsert the default-grant subject, insert the
 * default grant. The subject upsert + grant insert (cross-module side effect)
 * must commit atomically with the group insert.
 */
export async function insertModelGroupWithDefaultGrant(params: {
  clearDefault: {
    ownerType: ModelGroupOwnerType
    ownerWorkspaceId: string | null
    ownerWorkspaceMemberId: string | null
  } | null
  groupValues: {
    ownerType: ModelGroupOwnerType
    ownerWorkspaceId: string | null
    ownerWorkspaceMemberId: string | null
    name: string
    description: string
    routingStrategy: RoutingStrategy
    attemptPolicy: ModelGroupsAttemptPolicy
    isDefault: boolean
    isEnabled: boolean
    createdByWorkspaceMemberId: string | null
  }
  defaultGrantSubjectRef: SubjectRef
  grantedByWorkspaceMemberId: string | null
}): Promise<ModelGroupRow> {
  return await withDbTransaction(async (trx) => {
    if (params.clearDefault) {
      await clearDefaultModelGroups(
        params.clearDefault.ownerType,
        params.clearDefault.ownerWorkspaceId,
        params.clearDefault.ownerWorkspaceMemberId,
        trx
      )
    }
    const row = await trx
      .insertInto("modelGroups")
      .values({
        ownerType: params.groupValues.ownerType,
        ownerWorkspaceId: params.groupValues.ownerWorkspaceId,
        ownerWorkspaceMemberId: params.groupValues.ownerWorkspaceMemberId,
        name: params.groupValues.name,
        description: params.groupValues.description,
        routingStrategy: params.groupValues.routingStrategy,
        attemptPolicy: params.groupValues.attemptPolicy,
        isDefault: params.groupValues.isDefault,
        isEnabled: params.groupValues.isEnabled,
        createdByWorkspaceMemberId:
          params.groupValues.createdByWorkspaceMemberId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const subjectId = await upsertAccessSubject(
      trx,
      params.defaultGrantSubjectRef
    )
    await trx
      .insertInto("modelGroupGrants")
      .values({
        groupId: row.id,
        subjectId: subjectId,
        status: "active",
        grantedByWorkspaceMemberId: params.grantedByWorkspaceMemberId || null,
        reason: "default_group_scope",
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return normalizeModelGroupRowJson(row) as ModelGroupRow
  })
}

export async function updateModelGroupRow(
  groupId: string,
  updateData: Record<string, unknown>,
  run: KyselyDb = db
): Promise<ModelGroupRow | undefined> {
  const row = await run
    .updateTable("modelGroups")
    .set(updateData as any)
    .where("id", "=", groupId)
    .returningAll()
    .executeTakeFirst()
  return row ? (normalizeModelGroupRowJson(row) as ModelGroupRow) : undefined
}

/**
 * deleteModelGroup's cascade as ONE transaction: soft-delete the group,
 * soft-delete its bindings, then run the sd_replace_group_actor_assignments
 * SECURITY DEFINER proc. NOW() and the proc stay raw.
 */
export async function softDeleteModelGroupCascade(
  groupId: string
): Promise<void> {
  await withDbTransaction(async (trx) => {
    await trx
      .updateTable("modelGroups")
      .set({
        isEnabled: false,
        isDefault: false,
        deletedAt: sql`NOW()`,
      })
      .where("id", "=", groupId)
      .execute()
    await trx
      .updateTable("modelBindings")
      .set({
        isEnabled: false,
        deletedAt: sql`NOW()`,
      })
      .where("groupId", "=", groupId)
      .execute()
    await sql`SELECT sd_replace_group_actor_assignments(${groupId}::uuid)`.execute(
      trx
    )
  })
}

// --- item writes ---

/**
 * addModelItem's write flow as ONE transaction: insert the binding, insert
 * version 1, then point the binding's currentVersionId at it.
 */
export async function insertModelItemWithVersion(params: {
  groupId: string
  binding: {
    displayName: string
    priority: number
    weight: number
    isEnabled: boolean
    installedByWorkspaceMemberId: string | null
  }
  version: {
    version: number
    providerKind: string
    vendor: string
    apiKey: string
    baseUrl: string
    modelName: string
    maxOutputTokens: number
    capabilityTags: string[]
    features: ModelBindingVersionsFeatures
    providerOptions: ModelBindingVersionsProviderOptions
    requestTimeoutMs: number | null
    maxRetries: number | null
  }
}): Promise<{ binding: any; version: any }> {
  return await withDbTransaction(async (trx) => {
    const binding = await trx
      .insertInto("modelBindings")
      .values({
        groupId: params.groupId,
        displayName: params.binding.displayName,
        priority: params.binding.priority,
        weight: params.binding.weight,
        isEnabled: params.binding.isEnabled,
        installedByWorkspaceMemberId:
          params.binding.installedByWorkspaceMemberId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const version = await trx
      .insertInto("modelBindingVersions")
      .values({
        bindingId: binding.id as string,
        version: params.version.version,
        providerKind: params.version.providerKind,
        vendor: params.version.vendor,
        apiKey: params.version.apiKey,
        baseUrl: params.version.baseUrl,
        modelName: params.version.modelName,
        maxOutputTokens: params.version.maxOutputTokens,
        capabilityTags: params.version.capabilityTags,
        features: params.version.features,
        providerOptions: params.version.providerOptions,
        requestTimeoutMs: params.version.requestTimeoutMs,
        maxRetries: params.version.maxRetries,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await trx
      .updateTable("modelBindings")
      .set({ currentVersionId: version.id })
      .where("id", "=", binding.id)
      .execute()

    return { binding, version }
  })
}

/**
 * updateModelItem's write flow as ONE transaction: optional binding-field
 * update, optional new version insert + currentVersionId bump, then re-read the
 * full joined row. Re-reading inside the tx keeps the returned shape consistent
 * with the writes. Returns the re-read row.
 */
export async function applyModelItemUpdate(params: {
  itemId: string
  bindingUpdate: Record<string, unknown> | null
  newVersion: {
    version: number
    providerKind: string
    vendor: string
    apiKey: string
    baseUrl: string
    modelName: string
    maxOutputTokens: number
    capabilityTags: string[]
    features: ModelBindingVersionsFeatures
    providerOptions: ModelBindingVersionsProviderOptions
    requestTimeoutMs: number | null
    maxRetries: number | null
  } | null
}): Promise<any> {
  return await withDbTransaction(async (trx) => {
    if (params.bindingUpdate) {
      await trx
        .updateTable("modelBindings")
        .set({ ...(params.bindingUpdate as any) })
        .where("id", "=", params.itemId)
        .execute()
    }

    if (params.newVersion) {
      const version = await trx
        .insertInto("modelBindingVersions")
        .values({
          bindingId: params.itemId,
          version: params.newVersion.version,
          providerKind: params.newVersion.providerKind,
          vendor: params.newVersion.vendor,
          apiKey: params.newVersion.apiKey,
          baseUrl: params.newVersion.baseUrl,
          modelName: params.newVersion.modelName,
          maxOutputTokens: params.newVersion.maxOutputTokens,
          capabilityTags: params.newVersion.capabilityTags,
          features: params.newVersion.features,
          providerOptions: params.newVersion.providerOptions,
          requestTimeoutMs: params.newVersion.requestTimeoutMs,
          maxRetries: params.newVersion.maxRetries,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await trx
        .updateTable("modelBindings")
        .set({ currentVersionId: version.id })
        .where("id", "=", params.itemId)
        .execute()
    }

    return await getModelGroupItemFullRow(params.itemId, trx)
  })
}

export async function softDeleteBinding(
  itemId: string,
  groupId: string,
  run: KyselyDb = db
): Promise<void> {
  await run
    .updateTable("modelBindings")
    .set({
      isEnabled: false,
      deletedAt: sql`NOW()`,
    })
    .where("id", "=", itemId)
    .where("groupId", "=", groupId)
    .execute()
}

// --- grant writes ---

/**
 * issueModelGroupGrant's write flow as ONE transaction: upsert the target
 * subject, insert the grant, then re-read it joined to access_subjects so the
 * derived grant_scope / workspace_id / actor_id / workspace_member_id fields
 * are populated for the presenter.
 */
export async function insertModelGroupGrantAndReadBack(params: {
  groupId: string
  subjectRef: SubjectRef
  grantedByWorkspaceMemberId: string | null
  reason: string | null
}): Promise<ModelGroupGrantDbRow> {
  return await withDbTransaction(async (trx) => {
    const subjectId = await upsertAccessSubject(trx, params.subjectRef)
    const inserted = await trx
      .insertInto("modelGroupGrants")
      .values({
        groupId: params.groupId,
        subjectId: subjectId,
        status: "active",
        grantedByWorkspaceMemberId: params.grantedByWorkspaceMemberId,
        reason: params.reason,
      })
      .returning("id")
      .executeTakeFirstOrThrow()

    const full = await trx
      .selectFrom("modelGroupGrants as mgg")
      .leftJoin("accessSubjects as mgs", "mgs.id", "mgg.subjectId")
      .select([
        "mgg.id",
        "mgg.groupId",
        "mgg.status",
        "mgg.reason",
        "mgg.createdAt",
        "mgg.revokedAt",
        "mgg.subjectId",
        "mgg.grantedByWorkspaceMemberId",
        "mgs.kind as mgsKind",
        "mgs.workspaceId as mgsWorkspaceId",
        "mgs.workspaceMemberId as mgsWorkspaceMemberId",
        "mgs.actorId as mgsActorId",
      ])
      .where("mgg.id", "=", inserted.id)
      .executeTakeFirstOrThrow()
    return full as ModelGroupGrantDbRow
  })
}

export async function revokeModelGroupGrantRow(
  groupId: string,
  grantId: string,
  run: KyselyDb = db
): Promise<{ id: string } | undefined> {
  return await run
    .updateTable("modelGroupGrants")
    .set({
      status: "revoked",
      revokedAt: sql`NOW()`,
    })
    .where("id", "=", grantId)
    .where("groupId", "=", groupId)
    .where("status", "=", "active")
    .returning("id")
    .executeTakeFirst()
}
