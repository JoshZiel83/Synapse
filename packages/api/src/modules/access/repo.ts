import {
  resolveConversationTypeKey,
  SUBJECT_KIND,
  WORKSPACE_APP_GRANT_PERMISSION,
  WORKSPACE_APP_GRANT_SOURCE,
  WORKSPACE_APP_GRANT_STATUS,
  workspaceMemberRef,
  type ConversationTypeKey,
} from "@synapse/shared"
import { sql } from "kysely"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import { insertWorkspaceAppGrant } from "../workspace-apps/grant-storage.js"
import {
  readAutomationEventSourceAccessBindingResourceId,
  type AutomationEventSourceBindingRelation,
  type AutomationEventSourceBindingStorageRow,
} from "./bindings.js"

/**
 * Access data-access layer. Row-normalization helpers live here so the
 * `normalize*Row` naming + row-spread stay inside a repo file (guard-layering
 * r4/r7). Behavior is identical to the previous `bindings.ts` definition.
 */
export function normalizeAutomationEventSourceAccessBindingRow<
  T extends AutomationEventSourceBindingStorageRow & {
    subjectId?: string | null
    scopeSubjectId?: string | null
    subjectKind?: string | null
    subjectWorkspaceIdViaJoin?: string | null
    subjectWorkspaceMemberIdViaJoin?: string | null
    subjectActorIdViaJoin?: string | null
    subjectRemoteAgentIdViaJoin?: string | null
    subjectConversationIdViaJoin?: string | null
    scopeKind?: string | null
    scopeWorkspaceIdViaJoin?: string | null
    scopeConversationIdViaJoin?: string | null
  },
>(
  row: T
): T & { resourceId: string; relation: AutomationEventSourceBindingRelation } {
  // Derive a relation string from subject kind; scope lives in scopeSubjectId.
  let relation: AutomationEventSourceBindingRelation
  switch (row.subjectKind) {
    case SUBJECT_KIND.WORKSPACE:
      relation = "use_workspace"
      break
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      relation = "use_workspace_member"
      break
    case SUBJECT_KIND.CONVERSATION:
      relation = "use_conversation"
      break
    case SUBJECT_KIND.ACTOR:
      relation = "use_actor"
      break
    case SUBJECT_KIND.REMOTE_AGENT:
      relation = "use_remote_agent"
      break
    default:
      relation = "use_scoped"
  }
  const normalized = {
    ...row,
    resourceId: readAutomationEventSourceAccessBindingResourceId(row),
    relation,
  }
  return normalized
}

