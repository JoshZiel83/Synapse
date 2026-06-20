import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  SUBJECT_KIND,
  WORKSPACE_RESOURCE_GRANT_PERMISSION,
} from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { checkPermission, lookupResources } from "./evaluator.js"
import { setRequiresContactApproval } from "./contact-approval.js"
import { upsertAccessSubject } from "./subject-registry.js"
import { insertWorkspaceResourceGrant } from "../workspace-resources/grant-storage.js"

type AnyDb = import("kysely").Kysely<any>

async function insertUser(db: AnyDb): Promise<string> {
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

async function insertWorkspace(db: AnyDb, ownerId: string): Promise<string> {
  const row = await db
    .insertInto("workspaces")
    .values({
      ownerId: ownerId,
      slug: `ws-${Math.random().toString(36).slice(2, 10)}`,
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
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspaceId,
      userId: userId,
      trustLevel: "member",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// Owner→subject migration (§4.2): workspace_resources no longer has an
// `owner_workspace_member_id` column — ownership is an access_subjects FK
// (`owner_subject_id`), and `created_by_subject_id` is NOT NULL. These helpers
// resolve the subject ids each workspace_resources root row now requires.
async function memberSubjectId(db: AnyDb, memberId: string): Promise<string> {
  return upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: memberId,
  })
}

// A valid NOT-NULL creator subject for a root row when no specific member is
// supplied: reuse any existing member of the workspace, else mint one.
async function anyWorkspaceMemberSubjectId(
  db: AnyDb,
  workspaceId: string
): Promise<string> {
  const existing = await db
    .selectFrom("workspaceMembers")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .limit(1)
    .executeTakeFirst()
  const memberId = existing
    ? (existing.id as string)
    : await insertWorkspaceMember(db, workspaceId, await insertUser(db))
  return memberSubjectId(db, memberId)
}

async function insertActor(db: AnyDb, workspaceId: string): Promise<string> {
  const id = crypto.randomUUID()
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId: workspaceId,
      kind: "actor",
      displayName: "test actor",
      createdBySubjectId: await anyWorkspaceMemberSubjectId(db, workspaceId),
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id,
      role: "assistant",
      title: "test",
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// Insert an actor resource whose owner_subject_id is the given subject id
// (used to exercise the §4.2 owner-kind implicit matrix where a non-member
// actor/remote_agent owns a resource).
async function insertActorOwnedBySubject(
  db: AnyDb,
  workspaceId: string,
  ownerSubjectId: string
): Promise<string> {
  const id = crypto.randomUUID()
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId,
      kind: "actor",
      displayName: "owned-by-subject actor",
      ownerSubjectId,
      createdBySubjectId: await anyWorkspaceMemberSubjectId(db, workspaceId),
      status: "active",
    } as any)
    .execute()
  await db
    .insertInto("actors")
    .values({ id, role: "assistant", title: "owned", currentVersion: 1 })
    .execute()
  return id
}

// Convenience: workspace owner + a separate non-owner member (the owner has
// admin RBAC, the guest member does not — the only way to test that approval
// bindings genuinely drive access).
async function seedOwnerAndGuest(db: AnyDb) {
  const ownerId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, ownerId)
  const guestUserId = await insertUser(db)
  const guestMemberId = await insertWorkspaceMember(
    db,
    workspaceId,
    guestUserId
  )
  const actorId = await insertActor(db, workspaceId)
  return { workspaceId, guestMemberId, actorId }
}

test(
  "checkPermission(actor.invoke) is false for a non-owner member when contact approval is required and no grant exists",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { actorId, guestMemberId } = await seedOwnerAndGuest(db)
      const allowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, false)
    })
  }
)

test(
  "checkPermission(actor.invoke) is true for any workspace member once a default contact-visibility grant is present",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, guestMemberId } =
        await seedOwnerAndGuest(db)
      await setRequiresContactApproval(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        requiresContactApproval: false,
      })
      const allowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "invoke",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, true)
    })
  }
)

test(
  "lookupResources(actor.invoke) for an approved member includes the approved actor but excludes unrelated actors",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, guestMemberId } =
        await seedOwnerAndGuest(db)
      const unrelatedActorId = await insertActor(db, workspaceId)

      await insertWorkspaceResourceGrant(db, {
        workspaceId,
        workspaceResourceId: actorId,
        target: {
          subject: {
            kind: "workspace_member",
            workspaceMemberId: guestMemberId,
          },
        },
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE],
        source: "approval",
      })

      const visible = await lookupResources(db, {
        resourceType: "actor",
        permission: "invoke",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(
        visible.includes(actorId),
        "approved actor must be visible to the granted member"
      )
      assert.ok(
        !visible.includes(unrelatedActorId),
        "unapproved actor must NOT be visible"
      )
    })
  }
)

test(
  "lookupResources(actor.invoke) returns [] for a workspace_member subject that doesn't exist",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const visible = await lookupResources(db, {
        resourceType: "actor",
        permission: "invoke",
        subject: {
          type: "workspace_member",
          id: "00000000-0000-0000-0000-000000000000",
        },
      })
      assert.deepEqual(visible, [])
    })
  }
)

test(
  "checkPermission denies an unknown permission on a real actor (no permission == no allow)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { actorId, guestMemberId } = await seedOwnerAndGuest(db)
      const allowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: actorId,
        permission: "totally_fake_permission",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, false)
    })
  }
)

test(
  "checkPermission(actor.invoke) for a non-existent actor returns false",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const allowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: "00000000-0000-0000-0000-000000000000",
        permission: "invoke",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(allowed, false)
    })
  }
)

