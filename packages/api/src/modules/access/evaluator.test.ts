import test from "node:test"
import assert from "node:assert/strict"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { checkPermission, lookupResources } from "./evaluator.js"
import {
  grantApprovedAccess,
  setAccessPolicy,
} from "./default-access-policy.js"
import { upsertAccessSubject } from "./subject-registry.js"

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
      owner_id: ownerId,
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
  "checkPermission(actor.invoke) is false for a non-owner member when the actor is approval_required and not granted",
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
  "checkPermission(actor.invoke) is true for any workspace member once setAccessPolicy(workspace_open) writes the default_open binding",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, actorId, guestMemberId } =
        await seedOwnerAndGuest(db)
      await setAccessPolicy(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        policy: "workspace_open",
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

      await grantApprovedAccess(db, {
        resourceType: "actor",
        resourceId: actorId,
        workspaceId,
        grantedToMemberId: guestMemberId,
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
      await insertBinding(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: workspaceTarget(workspaceId),
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
        attachmentTargetSkillId: skillId,
      })
      await insertBinding(db, {
        workspaceId,
        resourceType: "plugin_installation",
        resourceId: installationId,
        target: workspaceTarget(workspaceId),
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
        attachmentTargetSkillId: skillId,
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
        attachmentTargetSkillId: skillId,
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
  "checkPermission(automation_event_source.*) is denied without a binding (and the route falls through to default false)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      // automation_event_source does not have its own checkPermission case;
      // it should fall through to the switch's default and return false.
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
  "lookupResources(remote_agent.invoke) returns owned remote agents for the creating member",
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
      assert.ok(adminIds.includes(owned))
      assert.ok(adminIds.includes(adminVisible))
    })
  }
)

test(
  "lookupResources(installed_skill.use) includes granted skills + manageable own skills",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId, guestMemberId } =
        await seedOwnerMemberAndGuest(db)
      const owned = await insertInstalledSkill(db, workspaceId, guestMemberId)
      const granted = await insertInstalledSkill(db, workspaceId, ownerMemberId)
      await insertBinding(db, {
        workspaceId,
        resourceType: "installed_skill",
        resourceId: granted,
        target: workspaceTarget(workspaceId),
      })
      const ids = await lookupResources(db, {
        resourceType: "installed_skill",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(ids.includes(owned))
      assert.ok(ids.includes(granted))
    })
  }
)

test(
  "lookupResources(plugin_installation.use) returns the granted set + manageable own installations",
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
        attachmentTargetSkillId: skillForGuest,
      })
      const granted = await insertPluginInstallation(db, {
        workspaceId,
        installedByMemberId: ownerMemberId,
        attachmentTargetSkillId: skillForOwner,
      })
      await insertBinding(db, {
        workspaceId,
        resourceType: "plugin_installation",
        resourceId: granted,
        target: workspaceTarget(workspaceId),
      })
      const ids = await lookupResources(db, {
        resourceType: "plugin_installation",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(ids.includes(owned))
      assert.ok(ids.includes(granted))
    })
  }
)

