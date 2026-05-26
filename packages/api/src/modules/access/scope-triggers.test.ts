import test from "node:test"
import assert from "node:assert/strict"
import {
  MEMORY_PERMISSION,
  SUBJECT_KIND,
  isMemoryOwnerSubjectKind,
  isScopeEligibleSubject,
  isWorkspaceBoundSubjectKind,
  type SubjectRef,
} from "@synapse/shared"
import type { Kysely } from "kysely"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "./subject-registry.js"

/**
 * PR1 scope_subject_id triggers + helper SQL functions. Each trigger is exercised
 * for both happy-path and rejection conditions. Memory_spaces validations land
 * in PR5 (when the table is rebuilt with owner_subject_id), so only PR1-relevant
 * scope eligibility / subject kind / workspace consistency / resource workspace
 * checks are covered here.
 */

const NS = "trigger-test"

async function newWorkspace(db: Kysely<any>): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${rid()}@trigger-test`,
      name: "owner",
      password_hash: "x",
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

async function newActor(db: Kysely<any>, workspaceId: string): Promise<string> {
  const row = await db
    .insertInto("actors")
    .values({
      workspace_id: workspaceId,
      name: `actor-${rid()}`,
      role: "assistant",
      title: `${NS} actor`,
      current_version: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newRemoteAgent(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("remote_agents")
    .values({
      workspace_id: workspaceId,
      name: `agent-${rid()}`,
      title: `${NS} agent`,
      runtime_kind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newConversation(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const row = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      boundary: "internal",
      internal_workspace_id: workspaceId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// We use resource_type='actor' for RAB tests — it has the simplest fixture
// requirements and is in ACCESS_BINDABLE_RESOURCE_TYPES like every other
// bindable resource.

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

async function subj(db: Kysely<any>, ref: SubjectRef): Promise<string> {
  return upsertAccessSubject(db as any, ref as any)
}

async function expectReject<T>(
  promise: Promise<T>,
  matcher: RegExp
): Promise<void> {
  await assert.rejects(promise, (err) => matcher.test(String(err)))
}

// ---------- Shared helper unit checks ----------

test("isScopeEligibleSubject only accepts workspace / conversation", () => {
  assert.equal(
    isScopeEligibleSubject({
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: "x",
    }),
    true
  )
  assert.equal(
    isScopeEligibleSubject({
      kind: SUBJECT_KIND.CONVERSATION,
      conversationId: "x",
    }),
    true
  )
  assert.equal(
    isScopeEligibleSubject({ kind: SUBJECT_KIND.ACTOR, actorId: "x" }),
    false
  )
  assert.equal(
    isScopeEligibleSubject({
      kind: SUBJECT_KIND.WORKSPACE_MEMBER,
      memberId: "x",
    }),
    false
  )
  assert.equal(isScopeEligibleSubject({ kind: SUBJECT_KIND.SYSTEM }), false)
})

test("isWorkspaceBoundSubjectKind excludes user/external/system", () => {
  for (const ref of [
    { kind: SUBJECT_KIND.ACTOR, actorId: "x" },
    { kind: SUBJECT_KIND.REMOTE_AGENT, remoteAgentId: "x" },
    { kind: SUBJECT_KIND.WORKSPACE_MEMBER, memberId: "x" },
    { kind: SUBJECT_KIND.WORKSPACE, workspaceId: "x" },
    { kind: SUBJECT_KIND.CONVERSATION, conversationId: "x" },
  ] as SubjectRef[]) {
    assert.equal(
      isWorkspaceBoundSubjectKind(ref),
      true,
      `expected ${ref.kind} to be workspace-bound`
    )
  }
  for (const ref of [
    { kind: SUBJECT_KIND.USER, userId: "x" },
    { kind: SUBJECT_KIND.EXTERNAL, externalIdentityKey: "x" },
    { kind: SUBJECT_KIND.SYSTEM },
  ] as SubjectRef[]) {
    assert.equal(
      isWorkspaceBoundSubjectKind(ref),
      false,
      `expected ${ref.kind} to be rejected`
    )
  }
})

test("isMemoryOwnerSubjectKind accepts workspace-bound kinds", () => {
  assert.equal(
    isMemoryOwnerSubjectKind({ kind: SUBJECT_KIND.ACTOR, actorId: "x" }),
    true
  )
  assert.equal(
    isMemoryOwnerSubjectKind({ kind: SUBJECT_KIND.USER, userId: "x" }),
    false
  )
})

// ---------- RAB trigger ----------

test(
  "tg_rab_validate: scope_subject_id pointing at an actor is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const subjectActor = await newActor(db, wsId)
      const targetActor = await newActor(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })

      await expectReject(
        db
          .insertInto("resource_access_bindings")
          .values({
            workspace_id: wsId,
            resource_type: "actor",
            actor_id: targetActor,
            subject_id: subjectSubj,
            scope_subject_id: subjectSubj, // actor is NOT scope-eligible
          })
          .execute(),
        /scope_subject_id .* workspace\|conversation/
      )
    })
  }
)

test(
  "tg_rab_validate: scope=conversation in different workspace is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const otherWs = await newWorkspace(db)
      const otherConv = await newConversation(db, otherWs)
      const subjectActor = await newActor(db, wsId)
      const targetActor = await newActor(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })
      const otherConvSubj = await subj(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: otherConv,
      })

      await expectReject(
        db
          .insertInto("resource_access_bindings")
          .values({
            workspace_id: wsId,
            resource_type: "actor",
            actor_id: targetActor,
            subject_id: subjectSubj,
            scope_subject_id: otherConvSubj,
          })
          .execute(),
        /scope_subject_id .* workspace/
      )
    })
  }
)

test(
  "tg_rab_validate: scope_subject_id NULL short-circuits eligibility check",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const subjectActor = await newActor(db, wsId)
      const targetActor = await newActor(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })

      await db
        .insertInto("resource_access_bindings")
        .values({
          workspace_id: wsId,
          resource_type: "actor",
          actor_id: targetActor,
          subject_id: subjectSubj,
          // scope_subject_id omitted → NULL
        })
        .execute()
    })
  }
)

test(
  "tg_rab_validate: scope=conversation in same workspace is accepted",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const conv = await newConversation(db, wsId)
      const subjectActor = await newActor(db, wsId)
      const targetActor = await newActor(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })
      const convSubj = await subj(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: conv,
      })

      await db
        .insertInto("resource_access_bindings")
        .values({
          workspace_id: wsId,
          resource_type: "actor",
          actor_id: targetActor,
          subject_id: subjectSubj,
          scope_subject_id: convSubj,
        })
        .execute()
    })
  }
)

test(
  "tg_rab_validate: subject kind=user is rejected (not workspace-bound)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const targetActor = await newActor(db, wsId)
      const userRow = await db
        .insertInto("users")
        .values({
          email: `u-${rid()}@trigger-test`,
          name: "u",
          password_hash: "x",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const userSubj = await subj(db, {
        kind: SUBJECT_KIND.USER,
        userId: userRow.id as string,
      })

      await expectReject(
        db
          .insertInto("resource_access_bindings")
          .values({
            workspace_id: wsId,
            resource_type: "actor",
            actor_id: targetActor,
            subject_id: userSubj,
          })
          .execute(),
        /not workspace-bound/
      )
    })
  }
)

test(
  "tg_rab_validate: subject workspace mismatch is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const actorB = await newActor(db, wsB)
      const targetA = await newActor(db, wsA)
      const actorBSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: actorB,
      })

      await expectReject(
        db
          .insertInto("resource_access_bindings")
          .values({
            workspace_id: wsA,
            resource_type: "actor",
            actor_id: targetA,
            subject_id: actorBSubj,
          })
          .execute(),
        /subject_id .* workspace .* does not match/
      )
    })
  }
)

test(
  "tg_rab_validate: resource workspace mismatch is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const actorA = await newActor(db, wsA)
      const targetB = await newActor(db, wsB)
      const actorASubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: actorA,
      })

      await expectReject(
        db
          .insertInto("resource_access_bindings")
          .values({
            workspace_id: wsA,
            resource_type: "actor",
            actor_id: targetB,
            subject_id: actorASubj,
          })
          .execute(),
        /resource.*workspace mismatch|missing or workspace mismatch/
      )
    })
  }
)

// D2: the previous "legacy conversation_actor_context subject is allowed
// (PR1 transitional)" test is gone — the subject kind was removed from
// both the TS union and the Postgres ENUM, so the trigger no longer needs
// a transitional CAC allowance. Subject-kind validation now happens at
// three layers (TS / ENUM / trigger).

// ---------- relay grant trigger ----------

async function newRelayDevice(
  db: Kysely<any>,
  workspaceId: string
): Promise<{ deviceId: string; capabilityId: string; exposureId: string }> {
  const dev = await db
    .insertInto("relay_devices")
    .values({
      workspace_id: workspaceId,
      title: `${NS} device`,
      public_key: `pk-${rid()}`,
      public_key_fingerprint: `fp-${rid()}-${rid()}`,
      trust_status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const exp = await db
    .insertInto("relay_exposures")
    .values({
      device_id: dev.id as string,
      stable_key: `exp-${rid()}`,
      display_name: `${NS} exposure`,
      transport: "stdio",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const cap = await db
    .insertInto("relay_capabilities")
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

test(
  "tg_relay_grant_validate: subject_id is NOT NULL post-D1 (legacy NULL writers rejected)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const { deviceId, capabilityId, exposureId } = await newRelayDevice(
        db,
        wsId
      )

      await expectReject(
        db
          .insertInto("relay_authorization_grants")
          .values({
            workspace_id: wsId,
            relay_device_id: deviceId,
            relay_capability_id: capabilityId,
            relay_exposure_id: exposureId,
            subject_id: null,
            retention: "consume_once",
          } as any)
          .execute(),
        /null value in column "subject_id"|violates not-null constraint|workspace mismatch|not workspace-bound/
      )
    })
  }
)

test(
  "tg_relay_grant_validate: scope_subject_id pointing at actor is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const { deviceId, capabilityId, exposureId } = await newRelayDevice(
        db,
        wsId
      )
      const actorSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })
      const workspaceSubj = await subj(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: wsId,
      })

      await expectReject(
        db
          .insertInto("relay_authorization_grants")
          .values({
            workspace_id: wsId,
            relay_device_id: deviceId,
            relay_capability_id: capabilityId,
            relay_exposure_id: exposureId,
            subject_id: workspaceSubj,
            scope_subject_id: actorSubj,
            retention: "consume_once",
          } as any)
          .execute(),
        /scope_subject_id .* workspace\|conversation/
      )
    })
  }
)

test(
  "tg_relay_grant_validate: cross-workspace device/capability/exposure rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const a = await newRelayDevice(db, wsA)
      const b = await newRelayDevice(db, wsB)
      const wsASubj = await subj(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: wsA,
      })

      // Try to mix wsA device with wsB capability — the helper relay_resource_workspace_id
      // also enforces capability.exposure_id = exposure_id, so this throws either at the
      // membership check or the workspace alignment.
      await expectReject(
        db
          .insertInto("relay_authorization_grants")
          .values({
            workspace_id: wsA,
            relay_device_id: a.deviceId,
            relay_capability_id: b.capabilityId,
            relay_exposure_id: a.exposureId,
            subject_id: wsASubj,
            retention: "until_revoked",
          } as any)
          .execute(),
        /(does not belong|workspace mismatch)/
      )
    })
  }
)

test(
  "tg_relay_grant_validate: subject_id kind=user rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const { deviceId, capabilityId, exposureId } = await newRelayDevice(
        db,
        wsId
      )
      const userRow = await db
        .insertInto("users")
        .values({
          email: `u-${rid()}@trigger-test`,
          name: "u",
          password_hash: "x",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const userSubj = await subj(db, {
        kind: SUBJECT_KIND.USER,
        userId: userRow.id as string,
      })

      await expectReject(
        db
          .insertInto("relay_authorization_grants")
          .values({
            workspace_id: wsId,
            relay_device_id: deviceId,
            relay_capability_id: capabilityId,
            relay_exposure_id: exposureId,
            subject_id: userSubj,
            retention: "until_revoked",
          } as any)
          .execute(),
        /not workspace-bound/
      )
    })
  }
)

// ---------- memory_access_grants trigger ----------

async function newLegacyMemorySpace(
  db: Kysely<any>,
  workspaceId: string,
  actorId: string
): Promise<string> {
  // D4: memory_spaces is keyed by (owner_subject_id, scope_subject_id?,
  // namespace_key). owner=actor matches the historical actor_private shape.
  const ownerSubjectId = await upsertAccessSubject(db as any, {
    kind: SUBJECT_KIND.ACTOR,
    actorId,
  })
  const row = await db
    .insertInto("memory_spaces")
    .values({
      workspace_id: workspaceId,
      owner_subject_id: ownerSubjectId,
      namespace_key: "default",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newLegacyMemoryItem(
  db: Kysely<any>,
  workspaceId: string,
  spaceId: string
): Promise<string> {
  const row = await db
    .insertInto("memory_items")
    .values({
      workspace_id: workspaceId,
      memory_space_id: spaceId,
      category: "fact",
      text_digest: "x",
      search_text: "x",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// D2: the previous "tg_memory_grant_validate rejects CAC subjects" test is
// gone — the subject kind no longer exists in the TS union or the SQL ENUM,
// so the trigger can never see a CAC subject_id. Validation is now stricter
// (type-level + DB-ENUM) than the old runtime-only check.

test(
  "tg_memory_grant_validate: item belonging to a different space is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const space1 = await newLegacyMemorySpace(db, wsId, actorId)
      const actor2 = await newActor(db, wsId)
      const space2 = await newLegacyMemorySpace(db, wsId, actor2)
      const item2 = await newLegacyMemoryItem(db, wsId, space2)
      const actorSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })

      await expectReject(
        db
          .insertInto("memory_access_grants")
          .values({
            workspace_id: wsId,
            memory_space_id: space1,
            memory_item_id: item2,
            subject_id: actorSubj,
            permissions: [MEMORY_PERMISSION.READ],
          } as any)
          .execute(),
        /does not belong to memory_space/
      )
    })
  }
)

test(
  "tg_memory_grant_validate: happy path — actor subject, item in same space, same workspace",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const spaceId = await newLegacyMemorySpace(db, wsId, actorId)
      const itemId = await newLegacyMemoryItem(db, wsId, spaceId)
      const actorSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })

      await db
        .insertInto("memory_access_grants")
        .values({
          workspace_id: wsId,
          memory_space_id: spaceId,
          memory_item_id: itemId,
          subject_id: actorSubj,
          permissions: [MEMORY_PERMISSION.READ, MEMORY_PERMISSION.RECALL],
        } as any)
        .execute()
    })
  }
)

test(
  "tg_memory_grant_validate: scope_subject_id eligibility enforced (rejects actor scope)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const spaceId = await newLegacyMemorySpace(db, wsId, actorId)
      const actorSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId,
      })

      await expectReject(
        db
          .insertInto("memory_access_grants")
          .values({
            workspace_id: wsId,
            memory_space_id: spaceId,
            subject_id: actorSubj,
            scope_subject_id: actorSubj,
            permissions: [MEMORY_PERMISSION.READ],
          } as any)
          .execute(),
        /scope_subject_id .* workspace\|conversation/
      )
    })
  }
)

// Ensure unused helper imports don't trip noUnusedLocals.
void newRemoteAgent