test(
  "checkPermission(workspace.view) is true for a workspace_member of that workspace, false for another workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const otherWorkspaceId = await insertWorkspace(db, userId)
      const yes = await checkPermission(db, {
        resourceType: "workspace",
        resourceId: workspaceId,
        permission: "view",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(yes, true)
      const no = await checkPermission(db, {
        resourceType: "workspace",
        resourceId: otherWorkspaceId,
        permission: "view",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(no, false)
    })
  }
)

test(
  "checkPermission(workspace.*) is false for a non-workspace-member subject",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const no = await checkPermission(db, {
        resourceType: "workspace",
        resourceId: workspaceId,
        permission: "view",
        subject: { type: "actor", id: "00000000-0000-0000-0000-000000000000" },
      })
      assert.equal(no, false)
    })
  }
)

test(
  "checkPermission(workspace.manage) is true for the workspace owner (admin) and false for a guest member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const ownerAllowed = await checkPermission(db, {
        resourceType: "workspace",
        resourceId: workspaceId,
        permission: "manage",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(ownerAllowed, true)
      const guestAllowed = await checkPermission(db, {
        resourceType: "workspace",
        resourceId: workspaceId,
        permission: "manage",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(guestAllowed, false)
    })
  }
)

test(
  "checkPermission(remote_agent.invoke) for an admin owner is true; non-admin without a binding is denied",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId, {
        createdByWorkspaceMemberId: ownerMemberId,
      })
      const ownerOk = await checkPermission(db, {
        resourceType: "remote_agent",
        resourceId: remoteAgentId,
        permission: "invoke",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(ownerOk, true)
      const guestDenied = await checkPermission(db, {
        resourceType: "remote_agent",
        resourceId: remoteAgentId,
        permission: "invoke",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(guestDenied, false)
    })
  }
)

test(
  "checkPermission(remote_agent.*) for an actor subject is false (only workspace_member supported)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const remoteAgentId = await insertRemoteAgent(db, workspaceId)
      const actorId = await insertActor(db, workspaceId)
      const allowed = await checkPermission(db, {
        resourceType: "remote_agent",
        resourceId: remoteAgentId,
        permission: "invoke",
        subject: { type: "actor", id: actorId },
      })
      assert.equal(allowed, false)
    })
  }
)

test(
  "checkPermission(conversation.view) is true for an active workspace_member participant, false otherwise",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const conversationId = await insertConversation(db, {
        workspaceId,
        createdByMemberId: ownerMemberId,
      })
      await addMemberParticipant(db, conversationId, ownerMemberId, "owner")
      const memberAllowed = await checkPermission(db, {
        resourceType: "conversation",
        resourceId: conversationId,
        permission: "view",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(memberAllowed, true)
      const nonMemberDenied = await checkPermission(db, {
        resourceType: "conversation",
        resourceId: conversationId,
        permission: "view",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(nonMemberDenied, false)
    })
  }
)

test(
  "checkPermission(conversation.manage) is true for the owner participant and false for a plain member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const conversationId = await insertConversation(db, {
        workspaceId,
        createdByMemberId: ownerMemberId,
      })
      await addMemberParticipant(db, conversationId, ownerMemberId, "owner")
      await addMemberParticipant(db, conversationId, guestMemberId, "member")

      const ownerOk = await checkPermission(db, {
        resourceType: "conversation",
        resourceId: conversationId,
        permission: "manage",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(ownerOk, true)
      const guestDenied = await checkPermission(db, {
        resourceType: "conversation",
        resourceId: conversationId,
        permission: "manage",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(guestDenied, false)
    })
  }
)

test(
  "checkPermission(conversation.view) for an actor participant is true; non-participant actor is denied",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const conversationId = await insertConversation(db, { workspaceId })
      const participatingActor = await insertActor(db, workspaceId)
      const outsiderActor = await insertActor(db, workspaceId)
      await addActorParticipant(db, conversationId, participatingActor)
      const ok = await checkPermission(db, {
        resourceType: "conversation",
        resourceId: conversationId,
        permission: "view",
        subject: { type: "actor", id: participatingActor },
      })
      assert.equal(ok, true)
      const denied = await checkPermission(db, {
        resourceType: "conversation",
        resourceId: conversationId,
        permission: "view",
        subject: { type: "actor", id: outsiderActor },
      })
      assert.equal(denied, false)
    })
  }
)

test(
  "checkPermission(installed_skill.*) is true for the workspace admin and false for a non-admin without a grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      const adminOk = await checkPermission(db, {
        resourceType: "installed_skill",
        resourceId: skillId,
        permission: "view",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(adminOk, true)
      const guestDenied = await checkPermission(db, {
        resourceType: "installed_skill",
        resourceId: skillId,
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(guestDenied, false)
    })
  }
)

test(
  "checkPermission(installed_skill.use) is true for a guest once a workspace-wide grant exists",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      await insertResourceGrant(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: workspaceSubjectTarget(workspaceId),
      })
      const ok = await checkPermission(db, {
        resourceType: "installed_skill",
        resourceId: skillId,
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(ok, true)
    })
  }
)

test(
  "checkPermission(plugin_installation.use) honors a workspace-wide grant for a guest member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: ownerMemberId,
        attachmentScopeSkillId: skillId,
      })
      await insertResourceGrant(db, {
        workspaceId,
        resourceType: "plugin_installation",
        resourceId: installationId,
        target: workspaceSubjectTarget(workspaceId),
      })
      const guestOk = await checkPermission(db, {
        resourceType: "plugin_installation",
        resourceId: installationId,
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(guestOk, true)
    })
  }
)

