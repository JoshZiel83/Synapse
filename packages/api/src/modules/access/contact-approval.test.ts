import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { sql } from "kysely"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
  WORKSPACE_RESOURCE_GRANT_SOURCE,
} from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { insertWorkspaceResourceGrant } from "../workspace-resources/grant-storage.js"
import { upsertAccessSubject } from "./subject-registry.js"
import {
  deriveRequiresContactApproval,
  grantApprovedContactVisibility,
  setRequiresContactApproval,
} from "./contact-approval.js"
import { checkPermission, lookupResources } from "./evaluator.js"

test(
  "setRequiresContactApproval(false) writes a workspace-scoped default contact-visibility grant for an actor",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId } = await seedWorkspaceAndActor(db)

      assert.equal(
        await deriveRequiresContactApproval(db, "actor", actorId, workspaceId),
        true,
        "before setRequiresContactApproval, approval should be required"
      )

      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: false,
      })

      assert.equal(
        await deriveRequiresContactApproval(db, "actor", actorId, workspaceId),
        false,
        "after setRequiresContactApproval(false), approval should not be required"
      )
    })
  }
)

test(
  "setRequiresContactApproval(false) is idempotent for the default contact-visibility grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId } = await seedWorkspaceAndActor(db)

      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: false,
      })
      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: false,
      })

      const count = await db
        .selectFrom("workspaceResourceGrants as resource_grant")
        .innerJoin(
          "accessSubjects as subj",
          "subj.id",
          "resource_grant.subjectId"
        )
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("resource_grant.workspaceResourceId", "=", actorId)
        .where(
          "resource_grant.source",
          "=",
          WORKSPACE_RESOURCE_GRANT_SOURCE.SYSTEM
        )
        .where("resource_grant.status", "=", "active")
        .where(
          sql<boolean>`'contact_visible'::workspace_resource_grant_permission = ANY(resource_grant.permissions)`
        )
        .where("subj.kind", "=", SUBJECT_KIND.WORKSPACE)
        .executeTakeFirstOrThrow()
      assert.equal(count.count, "1")
    })
  }
)

test(
  "setRequiresContactApproval(true) revokes any active default contact-visibility grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId } = await seedWorkspaceAndActor(db)

      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: false,
      })
      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: true,
      })

      assert.equal(
        await deriveRequiresContactApproval(db, "actor", actorId, workspaceId),
        true
      )
    })
  }
)

test(
  "approved contact visibility writes a workspace_member-scoped app grant for the approved member only",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      const grantId = await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      const row = await db
        .selectFrom("workspaceResourceGrants as resource_grant")
        .innerJoin(
          "accessSubjects as subj",
          "subj.id",
          "resource_grant.subjectId"
        )
        .select([
          "resource_grant.id",
          "subj.kind as subjectKind",
          "subj.workspaceMemberId as workspaceMemberId",
        ])
        .where("resource_grant.id", "=", grantId)
        .executeTakeFirstOrThrow()

      assert.equal(row.id, grantId)
      assert.equal(row.subjectKind, SUBJECT_KIND.WORKSPACE_MEMBER)
      assert.equal(row.workspaceMemberId, memberId)
    })
  }
)

test(
  "approved contact visibility is idempotent for the same actor/member pair",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      const first = await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })
      const second = await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      assert.equal(first, second)
    })
  }
)

test(
  "deriveRequiresContactApproval doesn't mistake an approval grant for a default contact-visibility grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      await insertWorkspaceResourceGrant(db, {
        workspaceId,
        workspaceResourceId: actorId,
        target: { subject: { kind: "workspace_member", memberId } },
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE],
        source: WORKSPACE_RESOURCE_GRANT_SOURCE.APPROVAL,
      })

      assert.equal(
        await deriveRequiresContactApproval(db, "actor", actorId, workspaceId),
        true
      )
    })
  }
)

test(
  "after approved contact visibility, the evaluator's actor.invoke check returns true for that member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      const allowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(allowed, true)
    })
  }
)

test(
  "approved contact visibility for member A does NOT leak access to member B in the same workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)
      const otherUserId = await insertUser(db)
      const otherMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        otherUserId
      )

      await grantApprovedContactVisibility(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      const visible = await lookupResources(db, {
        resourceType: "actor",
        permission: "invoke",
        subject: { type: "workspace_member", id: otherMemberId },
      })
      assert.deepEqual(visible, [])
    })
  }
)

async function seedWorkspaceAndActor(db: AnyDb) {
  const ownerId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, ownerId)
  const actorId = await insertActor(db, workspaceId)
  return { workspaceId, actorId }
}

async function seedWorkspaceActorAndMember(db: AnyDb) {
  const ownerId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, ownerId)
  const memberId = await insertWorkspaceMember(
    db,
    workspaceId,
    await insertUser(db)
  )
  const actorId = await insertActor(db, workspaceId)
  return { workspaceId, actorId, memberId }
}

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${crypto.randomUUID()}@example.test`,
      name: "test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: ownerId,
      slug: `ws-${crypto.randomUUID().slice(0, 8)}`,
      name: "test workspace",
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
    .insertInto("workspace_members")
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      trust_level: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  // workspace_resources.created_by_subject_id is NOT NULL (owner→subject
  // migration). Reuse any member of the workspace as creator, else mint one.
  const existingMember = await db
    .selectFrom("workspace_members")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  const memberId = existingMember
    ? (existingMember.id as string)
    : await insertWorkspaceMember(db, workspaceId, await insertUser(db))
  const creatorSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    memberId,
  })
  await db
    .insertInto("workspace_resources")
    .values({
      id: actorId,
      workspace_id: workspaceId,
      kind: "actor",
      display_name: "test actor",
      created_by_subject_id: creatorSubjectId,
      status: "active",
    })
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}
