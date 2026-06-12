/**
 * Model-groups module repo.
 *
 * Owns the resolver's read queries against the DB client (guard r8 exempts
 * files whose basename matches /repo[^/]*\.ts$/, so this file MAY import `db`).
 * Repo functions return camelCase DOMAIN records and KEEP Date objects — time
 * serialization belongs to presenters (guard r3), not the repo.
 */

import { db, type KyselyDb } from "../../infrastructure/database/kysely.js"
import {
  actorSubject,
  listAuthorizedResourceIds,
  workspaceMemberSubject,
} from "../access/service.js"

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
    groups: groupsResult as ModelGroupCandidateRow[],
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
    attemptPolicy:
      row.attemptPolicy &&
      typeof row.attemptPolicy === "object" &&
      !Array.isArray(row.attemptPolicy)
        ? (row.attemptPolicy as Record<string, unknown>)
        : null,
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
    features:
      row.features &&
      typeof row.features === "object" &&
      !Array.isArray(row.features)
        ? (row.features as Record<string, unknown>)
        : null,
    providerOptions:
      row.providerOptions &&
      typeof row.providerOptions === "object" &&
      !Array.isArray(row.providerOptions)
        ? (row.providerOptions as Record<string, unknown>)
        : null,
    requestTimeoutMs: row.requestTimeoutMs,
    maxRetries: row.maxRetries,
  }))
}