test(
  "checkPermission(plugin_installation.use) is false when no grant exists for a guest member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: ownerMemberId,
        attachmentScopeSkillId: skillId,
      })
      const denied = await checkPermission(db, {
        resourceType: "plugin_installation",
        resourceId: installationId,
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(denied, false)
    })
  }
)

test(
  "checkPermission(installed_skill.edit) stays true for a disabled skill the member owns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, guestMemberId } = await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, guestMemberId)
      await db
        .updateTable("workspaceResources")
        .set({ status: "disabled" } as any)
        .where("id", "=", skillId)
        .execute()
      const allowed = await checkPermission(db, {
        resourceType: "installed_skill",
        resourceId: skillId,
        permission: "edit",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, true)
    })
  }
)

test(
  "checkPermission(plugin_installation.edit) stays true for a disabled installation the member owns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, guestMemberId } = await seedOwnerMemberAndGuest(db)
      const scopeSkillId = await insertInstalledSkill(
        db,
        workspaceId,
        guestMemberId
      )
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: guestMemberId,
        attachmentScopeSkillId: scopeSkillId,
      })
      await db
        .updateTable("workspaceResources")
        .set({ status: "disabled" } as any)
        .where("id", "=", installationId)
        .execute()
      const allowed = await checkPermission(db, {
        resourceType: "plugin_installation",
        resourceId: installationId,
        permission: "edit",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, true)
    })
  }
)

// 3d hardening: the bindable "manage-or-grant" resources (installed_skill /
// plugin_installation / device_capability) historically returned `canManage`
// for ANY permission string — i.e. an unknown/typo'd permission was fail-OPEN
// to workspace managers and the resource creator. resolveBindableResourceAccess
// now gates on an explicit manageablePermissions whitelist, so an unknown
// permission denies even for the owner/creator, matching the `default: return
// false` arms of the actor/remote_agent/device helpers. device_capability
// shares the identical code path, so these skill/plugin cases cover its logic.
test(
  "checkPermission(installed_skill, <unknown permission>) is fail-closed even for the owner/creator",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId } = await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      // Sanity: the owner DOES have a known permission (proves the principal
      // is otherwise privileged, so the denial below is about the permission).
      assert.equal(
        await checkPermission(db, {
          resourceType: "installed_skill",
          resourceId: skillId,
          permission: "edit",
          subject: { type: "workspace_member", id: ownerMemberId },
        }),
        true
      )
      for (const permission of ["frobnicate", "", "USE", "delete_all"]) {
        const denied = await checkPermission(db, {
          resourceType: "installed_skill",
          resourceId: skillId,
          permission,
          subject: { type: "workspace_member", id: ownerMemberId },
        })
        assert.equal(
          denied,
          false,
          `unknown installed_skill permission "${permission}" must fail-closed`
        )
      }
    })
  }
)

test(
  "checkPermission(plugin_installation, <unknown permission>) is fail-closed even for the owner/creator",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId } = await seedOwnerMemberAndGuest(db)
      const skillId = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      const installationId = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: ownerMemberId,
        attachmentScopeSkillId: skillId,
      })
      assert.equal(
        await checkPermission(db, {
          resourceType: "plugin_installation",
          resourceId: installationId,
          permission: "delete",
          subject: { type: "workspace_member", id: ownerMemberId },
        }),
        true
      )
      for (const permission of ["frobnicate", "", "USE", "manage"]) {
        const denied = await checkPermission(db, {
          resourceType: "plugin_installation",
          resourceId: installationId,
          permission,
          subject: { type: "workspace_member", id: ownerMemberId },
        })
        assert.equal(
          denied,
          false,
          `unknown plugin_installation permission "${permission}" must fail-closed`
        )
      }
    })
  }
)

test(
  "checkPermission(automation_event_source.use) is denied without a grant",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      // Post-fold automation_event_source HAS a checkPermission case
      // (hasAutomationEventSourcePermission → use grant lookup), but with no
      // grant row for this subject it must deny.
      const denied = await checkPermission(db, {
        resourceType: "automation_event_source",
        resourceId: "00000000-0000-0000-0000-000000000000",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(denied, false)
      void ownerMemberId
      void workspaceId
    })
  }
)

test(
  "checkPermission(model_group.use) is true when the requesting member owns the group",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId } = await seedOwnerMemberAndGuest(db)
      const groupId = await insertModelGroup(db, {
        ownerType: "workspace_member",
        ownerWorkspaceMemberId: ownerMemberId,
      })
      const ok = await checkPermission(db, {
        resourceType: "model_group",
        resourceId: groupId,
        permission: "use",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(ok, true)
      void workspaceId
    })
  }
)

test(
  "checkPermission(model_group.use) returns false for a disabled group",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { ownerMemberId } = await seedOwnerMemberAndGuest(db)
      const groupId = await insertModelGroup(db, {
        ownerType: "workspace_member",
        ownerWorkspaceMemberId: ownerMemberId,
        isEnabled: false,
      })
      const denied = await checkPermission(db, {
        resourceType: "model_group",
        resourceId: groupId,
        permission: "use",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(denied, false)
    })
  }
)

test(
  "lookupResources(remote_agent.invoke) returns only owner-visible or granted remote agents",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const owned = await insertRemoteAgent(db, workspaceId, {
        createdByWorkspaceMemberId: guestMemberId,
      })
      const adminVisible = await insertRemoteAgent(db, workspaceId, {
        createdByWorkspaceMemberId: ownerMemberId,
      })
      const guestIds = await lookupResources(db, {
        resourceType: "remote_agent",
        permission: "invoke",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(guestIds.includes(owned))
      assert.ok(!guestIds.includes(adminVisible))

      const adminIds = await lookupResources(db, {
        resourceType: "remote_agent",
        permission: "invoke",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.ok(!adminIds.includes(owned))
      assert.ok(adminIds.includes(adminVisible))
    })
  }
)

test(
  "lookupResources(installed_skill.use) returns only explicitly granted skills",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const owned = await insertInstalledSkill(db, workspaceId, guestMemberId)
      const granted = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      await insertResourceGrant(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: granted,
        target: workspaceSubjectTarget(workspaceId),
      })
      const ids = await lookupResources(db, {
        resourceType: "installed_skill",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(!ids.includes(owned))
      assert.ok(ids.includes(granted))
    })
  }
)

