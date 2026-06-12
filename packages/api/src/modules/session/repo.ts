// session/repo.ts — DB-touching helpers for the session module.
//
// This is the only session file permitted to import the db client and `sql`
// (guard-layering r8/r1/r2/r4 exempt repo*.ts). It owns query OWNERSHIP for the
// session module; service.ts carries business orchestration and calls in here.
// Repo functions return camelCase DOMAIN rows with Date columns intact — time
// serialization (serializeInstant) belongs to presenter.ts (guard r3).

import {
  db,
  runBuilder,
  takeFirstOn,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { sql } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import type {
  UUID,
  SessionStatus,
  SessionTrigger,
  SessionInterruptType,
} from "@synapse/shared"
import { upsertAccessSubjectOn } from "../access/subject-registry.js"
import type {
  ConversationItemPartRow,
  SessionMessageItemRow,
  SessionRow,
} from "./repo.types.js"

export async function getActorJoinVersionId(actorId: UUID) {
  const row = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("actorVersions as current_version", (join) =>
      join
        .onRef("current_version.actorId", "=", "a.id")
        .onRef("current_version.version", "=", "a.currentVersion")
    )
    .select("current_version.id as actorVersionId")
    .where("a.id", "=", actorId)
    .where("app.deletedAt", "is", null)
    .limit(1)
    .executeTakeFirst()
  return row?.actorVersionId || undefined
}

export async function loadSessionRow(
  sessionId: UUID
): Promise<SessionRow | null> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("actors as a", "a.id", "s.actorId")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .innerJoin("conversations as c", "c.id", "s.conversationId")
    .selectAll("s")
    .select((eb) => [
      "app.displayName as actorDisplayName",
      "c.kind as conversationKind",
      eb
        .exists(
          eb
            .selectFrom("conversationTransportBindings as b")
            .select("b.id")
            .whereRef("b.conversationId", "=", "c.id")
        )
        .as("conversationIsIm"),
      "c.title as conversationTitle",
    ])
    .where("s.id", "=", sessionId)
    .executeTakeFirst()
  return (row as SessionRow | undefined) ?? null
}

export async function getConversationActorSessionRow(
  conversationId: UUID,
  actorId: UUID,
  queryable: Executor = db
) {
  return takeFirstOn(
    queryable,
    db
      .selectFrom("sessions")
      .selectAll()
      .where("conversationId", "=", conversationId)
      .where("actorId", "=", actorId)
      .limit(1)
  )
}

export async function requireActiveActorConversationParticipant(
  conversationId: UUID,
  actorId: UUID,
  queryable: Executor = db
) {
  // P1b: upsert the actor's subject_id (on the same queryable for trx safety),
  // then filter conversation_participants by subject_id.
  const actorSubjectId = await upsertAccessSubjectOn(queryable, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const participant = await takeFirstOn(
    queryable,
    db
      .selectFrom("conversationParticipants")
      .select("id")
      .where("conversationId", "=", conversationId)
      .where("subjectId", "=", actorSubjectId)
      .where("state", "=", "active")
      .limit(1)
  )

  if (!participant) {
    throw new Error(
      `Actor ${actorId} is not an active participant of conversation ${conversationId}`
    )
  }
}

export async function insertSessionIfAbsent(
  params: {
    id: string
    workspaceId: UUID
    actorId: UUID
    conversationId: UUID
    trigger?: SessionTrigger
  },
  queryable: Executor = db
): Promise<{ id: string } | null> {
  return takeFirstOn<{ id: string }>(
    queryable,
    db
      .insertInto("sessions")
      .values({
        id: params.id,
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        conversationId: params.conversationId,
        trigger: params.trigger || "user_message",
        status: "idle",
      })
      .onConflict((oc) => oc.columns(["conversationId", "actorId"]).doNothing())
      .returning("id")
  )
}

export async function updateSessionStatus(
  sessionId: UUID,
  status: SessionStatus,
  extra?: { errorMessage?: string | null }
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      status,
      completedAt: status === "closed" ? sql`NOW()` : null,
      ...(extra?.errorMessage !== undefined
        ? { errorMessage: extra.errorMessage }
        : {}),
    })
    .where("id", "=", sessionId)
    .execute()
}

