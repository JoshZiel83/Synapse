import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"
import type { Kysely } from "kysely"
import { SUBJECT_KIND } from "@synapse/shared"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { insertToolCallTaskDeduped } from "./service.js"
import { writeRuntimeAuthorizationTaskDetailInTx } from "../tasks/service.js"

/**
 * Regression coverage for the unified-task create path — the gap that let the
 * round-3 adversarial review's P0#1 slip through: the `runtime_authorization`
 * (and the future `device_tool` / `external_mcp`) executor kinds carry a 1:1
 * detail row, enforced by the DEFERRABLE INITIALLY DEFERRED constraint trigger
 * `tool_call_tasks_detail_consistency_chk` (schema.sql §"validate_tool_call_
 * task_detail_consistency"). The original bug minted the parent task in its own
 * committed transaction (via `createToolCallTaskDeduped`) and wrote the detail
 * row only in a *later* transaction — so the deferred trigger fired at the
 * parent's COMMIT with zero detail rows and raised "must have exactly one
 * detail row". The fix routes the detail insert through the `onCreatedInTx`
 * callback so parent + detail land in one transaction.
 *
 * Testing a DEFERRABLE INITIALLY DEFERRED trigger is awkward with `withTestDb`,
 * which wraps each test in an outer transaction it always rolls back — the
 * deferred trigger would never fire (it only evaluates at COMMIT, and we never
 * commit). The unlock: `SET CONSTRAINTS ALL IMMEDIATE` forces pending deferred
 * *constraint triggers* to evaluate immediately, mid-transaction. These CTI
 * checks are `CREATE CONSTRAINT TRIGGER`s, so they respond to it — letting us
 * assert both the bug shape (parent alone → reject) and the fix shape
 * (parent + detail same tx → pass) inside the rollback harness.
 *
 * We drive the lower-level `insertToolCallTaskDeduped` + the in-tx detail writer
 * directly on the test transaction, rather than the `createToolCallTaskDeduped`
 * wrapper: the wrapper opens its own `withDbTransaction` on the module-global
 * `db` (the real pool), which cannot see the fixture rows living in this test's
 * uncommitted transaction. The two calls below ARE the body of the wrapper's
 * `onCreatedInTx` path, so this faithfully exercises the fix.
 */

const NS = "cti-invariant-test"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

type Fixture = {
  workspaceId: string
  conversationId: string
  remoteAgentSubjectId: string
  deviceId: string
  capabilityId: string
  exposureId: string
}

/**
 * Build the minimal FK chain a `runtime_authorization` task + detail row need:
 * user → workspace → conversation, a remote_agent + its access_subjects row
 * (the parent's principal; remote_agent_channel delivery requires a
 * remote_agent principal), and a device → service → exposure → capability
 * chain (the detail row's device FKs).
 */
async function buildFixture(db: Kysely<any>): Promise<Fixture> {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "owner" })
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
  const conv = await db
    .insertInto("conversations")
    .values({
      kind: "group",
      workspaceId: ws.id as string,
      title: `${NS} conv`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const createdBySubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  const agentRoot = await db
    .insertInto("workspaceResources")
    .values({
      workspaceId: ws.id as string,
      kind: "remote_agent",
      displayName: `${NS} agent`,
      createdBySubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const agent = await db
    .insertInto("remoteAgents")
    .values({
      id: agentRoot.id as string,
      title: `${NS} agent`,
      runtimeKind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const subject = await db
    .insertInto("accessSubjects")
    .values({
      kind: "remote_agent",
      workspaceId: ws.id as string,
      remoteAgentId: agent.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const dev = await db
    .insertInto("devices")
    .values({
      workspaceId: ws.id as string,
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
  const capRoot = await db
    .insertInto("workspaceResources")
    .values({
      workspaceId: ws.id as string,
      kind: "device_capability",
      displayName: `${NS} capability`,
      createdBySubjectId,
      status: "active",
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  const cap = await db
    .insertInto("deviceCapabilities")
    .values({
      id: capRoot.id as string,
      exposureId: exp.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: ws.id as string,
    conversationId: conv.id as string,
    remoteAgentSubjectId: subject.id as string,
    deviceId: dev.id as string,
    capabilityId: cap.id as string,
    exposureId: exp.id as string,
  }
}

function runtimeAuthParams(fx: Fixture, requestKey: string) {
  return {
    workspaceId: fx.workspaceId,
    conversationId: fx.conversationId,
    executorKind: "runtime_authorization" as const,
    deliveryKind: "remote_agent_channel" as const,
    humanSurface: "needs_response" as const,
    principalSubjectId: fx.remoteAgentSubjectId,
    sourceToolName: `${NS}.tool`,
    requestKey,
  }
}

test(
  "CTI invariant: a runtime_authorization parent task minted WITHOUT its detail row is rejected (P0#1 bug shape)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildFixture(db)

      // Mint the parent alone — the original (broken) create path's effect:
      // detail row would be written in a separate transaction.
      const task = await insertToolCallTaskDeduped(
        db,
        runtimeAuthParams(fx, `cti-bug-${rid()}`)
      )
      assert.ok(task, "parent task should insert")

      // Force the deferred CTI trigger to evaluate now. With no detail row, it
      // must reject — this is exactly the failure that broke the create path.
      await assert.rejects(
        sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db),
        /must have exactly one detail row/
      )
    })
  }
)

test(
  "CTI invariant: a runtime_authorization parent + detail in the SAME tx passes (P0#1 fix shape)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildFixture(db)

      const task = await insertToolCallTaskDeduped(
        db,
        runtimeAuthParams(fx, `cti-fix-${rid()}`)
      )
      assert.ok(task, "parent task should insert")

      // Write the detail row in the SAME transaction, mirroring exactly what
      // the fixed create path does inside `createToolCallTaskDeduped`'s
      // `onCreatedInTx` callback.
      await writeRuntimeAuthorizationTaskDetailInTx(db, {
        taskId: task!.id,
        deviceId: fx.deviceId,
        deviceCapabilityId: fx.capabilityId,
        deviceExposureId: fx.exposureId,
        requestedToolName: `${NS}.tool`,
        deviceToolStableKey: `${NS}-stable-key`,
        reason: "regression-test",
        requestMode: "blocking",
        runtimeSessionId: `rt-${rid()}`,
        sourceRequestArgs: {},
        principalSubjectId: fx.remoteAgentSubjectId,
        requestedAction: {
          capability: "filesystem",
          toolName: `${NS}.tool`,
          summary: "regression-test action",
        },
        grantOptions: [],
        availablePresets: [],
      })

      // The deferred CTI trigger must now find exactly one detail row and pass.
      await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(db)

      // And the detail row is actually present, keyed to the parent.
      const detail = await db
        .selectFrom("toolCallTaskRuntimeAuthorization")
        .select("taskId")
        .where("taskId", "=", task!.id)
        .executeTakeFirst()
      assert.ok(detail, "detail row should have been written in the same tx")
    })
  }
)