test(
  "lookupResources(plugin_installation.use) returns only explicitly granted installations",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const skillForGuest = await insertInstalledSkill(
        db,
        workspaceId,
        guestMemberId
      )
      const skillForOwner = await insertInstalledSkill(
        db,
        workspaceId,
        ownerMemberId
      )
      const owned = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: guestMemberId,
        attachmentScopeSkillId: skillForGuest,
      })
      const granted = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: ownerMemberId,
        attachmentScopeSkillId: skillForOwner,
      })
      await insertResourceGrant(db, {
        workspaceId,
        resourceType: "plugin_installation",
        resourceId: granted,
        target: workspaceSubjectTarget(workspaceId),
      })
      const ids = await lookupResources(db, {
        resourceType: "plugin_installation",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(!ids.includes(owned))
      assert.ok(ids.includes(granted))
    })
  }
)

test(
  "lookupResources(installed_skill.edit) returns owned and manage-granted skills",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const owned = await insertInstalledSkill(db, workspaceId, guestMemberId)
      const managed = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      await insertWorkspaceResourceGrant(db, {
        workspaceId,
        workspaceResourceId: managed,
        target: {
          subject: {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            workspaceMemberId: guestMemberId,
          },
        },
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE],
        source: "manual",
      })
      await db
        .updateTable("workspaceResources")
        .set({ status: "disabled" } as any)
        .where("id", "in", [owned, managed])
        .execute()
      const ids = await lookupResources(db, {
        resourceType: "installed_skill",
        permission: "edit",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(ids.includes(owned))
      assert.ok(ids.includes(managed))
    })
  }
)

test(
  "lookupResources(plugin_installation.edit) returns owned and manage-granted installations",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const guestSkill = await insertInstalledSkill(
        db,
        workspaceId,
        guestMemberId
      )
      const ownerSkill = await insertInstalledSkill(
        db,
        workspaceId,
        ownerMemberId
      )
      const owned = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: guestMemberId,
        attachmentScopeSkillId: guestSkill,
      })
      const managed = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: ownerMemberId,
        attachmentScopeSkillId: ownerSkill,
      })
      await insertWorkspaceResourceGrant(db, {
        workspaceId,
        workspaceResourceId: managed,
        target: {
          subject: {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            workspaceMemberId: guestMemberId,
          },
        },
        permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE],
        source: "manual",
      })
      await db
        .updateTable("workspaceResources")
        .set({ status: "disabled" } as any)
        .where("id", "in", [owned, managed])
        .execute()
      const ids = await lookupResources(db, {
        resourceType: "plugin_installation",
        permission: "edit",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(ids.includes(owned))
      assert.ok(ids.includes(managed))
    })
  }
)

test(
  "lookupResources(automation_event_source.use) returns granted ids via the unified workspace_resource_grants path",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const eventSourceId = await insertAutomationEventSource(
        db,
        workspaceId,
        ownerMemberId
      )
      // "Open to all" = a workspace-subject `use` grant on the source root.
      // Post-fold this is an ordinary workspace_resource_grants row (the
      // resource_access_bindings registry was deleted), and the source must
      // still be enumerable to any workspace member for permission=use.
      await insertResourceGrant(db, {
        workspaceId,
        resourceType: "automation_event_source",
        resourceId: eventSourceId,
        target: workspaceSubjectTarget(workspaceId),
      })
      const ids = await lookupResources(db, {
        resourceType: "automation_event_source",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(
        ids.includes(eventSourceId),
        "workspace-wide use grant must surface the event source to any member"
      )
      // checkPermission(use) must agree with the lookup for the same subject.
      const allowed = await checkPermission(db, {
        resourceType: "automation_event_source",
        resourceId: eventSourceId,
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, true)
    })
  }
)

test(
  "lookupResources(model_group.use) returns the workspace-owned group for any workspace member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, guestMemberId } = await seedOwnerMemberAndGuest(db)
      const groupId = await insertModelGroup(db, {
        ownerType: "workspace",
        ownerWorkspaceId: workspaceId,
      })
      const ids = await lookupResources(db, {
        resourceType: "model_group",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(ids.includes(groupId))
    })
  }
)

test(
  "lookupResources(actor.*) for an actor subject returns just that actor; non-supported permission returns []",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId } = await seedOwnerMemberAndGuest(db)
      const actorId = await insertActor(db, workspaceId)
      const ids = await lookupResources(db, {
        resourceType: "actor",
        permission: "view",
        subject: { type: "actor", id: actorId },
      })
      assert.deepEqual(ids, [actorId])
      const otherPermission = await lookupResources(db, {
        resourceType: "actor",
        permission: "edit",
        subject: { type: "actor", id: actorId },
      })
      assert.deepEqual(otherPermission, [])
    })
  }
)

// ---- §4.2 owner-kind implicit matrix ----
//
// An actor/remote_agent OWNER of a resource gets implicit MANAGE on its OWN
// resource only (edit/grant/delete), but NO implicit contact_visible (view/
// invoke) and NO delegation. These pin that asymmetric matrix.

