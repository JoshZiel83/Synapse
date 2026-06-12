/**
 * Repo for the `ai` module. This file owns the module's raw DB access (it is
 * exempt from guard r8 because its basename matches /repo[^/]*\.ts$/), so the
 * non-repo files (context-builder.ts, session-tools.ts) can stop importing the
 * db client.
 *
 * Repo functions return camelCase DOMAIN records and KEEP Date objects (time
 * serialization belongs to presenters, per guard r3). Raw `sql` template
 * fragments that use snake_case aliases intentionally bypass CamelCasePlugin
 * and are copied verbatim.
 */

import { sql } from "kysely"
import type { Selectable } from "kysely"
import {
  normalizeActorDocs,
  summarizeActorForRole,
  type ActorDoc,
} from "@synapse/shared"
import { db } from "../../infrastructure/database/kysely.js"
import type { KyselyDb } from "../../infrastructure/database/kysely.js"
import type {
  ToolResultParts,
  ToolResults,
} from "../../infrastructure/database/generated/db.js"
import { isActorActiveConversationParticipant } from "../access/subject-resolution.js"

// ---------------------------------------------------------------------------
// context-builder.ts execution-tool-results reads
// ---------------------------------------------------------------------------

export interface AiToolCallRow {
  id: string
  providerCallId: string | null
  toolName: string
}

/** Owns the tool_calls read for a session (CamelCasePlugin yields camelCase). */
export async function getToolCallsForSession(
  sessionId: string
): Promise<AiToolCallRow[]> {
  return db
    .selectFrom("toolCalls")
    .select(["id", "providerCallId", "toolName"])
    .where("sessionId", "=", sessionId)
    .execute()
}

/**
 * Owns the tool_results read. Returns the raw selectAll rows ordered by
 * (toolCallId asc, resultIndex desc) so the caller can take the latest result
 * per tool_call.
 */
export async function getToolResultsByToolCallIds(
  toolCallIds: string[]
): Promise<Selectable<ToolResults>[]> {
  return db
    .selectFrom("toolResults")
    .selectAll()
    .where("toolCallId", "in", toolCallIds)
    .orderBy("toolCallId", "asc")
    .orderBy("resultIndex", "desc")
    .execute()
}

/**
 * Owns the tool_result_parts read. Returns the raw selectAll rows ordered by
 * (toolResultId asc, ordinal asc) for the caller's part grouping/assembly.
 */
export async function getToolResultPartsByResultIds(
  resultIds: string[]
): Promise<Selectable<ToolResultParts>[]> {
  return db
    .selectFrom("toolResultParts")
    .selectAll()
    .where("toolResultId", "in", resultIds)
    .orderBy("toolResultId", "asc")
    .orderBy("ordinal", "asc")
    .execute()
}

// ---------------------------------------------------------------------------
// session-tools.ts inviteable-actors query + row→domain shaping
// ---------------------------------------------------------------------------

export type InviteableActor = {
  id: string
  displayName: string
  title?: string
  role?: string
  summary?: string
}

function parseActorDocs(value: unknown): ActorDoc[] {
  if (!value) return []
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed)
        ? normalizeActorDocs(parsed as ActorDoc[])
        : []
    } catch {
      return []
    }
  }
  return Array.isArray(value) ? normalizeActorDocs(value as ActorDoc[]) : []
}

function isGroupVisibleDoc(doc: ActorDoc): boolean {
  return doc.visibility === "always" || doc.visibility === "multi_member_only"
}

function summarizeInviteableActor(row: {
  title?: string | null
  role?: string | null
  actorDocs?: unknown
}): string | undefined {
  const docs = parseActorDocs(row.actorDocs).filter(isGroupVisibleDoc)
  const summary = summarizeActorForRole(docs, row.title || row.role || "Actor")
    .replace(/\s+/g, " ")
    .trim()

  return summary || undefined
}

/**
 * Owns the inviteable-actors query (active workspace apps whose actor is not
 * already an active participant of the conversation) and maps each row to an
 * InviteableActor domain record. The raw `sql` jsonb_agg projection and the
 * `sql<boolean>` NOT EXISTS subquery use hand-written snake_case columns that
 * intentionally bypass CamelCasePlugin — copied verbatim.
 */
export async function listInviteableActorRows(
  db: KyselyDb,
  params: {
    workspaceId: string
    conversationId: string
    actorId: string
  }
): Promise<InviteableActor[]> {
  const result = await db
    .selectFrom("actors as a")
    .innerJoin("workspaceApps as app", "app.id", "a.id")
    .leftJoin("actorVersions as current_version", (join) =>
      join
        .onRef("current_version.actorId", "=", "a.id")
        .onRef("current_version.version", "=", "a.currentVersion")
    )
    .select([
      "a.id",
      "app.displayName",
      "a.title",
      "a.role",
      sql`COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'key', avd.doc_key,
              'title', avd.title,
              'visibility', avd.visibility,
              'priority', avd.priority,
              'content', avd.content_blocks
            )
            ORDER BY avd.priority DESC, avd.created_at ASC
          )
          FROM actor_version_docs avd
          WHERE avd.actor_version_id = current_version.id
        ),
        '[]'::jsonb
      )`.as("actorDocs"),
    ])
    .where("app.workspaceId", "=", params.workspaceId)
    .where("app.deletedAt", "is", null)
    .where("app.status", "=", "active")
    .where("a.id", "<>", params.actorId)
    .where(
      sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM conversation_participants cp
      JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
      WHERE cp.conversation_id = ${params.conversationId}
        AND cpsubj.actor_id = a.id
        AND cp.state = 'active'
    )`
    )
    .orderBy("app.displayName", "asc")
    .orderBy("a.id", "asc")
    .execute()

  return result.map((row) => ({
    id: row.id as string,
    displayName: row.displayName as string,
    title: (row.title as string | null) || undefined,
    role: (row.role as string | null) || undefined,
    summary: summarizeInviteableActor(row),
  }))
}

/** Default-db-bound entry so session-tools.ts can call without importing db. */
export function listInviteableActorRowsDefault(params: {
  workspaceId: string
  conversationId: string
  actorId: string
}): Promise<InviteableActor[]> {
  return listInviteableActorRows(db, params)
}

// ---------------------------------------------------------------------------
// Default-db binder for a threaded access-module helper (Rule 6b): keep the
// db-client import inside this repo so session-tools.ts can drop it.
// ---------------------------------------------------------------------------

/** Default-db-bound wrapper around the access-module participant check. */
export function isActorActiveConversationParticipantDefault(
  conversationId: string,
  actorId: string
): ReturnType<typeof isActorActiveConversationParticipant> {
  return isActorActiveConversationParticipant(db, conversationId, actorId)
}
