/**
 * Default-running regressions for the automation event-source fold into
 * workspace_resource_grants. These run on the always-on `withTestDb`
 * testcontainer harness (NOT gated on DATABASE_URL), so they execute in the
 * default `npm test` run — closing the gap where the fold's headline blocker had
 * only a DATABASE_URL-gated test that skipped by default.
 *
 * Covered:
 *   1. BLOCKER split — display_name + status live on the workspace_resources
 *      ROOT now; the automation_event_sources DETAIL table carries only detail
 *      columns. The pre-fix code wrote name/status into the detail bag (columns
 *      that no longer exist) and crashed. We exercise the REAL writers the fixed
 *      service calls — updateWorkspaceResourceRoot (root) +
 *      updateAutomationEventSourceRow (detail) — and assert the split persists.
 *      (The detail write bag is also a closed TS type now, so re-adding
 *      name/status is a compile error — this test guards the runtime half.)
 *   2. REVOKE idempotency — revokeAutomationEventSourceAccessGrantById flips the
 *      single active grant to `revoked` and is a no-op (returns false) on a
 *      second call (restored from the deleted RAB binding-storage suite).
 *   3. SCOPED non-collapse — uq_workspace_resource_grants_active is NULLS NOT
 *      DISTINCT, so an unscoped use grant and a conversation-scoped use grant for
 *      the same (resource, actor subject) persist as two distinct active rows
 *      (restored from the deleted ensureSkillBinding scoped-after-unscoped test).
 *
 * NOTE on hermeticity: every test here runs on the `withTestDb` testcontainer in
 * a rolled-back transaction. We deliberately do NOT add a global-`db` service
 * e2e here — importing repo.js at module load pulls in env-bootstrap (dotenv),
 * which would resolve the global `db` to whatever DATABASE_URL `.env` points at
 * (a developer's live DB), and a `Boolean(process.env.DATABASE_URL)`-gated test
 * would then silently run against it. The closed AutomationEventSourceDetailWrite
 * type already makes "write name/status to the detail bag" a COMPILE error, so
 * the service's root-vs-detail routing is type-enforced; these runtime tests pin
 * the persistence half hermetically.
 */

import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
  WORKSPACE_RESOURCE_GRANT_STATUS,
} from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  revokeAutomationEventSourceAccessGrantById,
  updateAutomationEventSourceRow,
} from "./repo.js"
import { updateWorkspaceResourceRoot } from "../workspace-resources/repo.js"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({ email: `aes-${crypto.randomUUID()}@e.test`, name: "AES user" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      ownerId,
      slug: `aes-${crypto.randomUUID().slice(0, 8)}`,
      name: "AES WS",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceMember(
  db: AnyDb,
  workspaceId: string,
  userId: string
): Promise<string> {
  const row = await db
    .insertInto("workspaceMembers")
    .values({ workspaceId, userId, trustLevel: "member" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function memberSubject(db: AnyDb, memberId: string): Promise<string> {
  return upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: memberId,
  })
}

async function insertConversation(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({ kind: "group", workspaceId, title: "conv" })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const id = crypto.randomUUID()
  const creator = await memberSubject(
    db,
    await insertWorkspaceMember(db, workspaceId, await insertUser(db))
  )
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId,
      kind: "actor",
      displayName: "actor",
      createdBySubjectId: creator,
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("actors")
    .values({ id, role: "assistant", title: "actor", currentVersion: 1 })
    .execute()
  return id
}

// Insert an automation_event_source: workspace_resources ROOT (display_name +
// status + owner/creator) then automation_event_sources DETAIL, in the same
// rolled-back transaction (detail-consistency trigger is DEFERRABLE).
async function insertEventSource(
  db: AnyDb,
  workspaceId: string,
  ownerMemberId: string
): Promise<string> {
  const id = crypto.randomUUID()
  const subjectId = await memberSubject(db, ownerMemberId)
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId,
      kind: "automation_event_source",
      displayName: "Original Source Name",
      ownerSubjectId: subjectId,
      createdBySubjectId: subjectId,
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("automationEventSources")
    .values({
      id,
      workspaceId,
      providerKind: "internal",
      sourceKey: `src-${crypto.randomUUID().slice(0, 8)}`,
      description: "original description",
    } as any)
    .execute()
  return id
}

test(
  "BLOCKER split: name+status persist to the workspace_resources root; only detail columns persist to automation_event_sources",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerId
      )
      const eventSourceId = await insertEventSource(
        db,
        workspaceId,
        ownerMemberId
      )

      const newName = `Renamed Source ${crypto.randomUUID().slice(0, 8)}`
      // The two writers the fixed updateAutomationEventSource splits across.
      // Root: display_name + status (the columns the fold moved off the detail).
      await updateWorkspaceResourceRoot(db, {
        id: eventSourceId,
        displayName: newName,
        status: "disabled",
      })
      // Detail: ONLY detail columns. Pre-fix this same path crashed because
      // name/status were in the bag; the bag is a closed type now so they can't
      // even be passed.
      await updateAutomationEventSourceRow(
        {
          workspaceId,
          eventSourceId,
          values: {
            providerRef: null,
            webhookEndpointId: null,
            description: "updated description",
            recommendedUsage: "use it",
            payloadSchema: JSON.stringify({ type: "object" }),
            examplePayload: JSON.stringify({}),
            metadata: JSON.stringify({}),
          },
        },
        db
      )

      const root = await db
        .selectFrom("workspaceResources")
        .select(["displayName", "status"])
        .where("id", "=", eventSourceId)
        .executeTakeFirstOrThrow()
      assert.equal(root.displayName, newName)
      assert.equal(root.status, "disabled")

      const detail = await db
        .selectFrom("automationEventSources")
        .select(["description"])
        .where("id", "=", eventSourceId)
        .executeTakeFirstOrThrow()
      assert.equal(detail.description, "updated description")
    })
  }
)

