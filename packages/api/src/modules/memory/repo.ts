/**
 * Memory module repo (round-6 P1-6 / guard r8).
 *
 * This is the ONLY memory file (besides repo.types.ts) allowed to import the
 * db client and `sql` — its basename matches the guard's isRepo
 * /(^|/)repo[^/]*\.ts$/ allowlist. The controller used to query `db` directly
 * and thread it into the access engine; both now route through this file so
 * the controller carries no db-client import.
 *
 * Two responsibilities:
 *  1. Owned read queries the controller used to run inline (4 id-lookups).
 *  2. Default-db binders/wrappers for the db-injectable access-engine and
 *     access-grant-storage helpers, so the controller calls them with just
 *     their params (same edge-binding pattern as access/guards.ts).
 *
 * Repo functions return camelCase DOMAIN records with Date objects intact
 * (CamelCasePlugin already yields camelCase keys for query-builder selects);
 * time serialization belongs to presenters (guard r3).
 */

import { db } from "../../infrastructure/database/kysely.js"
import { authorizePermission } from "../access/service.js"
import {
  checkPermission,
  hasMemorySpaceOwnerImplicitPermissionForTuple,
} from "../access/evaluator.js"
import { buildRuntimePrincipalContext } from "../access/subject-resolution.js"
import {
  insertMemoryAccessGrant,
  listActiveMemoryAccessGrants,
  revokeMemoryAccessGrant,
} from "./access-grant-storage.js"

/**
 * Resolve the conversation anchor for a memory item's space via its owner /
 * scope subject decomposition. Used by `requireMemoryPermission` to enrich
 * the runtime context so a `subject=actor + scope=conversation` grant
 * matches. Returns the two conversation ids (owner-side / scope-side), each
 * null when the corresponding subject is not a conversation.
 */
export async function findMemorySpaceConversationAnchor(
  memoryId: string,
  workspaceId: string
): Promise<{
  ownerConversationId: string | null
  scopeConversationId: string | null
} | null> {
  const row = await db
    .selectFrom("memoryItems as mi")
    .innerJoin("memorySpaces as ms", "ms.id", "mi.memorySpaceId")
    .innerJoin(
      "accessSubjects as owner_subj",
      "owner_subj.id",
      "ms.ownerSubjectId"
    )
    .leftJoin(
      "accessSubjects as scope_subj",
      "scope_subj.id",
      "ms.scopeSubjectId"
    )
    .select([
      "owner_subj.conversationId as ownerConversationId",
      "scope_subj.conversationId as scopeConversationId",
    ])
    .where("mi.id", "=", memoryId)
    .where("mi.workspaceId", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Look up a memory space by id (the controller asserts it belongs to the
 * request's workspace before acting on grants).
 */
export async function findMemorySpaceInWorkspace(
  spaceId: string
): Promise<{ id: string; workspaceId: string } | null> {
  const row = await db
    .selectFrom("memorySpaces")
    .select(["id", "workspaceId"])
    .where("id", "=", spaceId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Look up a memory item's space membership (the POST grants route asserts the
 * item lives in the target space + workspace).
 */
export async function findMemoryItemSpaceMembership(
  memoryItemId: string
): Promise<{
  id: string
  memorySpaceId: string
  workspaceId: string
} | null> {
  const row = await db
    .selectFrom("memoryItems")
    .select(["id", "memorySpaceId", "workspaceId"])
    .where("id", "=", memoryItemId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Look up a memory access grant's space membership (the DELETE grant route
 * asserts the grant lives in the target space + workspace).
 */
export async function findMemoryAccessGrantMembership(
  grantId: string
): Promise<{
  id: string
  memorySpaceId: string
  workspaceId: string
} | null> {
  const row = await db
    .selectFrom("memoryAccessGrants")
    .select(["id", "memorySpaceId", "workspaceId"])
    .where("id", "=", grantId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

// ---------------------------------------------------------------------------
// Default-db binders for the db-injectable access engine (round-6 P1-6).
// The controller must not import the db client just to thread it into these
// access-module helpers. These bind the runtime default db; the underlying
// functions stay db-injectable for tests. (Same edge-binding pattern as
// access/guards.ts authorizeActionDefault etc., but the canonical home for
// the memory-only helpers is this repo file since access/guards.ts is owned
// centrally this round.)
// ---------------------------------------------------------------------------

export function authorizePermissionDefault(
  params: Parameters<typeof authorizePermission>[1]
): ReturnType<typeof authorizePermission> {
  return authorizePermission(db, params)
}

export function checkPermissionDefault(
  params: Parameters<typeof checkPermission>[1]
): ReturnType<typeof checkPermission> {
  return checkPermission(db, params)
}

export function hasMemorySpaceOwnerImplicitPermissionForTupleDefault(
  subject: Parameters<typeof hasMemorySpaceOwnerImplicitPermissionForTuple>[1],
  tuple: Parameters<typeof hasMemorySpaceOwnerImplicitPermissionForTuple>[2],
  permission: Parameters<
    typeof hasMemorySpaceOwnerImplicitPermissionForTuple
  >[3],
  runtimeContext?: Parameters<
    typeof hasMemorySpaceOwnerImplicitPermissionForTuple
  >[4]
): ReturnType<typeof hasMemorySpaceOwnerImplicitPermissionForTuple> {
  return hasMemorySpaceOwnerImplicitPermissionForTuple(
    db,
    subject,
    tuple,
    permission,
    runtimeContext
  )
}

export function buildRuntimePrincipalContextDefault(
  params: Parameters<typeof buildRuntimePrincipalContext>[1]
): ReturnType<typeof buildRuntimePrincipalContext> {
  return buildRuntimePrincipalContext(db, params)
}

// ---------------------------------------------------------------------------
// Default-db wrappers for the access-grant-storage layer. The grant storage
// helpers take an explicit db (db-injectable) for tests; the controller calls
// these binders so it no longer threads the db client.
// ---------------------------------------------------------------------------

export function insertMemoryAccessGrantDefault(
  input: Parameters<typeof insertMemoryAccessGrant>[1]
): ReturnType<typeof insertMemoryAccessGrant> {
  return insertMemoryAccessGrant(db, input)
}

export function listActiveMemoryAccessGrantsDefault(
  memorySpaceId: string
): ReturnType<typeof listActiveMemoryAccessGrants> {
  return listActiveMemoryAccessGrants(db, memorySpaceId)
}

export function revokeMemoryAccessGrantDefault(
  grantId: string
): ReturnType<typeof revokeMemoryAccessGrant> {
  return revokeMemoryAccessGrant(db, grantId)
}