test(
  "checkPermission: an actor that OWNS another actor resource gets implicit manage (edit/grant/delete) but NOT view/invoke",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId } = await seedOwnerMemberAndGuest(db)
      const ownerActorId = await insertActor(db, workspaceId)
      const ownerActorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: ownerActorId,
      })
      const ownedResourceId = await insertActorOwnedBySubject(
        db,
        workspaceId,
        ownerActorSubjectId
      )

      for (const permission of ["edit", "grant", "delete"]) {
        assert.equal(
          await checkPermission(db, {
            resourceType: "actor",
            resourceId: ownedResourceId,
            permission,
            subject: { type: "actor", id: ownerActorId },
          }),
          true,
          `owner actor must have implicit manage permission "${permission}"`
        )
      }
      // No implicit contact_visible / use: view + invoke are denied.
      for (const permission of ["view", "invoke", "discover"]) {
        assert.equal(
          await checkPermission(db, {
            resourceType: "actor",
            resourceId: ownedResourceId,
            permission,
            subject: { type: "actor", id: ownerActorId },
          }),
          false,
          `owner actor must NOT get implicit contact-visibility permission "${permission}"`
        )
      }
    })
  }
)

test(
  "checkPermission: a non-owner actor has NO access to another actor resource (no delegation)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId } = await seedOwnerMemberAndGuest(db)
      const ownerActorId = await insertActor(db, workspaceId)
      const ownerActorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: ownerActorId,
      })
      const ownedResourceId = await insertActorOwnedBySubject(
        db,
        workspaceId,
        ownerActorSubjectId
      )
      const strangerActorId = await insertActor(db, workspaceId)
      for (const permission of ["edit", "grant", "delete", "view", "invoke"]) {
        assert.equal(
          await checkPermission(db, {
            resourceType: "actor",
            resourceId: ownedResourceId,
            permission,
            subject: { type: "actor", id: strangerActorId },
          }),
          false,
          `a non-owner actor must be denied "${permission}"`
        )
      }
    })
  }
)

test(
  "validate_workspace_resource_grant: a manage grant to an actor subject is rejected (manage stays member-only, no delegation)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId } = await seedOwnerMemberAndGuest(db)
      const ownerActorId = await insertActor(db, workspaceId)
      const ownerActorSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: ownerActorId,
      })
      const resourceId = await insertActorOwnedBySubject(
        db,
        workspaceId,
        ownerActorSubjectId
      )
      const granteeActorId = await insertActor(db, workspaceId)
      const granteeSubjectId = await upsertAccessSubject(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: granteeActorId,
      })
      // §4.2: explicit `manage` grants are hard-limited to unscoped
      // workspace_member subjects — an actor manage grant must be rejected so the
      // human authorization chain is preserved.
      await assert.rejects(
        () =>
          db
            .insertInto("workspaceResourceGrants")
            .values({
              workspaceId,
              workspaceResourceId: resourceId,
              subjectId: granteeSubjectId,
              permissions: [WORKSPACE_RESOURCE_GRANT_PERMISSION.MANAGE],
              status: "active",
              source: "manual",
            } as any)
            .execute(),
        /manage requires an unscoped workspace_member subject/i
      )
    })
  }
)

// subject-scope-refactor merge: the runtime-pair resource type was dropped
// (replaced by (subject, scope?) two-tuple). The former permission tests are
// intentionally deleted because the resource type and permissions no longer
// exist.

test(
  "checkPermission(memory_item.read) for a workspace_shared memory uses the workspace permission check",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const workspaceSubjectId = await upsertAccessSubject(db, {
        kind: "workspace",
        workspaceId,
      } as any)
      const spaceRow = await db
        .insertInto("memorySpaces")
        .values({
          workspaceId: workspaceId,
          ownerSubjectId: workspaceSubjectId,
          namespaceKey: "default",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const itemRow = await db
        .insertInto("memoryItems")
        .values({
          workspaceId: workspaceId,
          memorySpaceId: spaceRow.id,
          category: "fact",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const ok = await checkPermission(db, {
        resourceType: "memory_item",
        resourceId: itemRow.id as string,
        permission: "read",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(ok, true)
      const adminOk = await checkPermission(db, {
        resourceType: "memory_item",
        resourceId: itemRow.id as string,
        permission: "edit",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(adminOk, true)
    })
  }
)

test(
  "checkPermission(platform.manage) for a user with a platform binding is true; without one is false",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      await db
        .insertInto("platformAccessBindings")
        .values({ userId: userId, accessKey: "super_admin" })
        .execute()
      const ok = await checkPermission(db, {
        resourceType: "platform",
        resourceId: "synapse",
        permission: "manage",
        subject: { type: "user", id: userId },
      })
      assert.equal(ok, true)
      const wrongId = await checkPermission(db, {
        resourceType: "platform",
        resourceId: "not-synapse",
        permission: "manage",
        subject: { type: "user", id: userId },
      })
      assert.equal(wrongId, false)
      const noBinding = await checkPermission(db, {
        resourceType: "platform",
        resourceId: "synapse",
        permission: "manage",
        subject: { type: "user", id: await insertUser(db) },
      })
      assert.equal(noBinding, false)
    })
  }
)

test(
  "checkPermission with an empty resourceId returns false",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const userId = await insertUser(db)
      const workspaceId = await insertWorkspace(db, userId)
      const memberId = await insertWorkspaceMember(db, workspaceId, userId)
      const allowed = await checkPermission(db, {
        resourceType: "actor",
        resourceId: "",
        permission: "invoke",
        subject: { type: "workspace_member", id: memberId },
      })
      assert.equal(allowed, false)
    })
  }
)

