import test from "node:test"
import assert from "node:assert/strict"
import {
  remoteAgentRef,
  conversationRef,
  subjectScopeLabel,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import {
  buildResourceAccessBindingInsertValues,
  loadAccessBindingRowsForResources,
  listResourceIdsForWorkspaceByBindingFilter,
} from "../access/binding-storage.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import {
  normalizeAccessBindingRow,
  readAccessBindingTarget,
} from "../access/bindings.js"
import {
  targetSupportsConversationTypeOverride,
  validateConversationScopedAccessTarget,
} from "../access/policy.js"
import {
  buildSkillAccessRow,
  matchesScopeTarget,
  type SkillScopeTarget,
} from "./service.js"

/**
 * Round 10 review (P3) regression for remote_agent + conversation scope
 * service-level update paths.
 *
 * `updateInstalledSkillAccessGrant` and `updateInstalledSkill` both:
 *   1. Load the AccessBindingRow for the grant.
 *   2. Call `skillBindingToAccessTarget(row)` to recover the
 *      ScopedSubjectTarget shape.
 *   3. Pass that target into `assertGrantConversationTypeOverrideAllowed`
 *      / `validateConversationScopedAccessTarget`.
 *
 * Before the round-10 fix to skillBindingToAccessTarget (replacing the
 * 5-value legacy label switch with a direct `readAccessBindingTarget`
 * call), step 2 silently collapsed any remote_agent grant — including
 * `remote_agent + scope=conversation` — into a `{ subject: workspace }`
 * target. The downstream policy checks then ran against the wrong
 * shape: `targetSupportsConversationTypeOverride` returned true (it
 * treats workspace as override-eligible), and
 * `validateConversationScopedAccessTarget` saw no conversation scope
 * and bailed out, skipping both the conversation-type policy check
 * and the active-participant gate.
 *
 * The tests below run the same three-step pipeline directly — without
 * the surrounding service infrastructure that hard-wires the global
 * db pool — and assert the post-fix behavior:
 *
 *   1. The decoded target carries `subject=remote_agent +
 *      scope=conversation` (not collapsed to workspace).
 *   2. `targetSupportsConversationTypeOverride(decoded)` returns FALSE,
 *      so any update of `conversationTypeMaskOverride` is rejected
 *      by `assertGrantConversationTypeOverrideAllowed`.
 *   3. `validateConversationScopedAccessTarget(decoded)` runs the
 *      remote_agent active-participant gate — rejecting the update
 *      when the participant row is missing, accepting it when present.
 */