test(
  "lookupResources(automation_event_source.use) returns granted ids via the resource_access_bindings registry",
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
      await insertBinding(db, {
        workspaceId,
        resourceType: "automation_event_source",
        resourceId: eventSourceId,
        target: workspaceTarget(workspaceId),
      })
      const ids = await lookupResources(db, {
        resourceType: "automation_event_source",
        permission: "use",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(ids.includes(eventSourceId))
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

// subject-scope-refactor merge: conversation_actor_context resource_type
// was dropped (replaced by (subject, scope?) two-tuple). The two former
// tests for `checkPermission(conversation_actor_context.memory_read)` and
// `checkPermission(conversation_actor_context.*)` are intentionally
// deleted — the resource type and permissions no longer exist.

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
        .insertInto("memory_spaces")
        .values({
          workspace_id: workspaceId,
          owner_subject_id: workspaceSubjectId,
          namespace_key: "default",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const itemRow = await db
        .insertInto("memory_items")
        .values({
          workspace_id: workspaceId,
          memory_space_id: spaceRow.id,
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
        .insertInto("platform_access_bindings")
        .values({ user_id: userId, access_key: "super_admin" })
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
  "lookupResources(actor.invoke) for an admin owner returns every active actor in the workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const { workspaceId, ownerMemberId } = await seedOwnerMemberAndGuest(db)
      const a1 = await insertActor(db, workspaceId)
      const a2 = await insertActor(db, workspaceId)
      const ids = await lookupResources(db, {
        resourceType: "actor",
        permission: "invoke",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.ok(ids.includes(a1))
      assert.ok(ids.includes(a2))
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
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: workspaceId,
      name: "test agent",
      title: "test",
      runtime_kind: "claude_code",
      created_by_workspace_member_id: params.createdByWorkspaceMemberId ?? null,
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
      workspace_id: params.workspaceId,
      title: "test conversation",
      created_by_workspace_member_id: params.createdByMemberId ?? null,
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
    memberId,
  })
  await db
    .insertInto("conversation_participants")
    .values({
      conversation_id: conversationId,
      subject_id: subjectId,
      role_key: roleKey,
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
    .insertInto("conversation_participants")
    .values({
      conversation_id: conversationId,
      subject_id: subjectId,
      role_key: "member",
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
    .insertInto("skill_snapshots")
    .values({
      name: "test-skill",
      description: "",
      content_hash: `hash-${Math.random().toString(36).slice(2, 10)}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const row = await db
    .insertInto("installed_skills")
    .values({
      workspace_id: workspaceId,
      slug: `s-${Math.random().toString(36).slice(2, 10)}`,
      name: "skill",
      current_snapshot_id: snapshot.id,
      created_by_workspace_member_id: createdByMemberId,
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
    attachmentTargetSkillId: string
  }
): Promise<string> {
  const publisher = await db
    .insertInto("publishers")
    .values({
      slug: `pub-${Math.random().toString(36).slice(2, 8)}`,
      display_name: "pub",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("catalog_items")
    .values({
      publisher_id: publisher.id,
      item_kind: "plugin_package",
      slug: `plg-${Math.random().toString(36).slice(2, 8)}`,
      display_name: "plg",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const version = await db
    .insertInto("catalog_versions")
    .values({
      catalog_item_id: item.id,
      version: "1.0.0",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const attachmentSubject = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.WORKSPACE,
    workspaceId: params.workspaceId,
  })
  void params.attachmentTargetSkillId
  const row = await db
    .insertInto("plugin_installations")
    .values({
      workspace_id: params.workspaceId,
      catalog_item_id: item.id,
      catalog_version_id: version.id,
      display_name: "plg",
      attachment_subject_id: attachmentSubject,
      installed_by_workspace_member_id: params.installedByMemberId,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertAutomationEventSource(
  db: AnyDb,
  workspaceId: string,
  createdByMemberId: string
): Promise<string> {
  const row = await db
    .insertInto("automation_event_sources")
    .values({
      workspace_id: workspaceId,
      provider_kind: "internal",
      source_key: `src-${Math.random().toString(36).slice(2, 10)}`,
      name: "src",
      created_by_kind: "workspace_member",
      created_by_workspace_member_id: createdByMemberId,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
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
    .insertInto("model_groups")
    .values({
      owner_type: params.ownerType,
      owner_workspace_id: params.ownerWorkspaceId ?? null,
      owner_workspace_member_id: params.ownerWorkspaceMemberId ?? null,
      name: "grp",
      is_enabled: params.isEnabled ?? true,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function insertBinding(
  db: AnyDb,
  params: {
    workspaceId: string
    resourceType:
      | "installed_skill"
      | "plugin_installation"
      | "automation_event_source"
      | "actor"
      | "remote_agent"
    resourceId: string
    target: {
      targetType: "workspace" | "workspace_member" | "actor"
      subjectWorkspaceId: string | null
      subjectWorkspaceMemberId?: string | null
      subjectActorId?: string | null
      subjectConversationId?: null
      subjectConversationActorContextId?: null
    }
  }
) {
  const subjectKind =
    params.target.targetType === "workspace"
      ? SUBJECT_KIND.WORKSPACE
      : params.target.targetType === "workspace_member"
        ? SUBJECT_KIND.WORKSPACE_MEMBER
        : SUBJECT_KIND.ACTOR
  const ref =
    subjectKind === SUBJECT_KIND.WORKSPACE
      ? {
          kind: SUBJECT_KIND.WORKSPACE,
          workspaceId: params.target.subjectWorkspaceId!,
        }
      : subjectKind === SUBJECT_KIND.WORKSPACE_MEMBER
        ? {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: params.target.subjectWorkspaceMemberId!,
          }
        : {
            kind: SUBJECT_KIND.ACTOR,
            actorId: params.target.subjectActorId!,
          }
  const subjectId = await upsertAccessSubject(db, ref)
  await db
    .insertInto("resource_access_bindings")
    .values({
      workspace_id: params.workspaceId,
      resource_type: params.resourceType,
      installed_skill_id:
        params.resourceType === "installed_skill" ? params.resourceId : null,
      plugin_installation_id:
        params.resourceType === "plugin_installation"
          ? params.resourceId
          : null,
      automation_event_source_id:
        params.resourceType === "automation_event_source"
          ? params.resourceId
          : null,
      actor_id: params.resourceType === "actor" ? params.resourceId : null,
      remote_agent_id:
        params.resourceType === "remote_agent" ? params.resourceId : null,
      subject_id: subjectId,
      status: "active",
      source: "manual",
    })
    .execute()
}

function workspaceTarget(workspaceId: string) {
  return {
    targetType: "workspace" as const,
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
      workspace_id: workspaceId,
      owner_workspace_member_id: ownerWorkspaceMemberId,
      title: "regression device",
      public_key: `pk-${suffix}`,
      public_key_fingerprint: `fp-${suffix}`,
      trust_status: "trusted",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const svc = await db
    .insertInto("device_services")
    .values({
      device_id: dev.id as string,
      service_kind: "device_runtime",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const exp = await db
    .insertInto("device_exposures")
    .values({
      device_id: dev.id as string,
      service_id: svc.id as string,
      stable_key: `exp-${suffix}`,
      display_name: "regression exposure",
      transport: "stdio",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const cap = await db
    .insertInto("device_capabilities")
    .values({
      workspace_id: workspaceId,
      exposure_id: exp.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
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
    .insertInto("workspace_access_bindings")
    .values({ workspace_member_id: workspaceMemberId, access_key: accessKey })
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
  "lookupResources(device_capability.view) returns a non-owned active capability for a device_admin keyholder but not for a plain member",
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

      // Granting device_admin must surface the non-owned active capability via
      // listManageableCapabilityIds (regression: with the stale manage_relays
      // key this listing silently returned own-device only for everyone).
      await grantWorkspaceAccessKey(db, guestMemberId, "device_admin")
      const afterKey = await lookupResources(db, {
        resourceType: "device_capability",
        permission: "view",
        subject: { type: "workspace_member", id: guestMemberId },
      })
      assert.ok(afterKey.includes(capabilityId))

      // Workspace owner (admin) sees it via the adminGrants path too.
      const adminIds = await lookupResources(db, {
        resourceType: "device_capability",
        permission: "view",
        subject: { type: "workspace_member", id: ownerMemberId },
      })
      assert.ok(adminIds.includes(capabilityId))
    })
  }
)