test(
  "lookupResources(actor.invoke) only returns actors the member owns or is explicitly granted",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const owned = crypto.randomUUID()
      const ownerSubjectId = await memberSubjectId(db, ownerMemberId)
      await db
        .insertInto("workspaceResources")
        .values({
          id: owned,
          workspaceId: workspaceId,
          kind: "actor",
          displayName: "owned actor",
          ownerSubjectId,
          createdBySubjectId: ownerSubjectId,
          status: "active",
        } as any)
        .execute()
      await db
        .insertInto("actors")
        .values({
          id: owned,
          role: "assistant",
          title: "owned",
          currentVersion: 1,
        })
        .execute()
      const guestOwned = crypto.randomUUID()
      const guestSubjectId = await memberSubjectId(db, guestMemberId)
      await db
        .insertInto("workspaceResources")
        .values({
          id: guestOwned,
          workspaceId: workspaceId,
          kind: "actor",
          displayName: "guest actor",
          ownerSubjectId: guestSubjectId,
          createdBySubjectId: guestSubjectId,
          status: "active",
        } as any)
        .execute()
      await db
        .insertInto("actors")
        .values({
          id: guestOwned,
          role: "assistant",
          title: "guest",
          currentVersion: 1,
        })
        .execute()
      const ids = await lookupResources(db, {
        resourceType: "actor",
        permission: "invoke",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.ok(ids.includes(owned))
      assert.ok(!ids.includes(guestOwned))
    })
  }
)

test(
  "lookupResources for an unsupported resource type returns []",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { ownerMemberId } = await seedOwnerMemberAndGuest(db)
      const ids = await lookupResources(db, {
        resourceType: "workspace",
        permission: "view",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.deepEqual(ids, [])
    })
  }
)

test(
  "lookupResources(model_group.use) for an actor subject returns workspace-owned + actor-granted groups",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId } = await seedOwnerMemberAndGuest(db)
      const actorId = await insertActor(db, workspaceId)
      const wsGroup = await insertModelGroup(db, {
        ownerType: "workspace",
        ownerWorkspaceId: workspaceId,
      })
      const ids = await lookupResources(db, {
        resourceType: "model_group",
        permission: "use",
        subject: { type: "actor", id: actorId },
      })
      assert.ok(ids.includes(wsGroup))
    })
  }
)

async function insertRemoteAgent(
  db: AnyDb,
  workspaceId: string,
  params: { createdByWorkspaceMemberId?: string } = {}
): Promise<string> {
  const id = crypto.randomUUID()
  const ownerSubjectId = params.createdByWorkspaceMemberId
    ? await memberSubjectId(db, params.createdByWorkspaceMemberId)
    : null
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId: workspaceId,
      kind: "remote_agent",
      displayName: "test agent",
      ownerSubjectId,
      createdBySubjectId:
        ownerSubjectId ?? (await anyWorkspaceMemberSubjectId(db, workspaceId)),
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remoteAgents")
    .values({
      id,
      title: "test",
      runtimeKind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertConversation(
  db: AnyDb,
  params: { workspaceId: string; createdByMemberId?: string }
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspaceId: params.workspaceId,
      title: "test conversation",
      createdByWorkspaceMemberId: params.createdByMemberId ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function addMemberParticipant(
  db: AnyDb,
  conversationId: string,
  memberId: string,
  roleKey: string
) {
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: memberId,
  })
  await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversationId,
      subjectId: subjectId,
      roleKey: roleKey,
      state: "active",
    })
    .execute()
}

async function addActorParticipant(
  db: AnyDb,
  conversationId: string,
  actorId: string
) {
  const subjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  await db
    .insertInto("conversationParticipants")
    .values({
      conversationId: conversationId,
      subjectId: subjectId,
      roleKey: "member",
      state: "active",
    })
    .execute()
}