const NS = "skill-grant-update"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function newWorkspace(db: Kysely<any>): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@${NS}`,
      name: "owner",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({
      owner_id: user.id as string,
      slug: `ws-${rid()}`,
      name: `${NS} ws`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return ws.id as string
}

async function newRemoteAgent(db: Kysely<any>, wsId: string): Promise<string> {
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: wsId,
      name: `agent-${rid()}`,
      title: `${NS} agent`,
      runtime_kind: "claude_code",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newConversation(db: Kysely<any>, wsId: string): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspace_id: wsId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newInstalledSkill(
  db: Kysely<any>,
  wsId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@${NS}`,
      name: "creator",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: user.id as string,
      trust_level: "admin",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const snapshot = await db
    .insertInto("skill_snapshots")
    .values({
      name: "test-skill",
      description: "",
      content_hash: `hash-${rid()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const row = await db
    .insertInto("installed_skills")
    .values({
      workspace_id: wsId,
      slug: `s-${rid()}`,
      name: "skill",
      current_snapshot_id: snapshot.id as string,
      created_by_workspace_member_id: member.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "skillBindingToAccessTarget decodes remote_agent + conversation scope correctly (no collapse to workspace) — round-10 P2",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const conversationId = await newConversation(db, wsId)
      const skillId = await newInstalledSkill(db, wsId)

      const bindingValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(conversationId),
        },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(bindingValues)
        .execute()

      // Read the grant back the way the service does.
      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "installed_skill",
        resourceIds: [skillId],
      })
      assert.equal(rows.length, 1)
      const target = readAccessBindingTarget(
        normalizeAccessBindingRow(rows[0] as any) as any
      )

      // Round-10 fix: the decoded target is the actual scoped shape,
      // not a workspace fallback.
      assert.equal(
        subjectScopeLabel(target as any),
        "remote_agent"
      )
      assert.equal(target.subject.kind, "remote_agent")
      assert.equal(target.scope?.kind, "conversation")

      // Direct consequence: conversation-type override is rejected
      // (this is the gate `assertGrantConversationTypeOverrideAllowed`
      // consults in updateInstalledSkillAccessGrant /
      // updatePluginInstallation).
      assert.equal(
        targetSupportsConversationTypeOverride(target as any),
        false,
        "remote_agent + scope=conversation must NOT support conversation-type override"
      )
    })
  }
)

test(
  "validateConversationScopedAccessTarget gates remote_agent + conversation scope by participant — round-10 P3",
  { timeout: 5 * 60_000 },
  async () => {
    // Verifies that after decoding the grant (the round-10 fix), the
    // policy validator fires its remote_agent active-participant check
    // — which is what the service-level update paths
    // (updateInstalledSkillAccessGrant + updateInstalledSkill) trigger.
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const conversationId = await newConversation(db, wsId)
      const skillId = await newInstalledSkill(db, wsId)

      const bindingValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(conversationId),
        },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(bindingValues)
        .execute()

      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "installed_skill",
        resourceIds: [skillId],
      })
      const target = readAccessBindingTarget(
        normalizeAccessBindingRow(rows[0] as any) as any
      )

      // No participant row yet → validator rejects the (re-validated)
      // grant.
      await assert.rejects(
        validateConversationScopedAccessTarget({
          db,
          target: target as any,
          effectiveConversationTypeMask: 0b1111,
          buildError: (m) => new Error(m),
        }),
        /active participant/
      )

      // Add the participant → validator now accepts the same grant.
      const remoteAgentSubjectId = await upsertAccessSubject(db as any, {
        kind: "remote_agent" as any,
        remoteAgentId,
      })
      await db
        .insertInto("conversation_participants")
        .values({
          conversation_id: conversationId,
          subject_id: remoteAgentSubjectId,
          state: "active",
        } as any)
        .execute()
      const ok = await validateConversationScopedAccessTarget({
        db,
        target: target as any,
        effectiveConversationTypeMask: 0b1111,
        buildError: (m) => new Error(m),
      })
      assert.ok(ok)
    })
  }
)

/**
 * Round 11 review (P3, plugin side): same shape as the skill tests above.
 * The plugin install / update entry points use
 * `installationAccessRowToTarget` (mcp-plugins/service.ts) — the
 * mcp-plugins counterpart of `skillBindingToAccessTarget` — and feed
 * into the same `targetSupportsConversationTypeOverride` and
 * `validateConversationScopedAccessTarget` gates. The round-10 fix
 * collapsed both reverse mappers to `readAccessBindingTarget`, so the
 * regression coverage must match on both sides.
 *
 * Service-level architectural constraint: grantPluginInstallationAccess
 * / updatePluginInstallationAccessGrant / updatePluginInstallation use
 * the global db / pool, which the testcontainer-backed withTestDb
 * helper can't override without an infrastructure refactor (same
 * limitation as moveMemoryToSpace — see move-permission.test.ts).
 * So this test reproduces the same three-step pipeline the service
 * walks (load row → decode target → policy gate) directly against the
 * test container.
 */
async function newPluginInstallation(
  db: Kysely<any>,
  wsId: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@${NS}-plg`,
      name: "installer",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: user.id as string,
      trust_level: "admin",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const publisher = await db
    .insertInto("publishers")
    .values({
      slug: `pub-${rid()}`,
      display_name: "pub",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const item = await db
    .insertInto("catalog_items")
    .values({
      publisher_id: publisher.id as string,
      item_kind: "plugin_package",
      slug: `plg-${rid()}`,
      display_name: "plg",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const version = await db
    .insertInto("catalog_versions")
    .values({
      catalog_item_id: item.id as string,
      version: "1.0.0",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const attachmentSubject = await upsertAccessSubject(db as any, {
    kind: "workspace" as any,
    workspaceId: wsId,
  })
  const row = await db
    .insertInto("plugin_installations")
    .values({
      workspace_id: wsId,
      catalog_item_id: item.id as string,
      catalog_version_id: version.id as string,
      display_name: "plg",
      attachment_subject_id: attachmentSubject,
      installed_by_workspace_member_id: member.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "installationAccessRowToTarget decodes remote_agent + conversation scope correctly (plugin side parallel of P2)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const remoteAgentId = await newRemoteAgent(db, wsId)
      const conversationId = await newConversation(db, wsId)
      const installationId = await newPluginInstallation(db, wsId)

      const bindingValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "plugin_installation",
        resourceId: installationId,
        target: {
          subject: remoteAgentRef(remoteAgentId),
          scope: conversationRef(conversationId),
        },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(bindingValues)
        .execute()

      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "plugin_installation",
        resourceIds: [installationId],
      })
      assert.equal(rows.length, 1)
      const target = readAccessBindingTarget(
        normalizeAccessBindingRow(rows[0] as any) as any
      )

      assert.equal(
        subjectScopeLabel(target as any),
        "remote_agent"
      )
      assert.equal(target.subject.kind, "remote_agent")
      assert.equal(target.scope?.kind, "conversation")

      assert.equal(
        targetSupportsConversationTypeOverride(target as any),
        false,
        "remote_agent + scope=conversation plugin grant must NOT support conversation-type override"
      )
    })
  }
)

/**
 * Round 11 review (P2 regression coverage for workspace_member):
 * exercises the full insert-then-decode round-trip for a
 * workspace_member-target skill binding. Pre-round-11, SkillScopeTarget
 * didn't carry workspaceMemberId — so although a controller could
 * accept a workspace_member grant, the install / attach flow crashed
 * at the second scopedTargetFromSkillUseScope call inside
 * ensureSkillBinding with "workspaceMemberId is required for
 * workspace_member scope". The unit-test surface
 * (scopedTargetFromSkillUseScope, normalizeScopeTarget) is not
 * exported, so we verify the same load-path the service uses:
 * insert a workspace_member binding, decode via the
 * readAccessBindingTarget pipeline, and assert the workspace_member
 * subject survives intact.
 */
test(
  "workspace_member skill grant round-trips via the canonical decoder — round-11 P2",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      // Reuse the same user→member fixture builder by inserting a
      // workspace member directly (no admin trust needed for this test).
      const user = await db
        .insertInto("users")
        .values({
          email: `${rid()}@${NS}-wm`,
          name: "member",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const member = await db
        .insertInto("workspace_members")
        .values({
          workspace_id: wsId,
          user_id: user.id as string,
          trust_level: "member",
        } as any)
        .returning("id")
        .executeTakeFirstOrThrow()
      const memberId = member.id as string
      const skillId = await newInstalledSkill(db, wsId)

      const bindingValues = await buildResourceAccessBindingInsertValues(db, {
        workspaceId: wsId,
        resourceType: "installed_skill",
        resourceId: skillId,
        target: { subject: { kind: "workspace_member", memberId } },
      })
      await db
        .insertInto("resource_access_bindings")
        .values(bindingValues)
        .execute()

      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "installed_skill",
        resourceIds: [skillId],
      })
      assert.equal(rows.length, 1)
      const target = readAccessBindingTarget(
        normalizeAccessBindingRow(rows[0] as any) as any
      )
      assert.equal(target.subject.kind, "workspace_member")
      assert.equal(
        (target.subject as { memberId: string }).memberId,
        memberId,
        "workspace_member id must survive the insert→decode round-trip"
      )
      assert.equal(subjectScopeLabel(target as any), "workspace_member")
    })
  }
)

/**
 * Round 13 review (P2) — list filter widening regression.
 *
 * `GET /skills?workspaceMemberId=<id>` (with no accessTargetType) used
 * to pass the early-return guard in findSkillIdsByBindingFilter (the
 * id is non-empty), then skip the resolveAccessGrantTarget branch
 * (no accessTargetType), then fall through to
 * listResourceIdsForWorkspaceByBindingFilter which only supported
 * subjectId / actorId / conversationId. The workspaceMemberId was
 * silently dropped, so the helper applied only (workspace_id +
 * resource_type + active) filters and returned every active
 * installed_skill binding in the workspace.
 *
 * The fix downsinks workspaceMemberId (and remoteAgentId, for
 * symmetry and to avoid the same trap when a remote_agent list
 * filter ships) into the storage helper as a legacy column filter
 * (`subj.workspace_member_id = $`). Post-fix, the helper applies the
 * member filter even without an accessTargetType.
 */
test(
  "list filter by workspaceMemberId alone narrows correctly — round-13 P2",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const memberAId = await newMemberInWorkspace(db, wsId, "member-a")
      const memberBId = await newMemberInWorkspace(db, wsId, "member-b")
      const skillA = await newInstalledSkill(db, wsId)
      const skillB = await newInstalledSkill(db, wsId)

      // Two grants on two different skills, one per member.
      await insertWorkspaceMemberSkillBinding(db, {
        wsId,
        skillId: skillA,
        memberId: memberAId,
      })
      await insertWorkspaceMemberSkillBinding(db, {
        wsId,
        skillId: skillB,
        memberId: memberBId,
      })

      // Pre-fix: workspaceMemberId-only filter returned both skill ids
      // (the helper ignored the column and returned every active
      // binding in the workspace). Post-fix: returns just the skill
      // bound to member A.
      const onlyA = await listResourceIdsForWorkspaceByBindingFilter(
        db as any,
        {
          workspaceId: wsId,
          resourceType: "installed_skill",
          workspaceMemberId: memberAId,
        }
      )
      assert.deepEqual(onlyA.sort(), [skillA].sort())

      const onlyB = await listResourceIdsForWorkspaceByBindingFilter(
        db as any,
        {
          workspaceId: wsId,
          resourceType: "installed_skill",
          workspaceMemberId: memberBId,
        }
      )
      assert.deepEqual(onlyB.sort(), [skillB].sort())

      // Sanity: no filter still returns everything in the workspace,
      // confirming the fix narrowed only when the id was supplied
      // (didn't accidentally always filter).
      const all = await listResourceIdsForWorkspaceByBindingFilter(db as any, {
        workspaceId: wsId,
        resourceType: "installed_skill",
      })
      assert.deepEqual(all.sort(), [skillA, skillB].sort())
    })
  }
)

