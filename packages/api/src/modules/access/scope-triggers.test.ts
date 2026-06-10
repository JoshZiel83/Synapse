import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
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
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const ws = await db
    .insertInto("workspaces")
    .values({
      ownerId: user.id as string,
      slug: `ws-${rid()}`,
      name: `${NS} ws`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return ws.id as string
}

async function newActor(db: Kysely<any>, workspaceId: string): Promise<string> {
  const actorId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: actorId,
      workspaceId: workspaceId,
      kind: "actor",
      displayName: `${NS} actor`,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("actors")
    .values({
      id: actorId,
      role: "assistant",
      title: `${NS} actor`,
      currentVersion: 1,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newRemoteAgent(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const remoteAgentId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: remoteAgentId,
      workspaceId: workspaceId,
      kind: "remote_agent",
      displayName: `${NS} agent`,
      status: "active",
    } as any)
    .execute()
  const row = await db
    .insertInto("remoteAgents")
    .values({
      id: remoteAgentId,
      title: `${NS} agent`,
      runtimeKind: "claude_code",
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
      workspaceId: workspaceId,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

async function newWorkspaceMember(
  db: Kysely<any>,
  workspaceId: string,
  label: string
): Promise<string> {
  const user = await db
    .insertInto("users")
    .values({
      email: `${label}-${rid()}@${NS}`,
      name: label,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const member = await db
    .insertInto("workspaceMembers")
    .values({
      workspaceId: workspaceId,
      userId: user.id as string,
      trustLevel: "member",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return member.id as string
}

async function newAutomationEventSource(
  db: Kysely<any>,
  workspaceId: string
): Promise<string> {
  const memberId = await newWorkspaceMember(db, workspaceId, "creator")
  const row = await db
    .insertInto("automationEventSources")
    .values({
      workspaceId: workspaceId,
      providerKind: "internal",
      sourceKey: `src-${rid()}`,
      name: "source",
      createdByKind: "workspace_member",
      createdByWorkspaceMemberId: memberId,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// The legacy binding table is now being narrowed toward automation-only, so
// these trigger tests use automation_event_source as the bound resource.

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
  assert.equal(isScopeEligibleSubject({ kind: SUBJECT_KIND.PLATFORM }), false)
})

test("isWorkspaceBoundSubjectKind excludes user/external/platform", () => {
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
    {
      kind: SUBJECT_KIND.EXTERNAL,
      workspaceId: "x",
      transportAddressId: "y",
    },
    { kind: SUBJECT_KIND.PLATFORM },
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
      const eventSourceId = await newAutomationEventSource(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })

      await expectReject(
        db
          .insertInto("resourceAccessBindings")
          .values({
            workspaceId: wsId,
            resourceType: "automation_event_source",
            automationEventSourceId: eventSourceId,
            subjectId: subjectSubj,
            scopeSubjectId: subjectSubj, // actor is NOT scope-eligible
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
      const eventSourceId = await newAutomationEventSource(db, wsId)
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
          .insertInto("resourceAccessBindings")
          .values({
            workspaceId: wsId,
            resourceType: "automation_event_source",
            automationEventSourceId: eventSourceId,
            subjectId: subjectSubj,
            scopeSubjectId: otherConvSubj,
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
      const eventSourceId = await newAutomationEventSource(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })

      await db
        .insertInto("resourceAccessBindings")
        .values({
          workspaceId: wsId,
          resourceType: "automation_event_source",
          automationEventSourceId: eventSourceId,
          subjectId: subjectSubj,
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
      const eventSourceId = await newAutomationEventSource(db, wsId)
      const subjectSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: subjectActor,
      })
      const convSubj = await subj(db, {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: conv,
      })

      await db
        .insertInto("resourceAccessBindings")
        .values({
          workspaceId: wsId,
          resourceType: "automation_event_source",
          automationEventSourceId: eventSourceId,
          subjectId: subjectSubj,
          scopeSubjectId: convSubj,
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
      const eventSourceId = await newAutomationEventSource(db, wsId)
      const userRow = await db
        .insertInto("users")
        .values({
          email: `u-${rid()}@trigger-test`,
          name: "u",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const userSubj = await subj(db, {
        kind: SUBJECT_KIND.USER,
        userId: userRow.id as string,
      })

      await expectReject(
        db
          .insertInto("resourceAccessBindings")
          .values({
            workspaceId: wsId,
            resourceType: "automation_event_source",
            automationEventSourceId: eventSourceId,
            subjectId: userSubj,
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
      const eventSourceId = await newAutomationEventSource(db, wsA)
      const actorBSubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: actorB,
      })

      await expectReject(
        db
          .insertInto("resourceAccessBindings")
          .values({
            workspaceId: wsA,
            resourceType: "automation_event_source",
            automationEventSourceId: eventSourceId,
            subjectId: actorBSubj,
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
      const eventSourceB = await newAutomationEventSource(db, wsB)
      const actorASubj = await subj(db, {
        kind: SUBJECT_KIND.ACTOR,
        actorId: actorA,
      })

      await expectReject(
        db
          .insertInto("resourceAccessBindings")
          .values({
            workspaceId: wsA,
            resourceType: "automation_event_source",
            automationEventSourceId: eventSourceB,
            subjectId: actorASubj,
          })
          .execute(),
        /resource.*workspace mismatch|missing or workspace mismatch/
      )
    })
  }
)

// D2: the previous runtime-pair subject transitional test is gone — the
// subject kind was removed from both the TS union and the Postgres ENUM.
// Subject-kind validation now happens at three layers (TS / ENUM / trigger).

// ---------- runtime authorization grant trigger ----------

async function newDevice(
  db: Kysely<any>,
  workspaceId: string
): Promise<{ deviceId: string; capabilityId: string; exposureId: string }> {
  const dev = await db
    .insertInto("devices")
    .values({
      workspaceId: workspaceId,
      title: `${NS} device`,
      publicKey: `pk-${rid()}`,
      publicKeyFingerprint: `fp-${rid()}-${rid()}`,
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
      stableKey: `exp-${rid()}`,
      displayName: `${NS} exposure`,
      transport: "stdio",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const capabilityId = crypto.randomUUID()
  await db
    .insertInto("workspaceApps")
    .values({
      id: capabilityId,
      workspaceId: workspaceId,
      kind: "device_capability",
      displayName: `${NS} capability`,
      status: "active",
    } as any)
    .execute()
  const cap = await db
    .insertInto("deviceCapabilities")
    .values({
      id: capabilityId,
      exposureId: exp.id as string,
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
  "tg_runtime_authorization_grant_validate: subject_id is NOT NULL post-D1 (legacy NULL writers rejected)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const { deviceId, capabilityId, exposureId } = await newDevice(db, wsId)

      await expectReject(
        db
          .insertInto("runtimeAuthorizationGrants")
          .values({
            workspaceId: wsId,
            deviceId: deviceId,
            deviceCapabilityId: capabilityId,
            deviceExposureId: exposureId,
            subjectId: null,
            retention: "consume_once",
          } as any)
          .execute(),
        /null value in column "subject_id"|violates not-null constraint|workspace mismatch|not workspace-bound|subject_id <NULL> does not exist|subject_id .* does not exist/
      )
    })
  }
)

test(
  "tg_runtime_authorization_grant_validate: scope_subject_id pointing at actor is rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const actorId = await newActor(db, wsId)
      const { deviceId, capabilityId, exposureId } = await newDevice(db, wsId)
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
          .insertInto("runtimeAuthorizationGrants")
          .values({
            workspaceId: wsId,
            deviceId: deviceId,
            deviceCapabilityId: capabilityId,
            deviceExposureId: exposureId,
            subjectId: workspaceSubj,
            scopeSubjectId: actorSubj,
            retention: "consume_once",
          } as any)
          .execute(),
        /scoped grant.*not in whitelist|scope_subject_id .* workspace\|conversation/
      )
    })
  }
)

test(
  "tg_runtime_authorization_grant_validate: cross-workspace device/capability/exposure rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsA = await newWorkspace(db)
      const wsB = await newWorkspace(db)
      const a = await newDevice(db, wsA)
      const b = await newDevice(db, wsB)
      const wsASubj = await subj(db, {
        kind: SUBJECT_KIND.WORKSPACE,
        workspaceId: wsA,
      })

      // Try to mix wsA device with wsB capability — the helper device_capability_workspace_id
      // also enforces capability.exposure_id = exposure_id, so this throws either at the
      // membership check or the workspace alignment.
      await expectReject(
        db
          .insertInto("runtimeAuthorizationGrants")
          .values({
            workspaceId: wsA,
            deviceId: a.deviceId,
            deviceCapabilityId: b.capabilityId,
            deviceExposureId: a.exposureId,
            subjectId: wsASubj,
            retention: "until_revoked",
          } as any)
          .execute(),
        /does not belong|workspace mismatch|does not match grant workspace/
      )
    })
  }
)

test(
  "tg_runtime_authorization_grant_validate: subject_id kind=user rejected",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const wsId = await newWorkspace(db)
      const { deviceId, capabilityId, exposureId } = await newDevice(db, wsId)
      const userRow = await db
        .insertInto("users")
        .values({
          email: `u-${rid()}@trigger-test`,
          name: "u",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
      const userSubj = await subj(db, {
        kind: SUBJECT_KIND.USER,
        userId: userRow.id as string,
      })

      await expectReject(
        db
          .insertInto("runtimeAuthorizationGrants")
          .values({
            workspaceId: wsId,
            deviceId: deviceId,
            deviceCapabilityId: capabilityId,
            deviceExposureId: exposureId,
            subjectId: userSubj,
            retention: "until_revoked",
          } as any)
          .execute(),
        /not workspace-bound|unscoped grant subject.kind=user is not allowed|workspace .* does not match/
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
    .insertInto("memorySpaces")
    .values({
      workspaceId: workspaceId,
      ownerSubjectId: ownerSubjectId,
      namespaceKey: "default",
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
    .insertInto("memoryItems")
    .values({
      workspaceId: workspaceId,
      memorySpaceId: spaceId,
      category: "fact",
      textDigest: "x",
      searchText: "x",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

// D2: the previous runtime-pair subject rejection test is gone — the subject
// kind no longer exists in the TS union or the SQL ENUM. Validation is now
// stricter (type-level + DB-ENUM) than the old runtime-only check.

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
          .insertInto("memoryAccessGrants")
          .values({
            workspaceId: wsId,
            memorySpaceId: space1,
            memoryItemId: item2,
            subjectId: actorSubj,
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
        .insertInto("memoryAccessGrants")
        .values({
          workspaceId: wsId,
          memorySpaceId: spaceId,
          memoryItemId: itemId,
          subjectId: actorSubj,
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
          .insertInto("memoryAccessGrants")
          .values({
            workspaceId: wsId,
            memorySpaceId: spaceId,
            subjectId: actorSubj,
            scopeSubjectId: actorSubj,
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
