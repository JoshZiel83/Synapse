/**
 * DB access for the actor-status hook wiring (im/integration).
 *
 * This file owns the raw `db` / `sql` queries that back the status-reaction
 * + typing controller lookups. It is named `repo*.ts` so the layering guard
 * (r8 db-client, r3 time-serialization, r4) treats it as the module's repo
 * and permits importing the db client, `sql`, and the serialize* helpers.
 *
 * Return-shape note: the pure decide helpers in actor-status-hooks.ts compare
 * `started_at` / `createdAt` LEXICOGRAPHICALLY as canonical UTC ISO-8601 `Z`
 * strings, and the test fixtures are snake_case ISO shapes. So these repo
 * functions return the interim ISO-string shapes (not raw Date objects) and
 * the serializeInstant / serializeOptionalInstant calls live here. That keeps
 * the consumer + tests byte-for-byte unchanged.
 */

import { sql, type SqlBool } from "kysely"
import { db } from "../../../infrastructure/database/kysely.js"
import {
  type IsoInstantString,
  serializeInstant,
  serializeOptionalInstant,
} from "../../../infrastructure/datetime.js"

export interface InboundLinkLookup {
  externalMessageId: string
  endpointExternalId: string
  endpointType: "direct" | "group"
  transportKind: string
  transportAccountId: string
}

export interface InboundLinkLookupWithCreatedAt extends InboundLinkLookup {
  createdAt: IsoInstantString
}

/**
 * Snapshot of the most recent RUNNING turn for a session. Used by both the
 * primary trigger-item lookup AND the fallback cutoff so the two see the
 * same state.
 *
 * `started_at` is nullable in schema (`turns.started_at`, see
 * generated/db.ts). `createTurn` writes NOW() in practice, but legacy /
 * dirty rows could still be null. We return ISO strings (or null) so
 * downstream string-based comparisons don't go through JS Date coercion.
 */
export interface RunningTurnRow {
  trigger_item_id: string | null
  started_at: IsoInstantString | null
}

export async function loadConversationIdForSession(
  sessionId: string
): Promise<string | null> {
  const row = await db
    .selectFrom("sessions")
    .select("conversationId")
    .where("id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
  return row?.conversationId || null
}

/**
 * Most recent RUNNING turn for a session.
 *
 * Does NOT fall back to completed turns — the prior lookup at this site
 * picked the most recent turn regardless of status, which let a stale
 * completed turn's `started_at` extend the fallback cutoff far into the
 * past.
 *
 * `ORDER BY started_at DESC NULLS LAST, id DESC LIMIT 1`: a dirty row
 * with `started_at = NULL` must not eclipse a real running turn (Postgres
 * default `NULLS FIRST` on DESC would put nulls at the top). `id DESC` is
 * the deterministic tiebreaker. The returned `started_at` is the ISO
 * string form so the decide helper does string-vs-string comparisons.
 */
export async function loadCurrentRunningTurnRow(
  sessionId: string
): Promise<RunningTurnRow | null> {
  const row = await db
    .selectFrom("turns")
    .select(["triggerItemId", "startedAt", "id"])
    .where("sessionId", "=", sessionId)
    .where("status", "=", "running")
    .orderBy(sql`started_at DESC NULLS LAST`)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    trigger_item_id: row.triggerItemId,
    started_at: serializeOptionalInstant(row.startedAt) ?? null,
  }
}

/**
 * Resolve the inbound link for a given trigger item id (the conversation
 * item that started the current actor turn).
 *
 * Adds `NULLIF(BTRIM(external_message_id), '') IS NOT NULL` to the SQL so
 * a link row with a null / empty / whitespace external id is treated as
 * "no link" by the loader and the caller falls through to the fallback
 * path. The schema allows empty strings (see schema.sql for
 * transport_message_links) and a `LIMIT 1` without this predicate could
 * silently use a placeholder id downstream.
 */
export async function findInboundLinkForTriggerItem(
  itemId: string
): Promise<InboundLinkLookup | null> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .innerJoin(
      "transportEndpoints",
      "transportEndpoints.id",
      "transportMessageLinks.transportEndpointId"
    )
    .innerJoin(
      "transportAccounts",
      "transportAccounts.id",
      "transportMessageLinks.transportAccountId"
    )
    .select([
      "transportMessageLinks.externalMessageId as externalMessageId",
      "transportEndpoints.externalId as endpointExternalId",
      "transportEndpoints.endpointType as endpointType",
      "transportAccounts.transportKind as transportKind",
      "transportAccounts.id as transportAccountId",
    ])
    .where("transportMessageLinks.itemId", "=", itemId)
    .where("transportMessageLinks.direction", "=", "inbound")
    .where(
      sql<SqlBool>`NULLIF(BTRIM(transport_message_links.external_message_id), '') IS NOT NULL`
    )
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.externalMessageId) return null
  return {
    externalMessageId: row.externalMessageId,
    endpointExternalId: row.endpointExternalId,
    endpointType: row.endpointType as "direct" | "group",
    transportKind: String(row.transportKind),
    transportAccountId: String(row.transportAccountId),
  }
}

/**
 * Most recent inbound link in the conversation, filtered to rows whose
 * `created_at >= cutoffIso`. Returns `createdAt` alongside the link so
 * the decide helper can verify the cutoff lexicographically.
 *
 * Same `NULLIF(BTRIM(...), '') IS NOT NULL` predicate as the trigger-item
 * loader so a newer row with an empty external_message_id can't hide an
 * older valid row via `ORDER BY created_at DESC LIMIT 1`.
 *
 * Caller supplies the cutoff so all observability flows through one
 * formula (`computeStatusFallbackCutoffIso`).
 */
export async function findRecentInboundLinkForConversation(
  conversationId: string,
  cutoffIso: string
): Promise<InboundLinkLookupWithCreatedAt | null> {
  const row = await db
    .selectFrom("transportMessageLinks")
    .innerJoin(
      "transportEndpoints",
      "transportEndpoints.id",
      "transportMessageLinks.transportEndpointId"
    )
    .innerJoin(
      "transportAccounts",
      "transportAccounts.id",
      "transportMessageLinks.transportAccountId"
    )
    .select([
      "transportMessageLinks.externalMessageId as externalMessageId",
      "transportEndpoints.externalId as endpointExternalId",
      "transportEndpoints.endpointType as endpointType",
      "transportAccounts.transportKind as transportKind",
      "transportAccounts.id as transportAccountId",
      "transportMessageLinks.createdAt as createdAt",
    ])
    .where("transportMessageLinks.conversationId", "=", conversationId)
    .where("transportMessageLinks.direction", "=", "inbound")
    .where(
      sql<SqlBool>`NULLIF(BTRIM(transport_message_links.external_message_id), '') IS NOT NULL`
    )
    .where("transportMessageLinks.createdAt", ">=", cutoffIso as any)
    .orderBy("transportMessageLinks.createdAt", "desc")
    .limit(1)
    .executeTakeFirst()
  if (!row || !row.externalMessageId) return null
  return {
    externalMessageId: row.externalMessageId,
    endpointExternalId: row.endpointExternalId,
    endpointType: row.endpointType as "direct" | "group",
    transportKind: String(row.transportKind),
    transportAccountId: String(row.transportAccountId),
    createdAt: serializeInstant(row.createdAt),
  }
}
