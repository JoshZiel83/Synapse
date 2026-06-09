import test from "node:test"
import assert from "node:assert/strict"
import { sql } from "kysely"
import type { Kysely } from "kysely"
import crypto from "node:crypto"
import { withTestDb } from "../../test/helpers/db.js"

/**
 * Regression for the round-4 P0: replayResolvedRemoteAgentInteractions (in
 * remote-agents/service.ts, run on machine ready/bind) issued raw SQL that
 * JOINed the dropped `interaction_requests` table and read `interaction.status`.
 * Under the task unification the active interaction pointer references
 * `tool_call_tasks` and the state is `lifecycle_status`, so the old query threw
 * `relation "interaction_requests" does not exist`, breaking the agent
 * machine-ready / start path. This test runs the CURRENT query shape against
 * the real schema (so a re-introduced dropped-table ref fails loudly) and
 * asserts it selects only RESOLVED (terminal-lifecycle) active interactions,
 * mirroring the old `status <> 'pending'` semantics.
 */

const NS = "replay-resolved-test"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

// Mirrors the exact query replayResolvedRemoteAgentInteractions runs (kept in
// lockstep with remote-agents/service.ts). Parameterized via the kysely `sql`
// tag so binding matches production; the point under test is that it references
// `tool_call_tasks` / `lifecycle_status` (not the dropped `interaction_requests`
// / `status`) and so executes against the real schema without throwing.
function runReplayQuery(
  db: Kysely<any>,
  machineId: string,
  remoteAgentIds: string[]
) {
  return sql<{
    remote_agent_id: string
    active_interaction_id: string
    lifecycle_status: string
  }>`
    SELECT
      ctx.remote_agent_id,
      ctx.active_interaction_id,
      task.lifecycle_status
    FROM remote_agent_conversation_contexts ctx
    INNER JOIN remote_agent_bindings binding
      ON binding.remote_agent_id = ctx.remote_agent_id
    INNER JOIN tool_call_tasks task
      ON task.id = ctx.active_interaction_id
    WHERE binding.machine_id = ${machineId}
      AND ctx.remote_agent_id = ANY(${remoteAgentIds}::uuid[])
      AND ctx.active_interaction_id IS NOT NULL
      AND task.lifecycle_status IN ('completed', 'failed', 'cancelled', 'expired')
  `.execute(db)
}

async function buildAgentMachineFixture(db: Kysely<any>) {
  const user = await db
    .insertInto("users")
    .values({ email: `${rid()}@${NS}`, name: "owner" })
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
  const conv = await db
    .insertInto("conversations")
    .values({ kind: "group", workspace_id: ws.id as string, title: `${NS} c` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const remoteAgentId = crypto.randomUUID()
  await db
    .insertInto("workspace_apps")
    .values({
      id: remoteAgentId,
      workspace_id: ws.id as string,
      kind: "remote_agent",
      display_name: `${NS} agent`,
      status: "active",
    } as any)
    .execute()
  const agent = await db
    .insertInto("remote_agents")
    .values({
      id: remoteAgentId,
      title: `${NS} agent`,
      runtime_kind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const machine = await db
    .insertInto("remote_agent_machines")
    .values({
      workspace_id: ws.id as string,
      title: `${NS} machine`,
      api_key_hash: `hash-${rid()}-${rid()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("remote_agent_bindings")
    .values({
      remote_agent_id: agent.id as string,
      machine_id: machine.id as string,
      runtime_kind: "claude_code",
    } as any)
    .execute()

  // The remote_agent principal subject (parent task's delivery key).
  const subject = await db
    .insertInto("access_subjects")
    .values({
      kind: "remote_agent",
      workspace_id: ws.id as string,
      remote_agent_id: agent.id as string,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()

  return {
    workspaceId: ws.id as string,
    conversationId: conv.id as string,
    remoteAgentId: agent.id as string,
    machineId: machine.id as string,
    remoteAgentSubjectId: subject.id as string,
  }
}

async function mintTask(
  db: Kysely<any>,
  fx: {
    workspaceId: string
    conversationId: string
    remoteAgentSubjectId: string
  },
  lifecycle: string
): Promise<string> {
  const row = await db
    .insertInto("tool_call_tasks")
    .values({
      workspace_id: fx.workspaceId,
      conversation_id: fx.conversationId,
      executor_kind: "user_input",
      delivery_kind: "remote_agent_channel",
      human_surface: "needs_response",
      principal_subject_id: fx.remoteAgentSubjectId,
      source_tool_name: `${NS}.tool`,
      request_key: `rk-${rid()}`,
      lifecycle_status: lifecycle,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "replay query: runs against the unified schema and returns RESOLVED active interactions",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildAgentMachineFixture(db)

      // A resolved (completed) active interaction → should be replayed.
      const resolvedTask = await mintTask(db, fx, "completed")
      await db
        .insertInto("remote_agent_conversation_contexts")
        .values({
          remote_agent_id: fx.remoteAgentId,
          conversation_id: fx.conversationId,
          active_interaction_id: resolvedTask,
        } as any)
        .execute()

      // Runs without "relation interaction_requests does not exist".
      const result = await runReplayQuery(db, fx.machineId, [fx.remoteAgentId])

      assert.equal(
        result.rows.length,
        1,
        "the completed interaction is replayed"
      )
      const row = result.rows[0] as {
        remote_agent_id: string
        active_interaction_id: string
        lifecycle_status: string
      }
      assert.equal(row.active_interaction_id, resolvedTask)
      assert.equal(row.lifecycle_status, "completed")
    })
  }
)

test(
  "replay query: a still-pending (non-terminal) active interaction is NOT replayed",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildAgentMachineFixture(db)

      // A non-terminal (auth_required) active interaction → must be skipped,
      // mirroring the old `interaction.status <> 'pending'` filter.
      const pendingTask = await mintTask(db, fx, "auth_required")
      await db
        .insertInto("remote_agent_conversation_contexts")
        .values({
          remote_agent_id: fx.remoteAgentId,
          conversation_id: fx.conversationId,
          active_interaction_id: pendingTask,
        } as any)
        .execute()

      const result = await runReplayQuery(db, fx.machineId, [fx.remoteAgentId])

      assert.equal(
        result.rows.length,
        0,
        "a non-terminal interaction must not be replayed"
      )
    })
  }
)