/**
 * Round 13 review (P3) — payload binding selection regression.
 *
 * `matchesScopeTarget` previously compared only (bind_scope, actor_id,
 * conversation_id). With two workspace_member grants A and B on the
 * same skill, a filter for member A matched both rows — and which one
 * got returned in the payload was arbitrary (depended on stable sort
 * order in compareBindingPriority, which doesn't tie-break on member
 * id). Fix: include workspace_member_id and remote_agent_id in the
 * discriminator.
 *
 * This test exercises matchesScopeTarget directly against the SkillAccessRow
 * shape the service builds from a real loadAccessBindingRowsForResources
 * read — the same load-path chooseBindingMap uses internally.
 */
test(
  "matchesScopeTarget discriminates workspace_member grants — round-13 P3",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const memberAId = await newMemberInWorkspace(db, wsId, "member-a")
      const memberBId = await newMemberInWorkspace(db, wsId, "member-b")
      const skillId = await newInstalledSkill(db, wsId)

      await insertWorkspaceMemberSkillBinding(db, {
        wsId,
        skillId,
        memberId: memberAId,
      })
      await insertWorkspaceMemberSkillBinding(db, {
        wsId,
        skillId,
        memberId: memberBId,
      })

      const rows = await loadAccessBindingRowsForResources(db, {
        resourceType: "installed_skill",
        resourceIds: [skillId],
      })
      assert.equal(rows.length, 2)

      const skillRows = rows.map((r) =>
        buildSkillAccessRow(normalizeAccessBindingRow(r as any) as any)
      )

      const filterA: SkillScopeTarget = {
        bindScope: "workspace_member",
        useScope: "workspace_member",
        actorId: null,
        remoteAgentId: null,
        workspaceMemberId: memberAId,
        conversationId: null,
      }
      const filterB: SkillScopeTarget = {
        ...filterA,
        workspaceMemberId: memberBId,
      }

      const matchA = skillRows.filter((r) => matchesScopeTarget(r, filterA))
      const matchB = skillRows.filter((r) => matchesScopeTarget(r, filterB))

      // Pre-fix: each filter matched both rows (member id was not
      // checked) — the payload binding was whichever sort ordering
      // returned first, not necessarily the requested member.
      assert.equal(
        matchA.length,
        1,
        "filter for member A must match exactly the A grant"
      )
      assert.equal(matchA[0]!.workspace_member_id, memberAId)

      assert.equal(
        matchB.length,
        1,
        "filter for member B must match exactly the B grant"
      )
      assert.equal(matchB[0]!.workspace_member_id, memberBId)
    })
  }
)

async function newMemberInWorkspace(
  db: Kysely<any>,
  wsId: string,
  email: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${email}-${rid()}@${NS}`,
      name: email,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspace_members")
    .values({
      workspace_id: wsId,
      user_id: user.id as string,
      trust_level: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return member.id as string
}

async function insertWorkspaceMemberSkillBinding(
  db: Kysely<any>,
  input: { wsId: string; skillId: string; memberId: string }
): Promise<void> {
  const bindingValues = await buildResourceAccessBindingInsertValues(db, {
    workspaceId: input.wsId,
    resourceType: "installed_skill",
    resourceId: input.skillId,
    target: {
      subject: { kind: "workspace_member", memberId: input.memberId },
    },
  })
  await db
    .insertInto("resource_access_bindings")
    .values(bindingValues)
    .execute()
}