test(
  "REVOKE idempotency: revokeAutomationEventSourceAccessGrantById flips active→revoked once, then is a no-op",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerId
      )
      const eventSourceId = await insertEventSource(
        db,
        workspaceId,
        ownerMemberId
      )

      // An "open to all" workspace-subject use grant on the source.
      const workspaceSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId,
      })
      const grant = await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId,
          workspaceResourceId: eventSourceId,
          subjectId: workspaceSubjectId,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
          status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
          source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const grantId = grant.id as string

      // First revoke flips the row and reports a change.
      const first = await revokeAutomationEventSourceAccessGrantById(
        { grantId },
        db
      )
      assert.equal(first, true, "first revoke must flip the active grant")
      const row = await db
        .selectFrom("workspaceResourceGrants")
        .select(["status", "revokedAt"])
        .where("id", "=", grantId)
        .executeTakeFirstOrThrow()
      assert.equal(row.status, "revoked")
      assert.ok(row.revokedAt, "revoked_at must be stamped")

      // Second revoke is a no-op (the status='active' predicate matches nothing).
      const second = await revokeAutomationEventSourceAccessGrantById(
        { grantId },
        db
      )
      assert.equal(second, false, "second revoke must be idempotent")
    })
  }
)

test(
  "SCOPED non-collapse: an unscoped use grant and a conversation-scoped use grant for the same (source, actor) coexist as two active rows",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const ownerId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, ownerId)
      const ownerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        ownerId
      )
      const eventSourceId = await insertEventSource(
        db,
        workspaceId,
        ownerMemberId
      )
      const actorId = await insertActor(db, workspaceId)
      const conversationId = await insertConversation(db, workspaceId)
      const actorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const conversationScopeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId,
      })

      // Unscoped actor use grant (scope_subject_id = NULL).
      await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId,
          workspaceResourceId: eventSourceId,
          subjectId: actorSubjectId,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
          status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
          source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
        } as any)
        .execute()

      // Conversation-scoped actor use grant for the SAME (source, actor). Under
      // NULLS NOT DISTINCT this does NOT collide with the unscoped row, because
      // scope_subject_id NULL ≠ <conversation>.
      await db
        .insertInto("workspaceResourceGrants")
        .values({
          workspaceId,
          workspaceResourceId: eventSourceId,
          subjectId: actorSubjectId,
          scopeSubjectId: conversationScopeSubjectId,
          permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE],
          status: WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE,
          source: WORKSPACE_RESOURCE_GRANT_SOURCE.MANUAL,
        } as any)
        .execute()

      const rows = await db
        .selectFrom("workspaceResourceGrants")
        .select(["id", "scopeSubjectId"])
        .where("workspaceResourceId", "=", eventSourceId)
        .where("subjectId", "=", actorSubjectId)
        .where("status", "=", WORKSPACE_RESOURCE_GRANT_STATUS.ACTIVE)
        .execute()
      assert.equal(rows.length, 2, "scoped + unscoped must not collapse")
      const scopes = rows.map((r) => r.scopeSubjectId).sort()
      assert.deepEqual(
        scopes,
        [conversationScopeSubjectId, null].sort(),
        "exactly one unscoped (NULL) and one conversation-scoped row"
      )
    })
  }
)