export async function findActiveWorkspaceMemberIdForUser(
  db: KyselyDb,
  params: {
    workspaceId: string
    userId: string
  }
): Promise<string | null> {
  const member = await db
    .selectFrom("workspaceMembers as wm")
    .innerJoin("workspaces as w", "w.id", "wm.workspaceId")
    .select("wm.id")
    .where("wm.workspaceId", "=", params.workspaceId)
    .where("wm.userId", "=", params.userId)
    // Soft delete (§8.4): only an active member of a live workspace resolves to
    // a workspace_member subject.
    .where("wm.status", "=", "active")
    .where("w.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()

  return member?.id ?? null
}

export type AccessConversationTargetRecord = {
  conversationId: string
  kind: string
  isIm: boolean
  conversationTypeKey: ConversationTypeKey
}

export async function loadAccessConversationTargetRecord(
  db: KyselyDb,
  conversationId: string
): Promise<AccessConversationTargetRecord | null> {
  const row = await db
    .selectFrom("conversations as c")
    .select((eb) => [
      "c.id as id",
      "c.kind as kind",
      eb
        .exists(
          eb
            .selectFrom("conversationTransportBindings as b")
            .select("b.id")
            .whereRef("b.conversationId", "=", "c.id")
        )
        .as("isIm"),
    ])
    .where("c.id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
  if (!row) {
    return null
  }

  const isIm = Boolean(row.isIm)
  const conversationTypeKey = resolveConversationTypeKey(row.kind, isIm)
  if (!conversationTypeKey) {
    return null
  }

  return {
    conversationId: row.id,
    kind: row.kind,
    isIm,
    conversationTypeKey,
  }
}

/**
 * Generic "is this subject an active participant in the conversation?" lookup.
 * The caller still carries participantType for policy error context; the stable
 * database identity is the access_subjects id stored on conversationParticipants.
 */
export async function isAccessSubjectActiveConversationParticipant(
  db: KyselyDb,
  params: {
    conversationId: string
    participantType: "actor" | "remote_agent" | "workspace_member"
    subjectId: string
  }
): Promise<boolean> {
  const row = await db
    .selectFrom("conversationParticipants")
    .select("id")
    .where("conversationId", "=", params.conversationId)
    .where("subjectId", "=", params.subjectId)
    .where("state", "=", "active")
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

const DEFAULT_CONTACT_VISIBILITY_GRANT_REASON =
  "workspace contact-visible grant written by access lifecycle"

type ContactVisibilityResourceType = "actor" | "remote_agent"

async function hasWorkspaceDefaultContactVisibilityGrant(
  db: KyselyDb,
  resourceType: ContactVisibilityResourceType,
  resourceId: string,
  workspaceId: string
): Promise<boolean> {
  const row = await db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .select("app_grant.id")
    .where("app.kind", "=", resourceType)
    .where("app_grant.workspaceAppId", "=", resourceId)
    .where("subj.kind", "=", "workspace")
    .where("subj.workspaceId", "=", workspaceId)
    .where("app_grant.status", "=", "active")
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

export async function deriveRequiresContactApproval(
  db: KyselyDb,
  resourceType: ContactVisibilityResourceType,
  resourceId: string,
  workspaceId: string
): Promise<boolean> {
  return !(await hasWorkspaceDefaultContactVisibilityGrant(
    db,
    resourceType,
    resourceId,
    workspaceId
  ))
}

export async function deriveRequiresContactApprovalMany(
  db: KyselyDb,
  resourceType: ContactVisibilityResourceType,
  workspaceId: string,
  resourceIds: readonly string[]
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (resourceIds.length === 0) return out
  for (const id of resourceIds) {
    out.set(id, true)
  }
  const rows = await db
    .selectFrom("workspaceAppGrants as app_grant")
    .innerJoin("accessSubjects as subj", "subj.id", "app_grant.subjectId")
    .innerJoin("workspaceApps as app", "app.id", "app_grant.workspaceAppId")
    .select(["app_grant.workspaceAppId as resourceId"])
    .where("app.kind", "=", resourceType)
    .where("app_grant.workspaceAppId", "in", [...resourceIds])
    .where("subj.kind", "=", "workspace")
    .where("subj.workspaceId", "=", workspaceId)
    .where("app_grant.status", "=", "active")
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(app_grant.permissions)`
    )
    .execute()
  for (const row of rows as Array<{ resourceId: string | null }>) {
    if (row.resourceId) {
      out.set(row.resourceId, false)
    }
  }
  return out
}

/**
 * Idempotently align the workspace-wide contact-visible grant to the desired
 * approval requirement. Call this on actor/remote_agent creation and on
 * approval-setting updates.
 */
export async function setRequiresContactApproval(
  db: KyselyDb,
  params: {
    resourceType: ContactVisibilityResourceType
    resourceId: string
    workspaceId: string
    requiresContactApproval: boolean
    createdByWorkspaceMemberId?: string | null
  }
): Promise<void> {
  if (!params.requiresContactApproval) {
    const existing = await hasWorkspaceDefaultContactVisibilityGrant(
      db,
      params.resourceType,
      params.resourceId,
      params.workspaceId
    )
    if (existing) return
    await insertWorkspaceAppGrant(db, {
      workspaceId: params.workspaceId,
      workspaceAppId: params.resourceId,
      target: {
        subject: { kind: "workspace", workspaceId: params.workspaceId },
      },
      permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
      source: WORKSPACE_APP_GRANT_SOURCE.SYSTEM,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId ?? null,
      reason: DEFAULT_CONTACT_VISIBILITY_GRANT_REASON,
    })
    return
  }

  await db
    .updateTable("workspaceAppGrants")
    .set({
      status: WORKSPACE_APP_GRANT_STATUS.REVOKED,
      revokedAt: new Date(),
    } as any)
    .where("workspaceAppId", "=", params.resourceId)
    .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
    .where(
      sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(permissions)`
    )
    .where("reason", "=", DEFAULT_CONTACT_VISIBILITY_GRANT_REASON)
    .execute()
}

export async function grantApprovedContactVisibility(
  db: KyselyDb,
  params: {
    resourceType: ContactVisibilityResourceType
    resourceId: string
    workspaceId: string
    grantedToMemberId: string
    grantedByWorkspaceMemberId?: string | null
    reason?: string | null
  }
) {
  const subjectId = await db
    .selectFrom("accessSubjects")
    .select("id")
    .where("workspaceMemberId", "=", params.grantedToMemberId)
    .where("kind", "=", "workspace_member")
    .executeTakeFirst()
  if (subjectId) {
    const existing = await db
      .selectFrom("workspaceAppGrants")
      .select("id")
      .where("workspaceId", "=", params.workspaceId)
      .where("workspaceAppId", "=", params.resourceId)
      .where("subjectId", "=", subjectId.id)
      .where("status", "=", WORKSPACE_APP_GRANT_STATUS.ACTIVE)
      .where("scopeSubjectId", "is", null)
      .where(
        sql<boolean>`'contact_visible'::workspace_app_grant_permission = ANY(permissions)`
      )
      .executeTakeFirst()
    if (existing?.id) {
      return existing.id
    }
  }

  const inserted = await insertWorkspaceAppGrant(db, {
    workspaceId: params.workspaceId,
    workspaceAppId: params.resourceId,
    target: { subject: workspaceMemberRef(params.grantedToMemberId) },
    permissions: [WORKSPACE_APP_GRANT_PERMISSION.CONTACT_VISIBLE],
    source: WORKSPACE_APP_GRANT_SOURCE.APPROVAL,
    createdByWorkspaceMemberId: params.grantedByWorkspaceMemberId ?? null,
    reason: params.reason ?? "approved contact visibility grant",
  })
  return inserted.id
}