export async function setSessionCollaborationValues(
  sessionId: UUID,
  values: Record<string, unknown>,
  queryable: Executor = db
): Promise<void> {
  await runBuilder(
    queryable,
    db.updateTable("sessions").set(values).where("id", "=", sessionId)
  )
}

export async function getActorDisplayName(
  actorId: UUID
): Promise<string | undefined> {
  return (
    await db
      .selectFrom("actors as actor")
      .innerJoin("workspaceApps as app", "app.id", "actor.id")
      .select("app.displayName as displayName")
      .where("actor.id", "=", actorId)
      .where("app.deletedAt", "is", null)
      .executeTakeFirst()
  )?.displayName
}

export async function getSessionMessageItemRows(
  sessionId: UUID
): Promise<SessionMessageItemRow[]> {
  const items = await db
    .selectFrom("conversationItems as ci")
    .innerJoin("sessions as s", "s.id", "ci.sessionId")
    .leftJoin(
      "conversationParticipants as cp",
      "cp.id",
      "ci.authorParticipantId"
    )
    .leftJoin("accessSubjects as cpsubj", "cpsubj.id", "cp.subjectId")
    .leftJoin("actors as a", "a.id", "cpsubj.actorId")
    .leftJoin("workspaceApps as actor_app", "actor_app.id", "a.id")
    .leftJoin("workspaceMembers as wm", "wm.id", "cpsubj.workspaceMemberId")
    .leftJoin("users as u", "u.id", "wm.userId")
    .select([
      "ci.id",
      "ci.sessionId",
      "ci.conversationId",
      "ci.sequence",
      "ci.role",
      "ci.subtype",
      "ci.metadata",
      "ci.eventPayload",
      "ci.authorParticipantId",
      "ci.createdAt",
      "s.workspaceId",
      "cpsubj.actorId as fromActorId",
      "cpsubj.workspaceMemberId as fromWorkspaceMemberId",
      sql<
        string | null
      >`COALESCE(actor_app.display_name, u.name, cp.display_name)`.as(
        "authorName"
      ),
    ])
    .where("ci.sessionId", "=", sessionId)
    .orderBy("ci.createdAt", "asc")
    .orderBy("ci.sequence", "asc")
    .execute()
  return items as unknown as SessionMessageItemRow[]
}

export async function getSessionMessagePartRows(
  itemIds: string[]
): Promise<ConversationItemPartRow[]> {
  return db
    .selectFrom("conversationItemParts as cip")
    .select([
      "cip.id",
      "cip.itemId",
      "cip.ordinal",
      "cip.partType",
      "cip.mimeType",
      "cip.textValue",
      "cip.jsonValue",
      "cip.refPath",
      "cip.refSha256",
      "cip.name",
      "cip.metadata",
    ])
    .where("cip.itemId", "in", itemIds)
    .orderBy("cip.itemId", "asc")
    .orderBy("cip.ordinal", "asc")
    .execute()
}

export async function consumeSessionInterrupts(
  sessionId: UUID
): Promise<any[]> {
  return db
    .updateTable("sessionInterrupts")
    .set({
      isConsumed: true,
    })
    .where("targetSessionId", "=", sessionId)
    .where("isConsumed", "=", false)
    .returningAll()
    .execute()
}

export async function hasPendingSessionInterrupt(
  sessionId: UUID,
  type?: SessionInterruptType
): Promise<boolean> {
  let query = db
    .selectFrom("sessionInterrupts")
    .select("id")
    .where("targetSessionId", "=", sessionId)
    .where("isConsumed", "=", false)

  if (type) {
    query = query.where("type", "=", type)
  }

  const row = await query.limit(1).executeTakeFirst()
  return Boolean(row?.id)
}
