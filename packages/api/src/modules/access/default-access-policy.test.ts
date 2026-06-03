import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import {
  deriveAccessPolicy,
  grantApprovedAccess,
  setAccessPolicy,
} from "./default-access-policy.js"
import { loadAccessSubject } from "./subject-registry.js"

test(
  "setAccessPolicy(workspace_open) writes a workspace-scoped default_open binding for an actor",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId } = await seedWorkspaceAndActor(db)

      assert.equal(
        await deriveAccessPolicy(db, "actor", actorId, workspaceId),
        "approval_required",
        "before setAccessPolicy, derived policy must be approval_required"
      )

      await setAccessPolicy(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        policy: "workspace_open",
      })

      assert.equal(
        await deriveAccessPolicy(db, "actor", actorId, workspaceId),
        "workspace_open",
        "after setAccessPolicy, derived policy must be workspace_open"
      )
    })
  }
)

test(
  "setAccessPolicy is idempotent — second workspace_open call doesn't insert a duplicate",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId } = await seedWorkspaceAndActor(db)

      await setAccessPolicy(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        policy: "workspace_open",
      })
      await setAccessPolicy(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        policy: "workspace_open",
      })

      const count = await db
        .selectFrom("resource_access_bindings")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("actor_id", "=", actorId)
        .where("source", "=", "default_open")
        .where("status", "=", "active")
        .executeTakeFirstOrThrow()
      assert.equal(count.count, "1")
    })
  }
)

test(
  "setAccessPolicy(approval_required) revokes any active default_open binding",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId } = await seedWorkspaceAndActor(db)

      await setAccessPolicy(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        policy: "workspace_open",
      })
      await setAccessPolicy(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        policy: "approval_required",
      })

      assert.equal(
        await deriveAccessPolicy(db, "actor", actorId, workspaceId),
        "approval_required"
      )
    })
  }
)

test(
  "grantApprovedAccess writes a workspace_member-scoped binding for the approved member only",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      const bindingId = await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
        grantedByWorkspaceMemberId: memberId,
      })

      assert.ok(bindingId, "binding id should be returned")

      const row = await db
        .selectFrom("resource_access_bindings as binding")
        .innerJoin("access_subjects as subj", "subj.id", "binding.subject_id")
        .select([
          "binding.id",
          "binding.source",
          "binding.actor_id",
          "subj.kind",
          "subj.workspace_member_id",
          "subj.workspace_id",
        ])
        .where("binding.id", "=", bindingId)
        .executeTakeFirstOrThrow()

      assert.equal(row.actor_id, actorId)
      assert.equal(row.source, "approval")
      // The kind+workspace_member_id pair is what prevents leakage to other
      // members — workspace_id is now denormalized on access_subjects (set to
      // the member's owning workspace) for query convenience and does NOT
      // control authorization scope. See chk_access_subjects_payload.
      assert.equal(row.kind, "workspace_member")
      assert.equal(row.workspace_member_id, memberId)
      assert.equal(
        row.workspace_id,
        workspaceId,
        "denormalized workspace_id should equal the member's owning workspace"
      )
    })
  }
)

test(
  "grantApprovedAccess is idempotent for the same member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      const first = await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })
      const second = await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })
      assert.equal(first, second, "duplicate grant must return the same id")
    })
  }
)

test(
  "deriveAccessPolicy doesn't mistake an approval binding for a default_open binding",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndMember(db)

      await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
      })

      // Approval binding should NOT change the actor's derived policy —
      // that's still approval_required because no default_open binding exists.
      assert.equal(
        await deriveAccessPolicy(db, "actor", actorId, workspaceId),
        "approval_required"
      )
    })
  }
)

async function seedWorkspaceAndActor(db: import("kysely").Kysely<any>) {
  const userId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, userId)
  const actorId = await insertActor(db, workspaceId)
  return { workspaceId, actorId }
}

async function seedWorkspaceActorAndMember(db: import("kysely").Kysely<any>) {
  const userId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, userId)
  const memberId = await insertWorkspaceMember(db, workspaceId, userId)
  const actorId = await insertActor(db, workspaceId)
  return { workspaceId, memberId, actorId }
}

async function insertUser(db: import("kysely").Kysely<any>): Promise<string> {
  const row = await db
    .insertInto("users")
    .values({
      email: `u-${Math.random().toString(36).slice(2, 10)}@example.test`,
      name: "test user",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspace(
  db: import("kysely").Kysely<any>,
  ownerId: string
): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      owner_id: ownerId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
      name: "test workspace",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertActor(
  db: import("kysely").Kysely<any>,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: "test actor",
      role: "assistant",
      title: "test",
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertWorkspaceMember(
  db: import("kysely").Kysely<any>,
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

import { checkPermission, lookupResources } from "./evaluator.js"

// Seeds a workspace + actor + a non-owner member. The owner is a separate user,
// so the returned `memberId` does NOT carry workspace-admin RBAC privileges —
// which is the only way to test that an approval-time binding is what grants
// access (vs. inheriting admin invoke from being the owner).
async function seedWorkspaceActorAndNonOwnerMember(
  db: import("kysely").Kysely<any>
) {
  const ownerId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, ownerId)
  const guestUserId = await insertUser(db)
  const memberId = await insertWorkspaceMember(db, workspaceId, guestUserId)
  const actorId = await insertActor(db, workspaceId)
  return { workspaceId, memberId, actorId }
}

test(
  "after grantApprovedAccess(member), the evaluator's actor.invoke check returns true for that member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, memberId } =
        await seedWorkspaceActorAndNonOwnerMember(db)

      // Sanity: before the grant, member has no actor.invoke on this actor.
      // (Default actors created via setAccessPolicy(workspace_open) WOULD grant
      // access — so we deliberately leave the actor in approval_required mode.)
      const beforeAllowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(
        beforeAllowed,
        false,
        "before grantApprovedAccess, member must NOT have actor.invoke"
      )

      // Approve the member.
      await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberId,
        grantedByWorkspaceMemberId: memberId,
      })

      // The evaluator MUST surface the member-scoped binding via the
      // workspace_member subject branch of listResourceGrantRows.
      const afterAllowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(
        afterAllowed,
        true,
        "after grantApprovedAccess, the evaluator must see the member's approval binding"
      )

      // lookupResources for 'actor.invoke' must include this actor for the member.
      const visibleActors = await lookupResources(db, {
        resourceType: "actor",
        permission: "invoke",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.ok(
        visibleActors.includes(actorId),
        "lookupResources(actor.invoke) must include the approved actor"
      )
    })
  }
)

test(
  "approval grant for member A does NOT leak access to member B in the same workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const {
        workspaceId,
        actorId,
        memberId: memberA,
      } = await seedWorkspaceActorAndNonOwnerMember(db)
      const userBId = await insertUser(db)
      const memberB = await insertWorkspaceMember(db, workspaceId, userBId)

      await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: memberA,
      })

      const memberACanInvoke = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: memberA },
      })
      const memberBCanInvoke = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: memberB },
      })
      assert.equal(memberACanInvoke, true, "approved member can invoke")
      assert.equal(
        memberBCanInvoke,
        false,
        "non-approved member must NOT inherit access"
      )
    })
  }
)