async function insertInstalledSkill(
  db: AnyDb,
  workspaceId: string,
  createdByMemberId: string
): Promise<string> {
  const snapshot = await db
    .insertInto("skillSnapshots")
    .values({
      name: "test-skill",
      description: "",
      contentHash: `hash-${Math.random().toString(36).slice(2, 10)}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const id = crypto.randomUUID()
  const ownerSubjectId = await memberSubjectId(db, createdByMemberId)
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId: workspaceId,
      kind: "installed_skill",
      displayName: "skill",
      ownerSubjectId,
      createdBySubjectId: ownerSubjectId,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("installedSkills")
    .values({
      id,
      currentSnapshotId: snapshot.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertPluginInstallation(
  db: AnyDb,
  params: {
    workspaceId: string
    installedByMemberId: string
    attachmentScopeSkillId: string
  }
): Promise<string> {
  const publisher = await db
    .insertInto("publishers")
    .values({
      slug: `pub-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "pub",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("catalogItems")
    .values({
      publisherId: publisher.id,
      itemKind: "plugin_package",
      slug: `plg-${Math.random().toString(36).slice(2, 8)}`,
      displayName: "plg",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const version = await db
    .insertInto("catalogVersions")
    .values({
      catalogItemId: item.id,
      version: "1.0.0",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  void params.attachmentScopeSkillId
  const id = crypto.randomUUID()
  const ownerSubjectId = await memberSubjectId(db, params.installedByMemberId)
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId: params.workspaceId,
      kind: "plugin_installation",
      displayName: "plg",
      ownerSubjectId,
      createdBySubjectId: ownerSubjectId,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("pluginInstallations")
    .values({
      id,
      catalogItemId: item.id,
      catalogVersionId: version.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// Post-fold: an automation_event_source is the 6th workspace_resources kind.
// Its display_name/status/owner/creator live on the workspace_resources ROOT
// (owner/creator are now access_subjects, not the dropped created_by_kind /
// created_by_workspace_member_id columns). Insert root-then-detail in the same
// (rolled-back) transaction — the detail-consistency trigger is DEFERRABLE
// INITIALLY DEFERRED so both rows are visible to it together.
async function insertAutomationEventSource(
  db: AnyDb,
  workspaceId: string,
  createdByMemberId: string,
  opts: { status?: string } = {}
): Promise<string> {
  const id = crypto.randomUUID()
  const creatorSubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE_MEMBER,
    workspaceMemberId: createdByMemberId,
  })
  await db
    .insertInto("workspaceResources")
    .values({
      id,
      workspaceId: workspaceId,
      kind: "automation_event_source",
      displayName: "src",
      ownerSubjectId: creatorSubjectId,
      createdBySubjectId: creatorSubjectId,
      status: opts.status ?? "active",
    } as any)
    .execute()
  await db
    .insertInto("automationEventSources")
    .values({
      id,
      workspaceId: workspaceId,
      providerKind: "internal",
      sourceKey: `src-${Math.random().toString(36).slice(2, 10)}`,
    } as any)
    .execute()
  return id
}

async function insertModelGroup(
  db: AnyDb,
  params: {
    ownerType: "platform" | "workspace" | "workspace_member"
    ownerWorkspaceId?: string
    ownerWorkspaceMemberId?: string
    isEnabled?: boolean
  }
): Promise<string> {
  const row = await db
    .insertInto("modelGroups")
    .values({
      ownerType: params.ownerType,
      ownerWorkspaceId: params.ownerWorkspaceId ?? null,
      ownerWorkspaceMemberId: params.ownerWorkspaceMemberId ?? null,
      name: "grp",
      isEnabled: params.isEnabled ?? true,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertResourceGrant(
  db: AnyDb,
  params: {
    workspaceId: string
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "device_capability"
      | "automation_event_source"
      | "actor"
      | "remote_agent"
    resourceId: string
    target: {
      subjectKind: "workspace" | "workspace_member" | "actor"
      subjectWorkspaceId: string | null
      subjectWorkspaceMemberId?: string | null
      subjectActorId?: string | null
      subjectConversationId?: null
      subjectConversationActorContextId?: null
    }
  }
) {
  // Post-fold: every resource kind — including automation_event_source — is
  // authorized through workspace_resource_grants. actor/remote_agent take a
  // contact_visible grant; everything else (skill / plugin / device_capability /
  // automation_event_source) takes a use grant.
  const subject =
    params.target.subjectKind === "workspace"
      ? {
          kind: SUBJECT_KIND.WORKSPACE,
          workspaceId: params.target.subjectWorkspaceId!,
        }
      : params.target.subjectKind === "workspace_member"
        ? {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            workspaceMemberId: params.target.subjectWorkspaceMemberId!,
          }
        : {
            kind: SUBJECT_KIND.ACTOR,
            actorId: params.target.subjectActorId!,
          }
  const permissions =
    params.resourceType === "actor" || params.resourceType === "remote_agent"
      ? [WORKSPACE_RESOURCE_GRANT_PERMISSION.CONTACT_VISIBLE]
      : [WORKSPACE_RESOURCE_GRANT_PERMISSION.USE]
  await insertWorkspaceResourceGrant(db, {
    workspaceId: params.workspaceId,
    workspaceResourceId: params.resourceId,
    target: { subject } as any,
    permissions,
    source: "manual",
  })
}

function workspaceSubjectTarget(workspaceId: string) {
  return {
    subjectKind: "workspace" as const,
    subjectWorkspaceId: workspaceId,
    subjectWorkspaceMemberId: null,
    subjectActorId: null,
    subjectConversationId: null,
    subjectConversationActorContextId: null,
  }
}

async function seedOwnerMemberAndGuest(db: AnyDb) {
  const ownerUserId = await insertUser(db)
  const workspaceId = await insertWorkspace(db, ownerUserId)
  const ownerMemberId = await insertWorkspaceMember(
    db,
    workspaceId,
    ownerUserId
  )
  const guestUserId = await insertUser(db)
  const guestMemberId = await insertWorkspaceMember(
    db,
    workspaceId,
    guestUserId
  )
  return { workspaceId, ownerMemberId, guestMemberId }
}

// ---- device permission regression coverage (relay→device naming drift) ----
//
// Inserts a device owned by `ownerMemberId` (or by nobody) so the
// non-ownership branch of hasDevicePermission is the one under test: the
// `manage_devices` workspace-permission lookup. Before the fix, evaluator.ts
// queried the stale `manage_relays` key, which is absent from the rules table,
// so evaluateWorkspacePermission returned false for EVERY non-owner — silently
// denying workspace admins and device_admin keyholders.
async function insertDevice(
  db: AnyDb,
  workspaceId: string,
  ownerWorkspaceMemberId: string | null
): Promise<{ deviceId: string; exposureId: string; capabilityId: string }> {
  const suffix = Math.random().toString(36).slice(2, 10)
  const dev = await db
    .insertInto("devices")
    .values({
      workspaceId: workspaceId,
      ownerWorkspaceMemberId: ownerWorkspaceMemberId,
      title: "regression device",
      publicKey: `pk-${suffix}`,
      publicKeyFingerprint: `fp-${suffix}`,
      trustStatus: "trusted",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const svc = await db
    .insertInto("deviceServices")
    .values({
      deviceId: dev.id as string,
      serviceKind: "device_runtime",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const exp = await db
    .insertInto("deviceExposures")
    .values({
      deviceId: dev.id as string,
      serviceId: svc.id as string,
      stableKey: `exp-${suffix}`,
      displayName: "regression exposure",
      transport: "stdio",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const capOwnerSubjectId = ownerWorkspaceMemberId
    ? await memberSubjectId(db, ownerWorkspaceMemberId)
    : null
  const cap = await db
    .insertInto("workspaceResources")
    .values({
      id: crypto.randomUUID(),
      workspaceId: workspaceId,
      kind: "device_capability",
      displayName: "regression exposure",
      ownerSubjectId: capOwnerSubjectId,
      createdBySubjectId:
        capOwnerSubjectId ??
        (await anyWorkspaceMemberSubjectId(db, workspaceId)),
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("deviceCapabilities")
    .values({
      id: cap.id as string,
      exposureId: exp.id as string,
    } as any)
    .execute()
  return {
    deviceId: dev.id as string,
    exposureId: exp.id as string,
    capabilityId: cap.id as string,
  }
}

async function grantWorkspaceAccessKey(
  db: AnyDb,
  workspaceMemberId: string,
  accessKey: string
): Promise<void> {
  await db
    .insertInto("workspaceAccessBindings")
    .values({ workspaceMemberId: workspaceMemberId, accessKey: accessKey })
    .execute()
}

test(
  "checkPermission(device.manage) is granted to a device_admin keyholder for a device they do not own",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      // Device owned by the workspace owner; the guest is NOT the device owner.
      const { deviceId } = await insertDevice(db, workspaceId, ownerMemberId)
      // Without the key the guest is denied (ownership-only fallback).
      const beforeKey = await checkPermission(db, {
        resourceType: "device",
        resourceId: deviceId,
        permission: "manage",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(beforeKey, false)
      // Granting device_admin must flip it to allowed via manage_devices.
      await grantWorkspaceAccessKey(db, guestMemberId, "device_admin")
      const afterKey = await checkPermission(db, {
        resourceType: "device",
        resourceId: deviceId,
        permission: "manage",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(afterKey, true)
    })
  }
)

test(
  "checkPermission(device.*) is granted to the workspace admin owner and to the device owner, denied to a plain non-owner member",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      // Device owned by the guest member (a non-admin).
      const { deviceId, exposureId, capabilityId } = await insertDevice(
        db,
        workspaceId,
        guestMemberId
      )
      // Workspace owner (admin) can manage any device via adminGrants.
      for (const permission of ["view", "manage", "delete"] as const) {
        const adminOk = await checkPermission(db, {
          resourceType: "device",
          resourceId: deviceId,
          permission,
          subject: { type: "workspace_member", id: ownerMemberId },
        })
        assert.equal(adminOk, true, `admin ${permission}`)
      }
      // Device owner can manage their own device.
      const ownerOk = await checkPermission(db, {
        resourceType: "device",
        resourceId: deviceId,
        permission: "manage",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(ownerOk, true)
      // Exposure + capability handlers delegate to the same device check, so
      // the admin reaches them too (regression: the capability manage path also
      // used the stale manage_relays key).
      const adminExposure = await checkPermission(db, {
        resourceType: "device_exposure",
        resourceId: exposureId,
        permission: "manage",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(adminExposure, true)
      const adminCapability = await checkPermission(db, {
        resourceType: "device_capability",
        resourceId: capabilityId,
        permission: "edit",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(adminCapability, true)
      // A plain member who neither owns the device nor holds device_admin is
      // denied — confirms the fix did not over-grant.
      const strangerUserId = await insertUser(db)
      const strangerMemberId = await insertWorkspaceMember(
        db,
        workspaceId,
        strangerUserId
      )
      const strangerDenied = await checkPermission(db, {
        resourceType: "device",
        resourceId: deviceId,
        permission: "manage",
        subject: { type: "workspace_member", id: strangerMemberId },
      })
      assert.equal(strangerDenied, false)
    })
  }
)

test(
  "checkPermission(device_capability.grant) stays true for a deprecated capability the member owns",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, guestMemberId } = await seedOwnerMemberAndGuest(db)
      const { capabilityId } = await insertDevice(
        db,
        workspaceId,
        guestMemberId
      )
      await db
        .updateTable("workspaceResources")
        .set({ status: "deprecated" } as any)
        .where("id", "=", capabilityId)
        .execute()

      const allowed = await checkPermission(db, {
        resourceType: "device_capability",
        resourceId: capabilityId,
        permission: "grant",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(allowed, true)
    })
  }
)

test(
  "lookupResources(device_capability.view) returns a non-owned active capability only when explicitly granted",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      // Capability on a device owned by the workspace owner — the guest is NOT
      // the device owner, so visibility hinges on the manage_devices listing
      // path (listManageableCapabilityIds), the same broken-then-fixed key.
      const { capabilityId } = await insertDevice(
        db,
        workspaceId,
        ownerMemberId
      )

      // Plain member without device_admin: the manageable-listing falls back to
      // own-device only, so a non-owned capability is NOT enumerated. (It also
      // has no resource grant, so the granted-ids leg returns nothing.)
      const beforeKey = await lookupResources(db, {
        resourceType: "device_capability",
        permission: "view",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(beforeKey.includes(capabilityId), false)

      // device_admin alone no longer implies discovery of capability resources.
      await grantWorkspaceAccessKey(db, guestMemberId, "device_admin")
      const afterKey = await lookupResources(db, {
        resourceType: "device_capability",
        permission: "view",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.equal(afterKey.includes(capabilityId), false)

      // Even the workspace owner does not discover it without an explicit use grant.
      const adminIds = await lookupResources(db, {
        resourceType: "device_capability",
        permission: "view",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.equal(adminIds.includes(capabilityId), false)
    })
  }
)
