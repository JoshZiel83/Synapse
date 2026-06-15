import {
  resolveConversationTypeKey,
  SUBJECT_KIND,
  type ConversationTypeKey,
} from "@synapse/shared"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
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
