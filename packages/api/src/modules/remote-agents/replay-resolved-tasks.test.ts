import test from "node:test"
import assert from "node:assert/strict"
import { context, trace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { SUBJECT_KIND } from "@synapse/shared"
import type { Kysely } from "kysely"
import crypto from "node:crypto"
import { withTestDb } from "../../test/helpers/db.js"
import { upsertAccessSubject } from "../access/subject-registry.js"
import { updateResolvedTaskRequestRow } from "../tasks/repo.js"
import { loadReplayResolvedTaskTargetsRepo } from "./repo.js"

// Real provider + ALS context manager so `activeTraceparent()` (the
// resolution_traceparent stamp inside updateResolvedTaskRequestRow) sees the
// test's active span. Each test file runs in its own process under tsx --test.
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  })
)
context.setGlobalContextManager(new AsyncLocalStorageContextManager())

/**
 * Regression for remote-agent startup replay: active_task_id points at
 * tool_call_tasks, and only terminal lifecycle statuses should be replayed to
 * the daemon. This runs the current SQL against the real schema so stale table
 * names or status projections fail loudly.
 */

const NS = "replay-resolved-test"

function rid(): string {
  return Math.random().toString(36).slice(2, 10)
}

// Runs the repo helper that powers remote-agent startup replay. The point under
// test is that it references `tool_call_tasks` / `lifecycle_status` through the
// production query and so executes against the real schema without throwing.
function runReplayQuery(
  db: Kysely<any>,
  machineId: string,
  remoteAgentIds: string[]
) {
  return loadReplayResolvedTaskTargetsRepo(machineId, remoteAgentIds, db as any)
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
      ownerId: user.id as string,
      slug: `ws-${rid()}`,
      name: `${NS} ws`,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const conv = await db
    .insertInto("conversations")
    .values({ kind: "group", workspaceId: ws.id as string, title: `${NS} c` })
    .returning("id")
    .executeTakeFirstOrThrow()
  const remoteAgentId = crypto.randomUUID()
  const createdBySubjectId = await upsertAccessSubject(db, {
    kind: SUBJECT_KIND.PLATFORM,
  })
  await db
    .insertInto("workspaceResources")
    .values({
      id: remoteAgentId,
      workspaceId: ws.id as string,
      kind: "remote_agent",
      displayName: `${NS} agent`,
      createdBySubjectId,
      status: "active",
    } as any)
    .execute()
  const agent = await db
    .insertInto("remoteAgents")
    .values({
      id: remoteAgentId,
      title: `${NS} agent`,
      runtimeKind: "claude_code",
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  const machine = await db
    .insertInto("remoteAgentMachines")
    .values({
      workspaceId: ws.id as string,
      title: `${NS} machine`,
      apiKeyHash: `hash-${rid()}-${rid()}`,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  await db
    .insertInto("remoteAgentBindings")
    .values({
      remoteAgentId: agent.id as string,
      machineId: machine.id as string,
      runtimeKind: "claude_code",
    } as any)
    .execute()

  // The remote_agent principal subject (parent task's delivery key).
  const subject = await db
    .insertInto("accessSubjects")
    .values({
      kind: "remote_agent",
      workspaceId: ws.id as string,
      remoteAgentId: agent.id as string,
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
  lifecycle: string,
  resolutionTraceparent?: string
): Promise<string> {
  const row = await db
    .insertInto("toolCallTasks")
    .values({
      workspaceId: fx.workspaceId,
      conversationId: fx.conversationId,
      executorKind: "user_input",
      deliveryKind: "remote_agent_channel",
      humanSurface: "needs_response",
      principalSubjectId: fx.remoteAgentSubjectId,
      sourceToolName: `${NS}.tool`,
      requestKey: `rk-${rid()}`,
      lifecycleStatus: lifecycle,
      resolutionTraceparent: resolutionTraceparent ?? null,
    } as any)
    .returning("id")
    .executeTakeFirstOrThrow()
  return row.id as string
}

test(
  "replay query: runs against the unified schema and returns resolved active tasks",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildAgentMachineFixture(db)

      // A resolved (completed) active task should be replayed — carrying the
      // resolver's persisted trace (resolution_traceparent) so the replayed
      // agent:task:resolved frame stays correlated after a daemon restart.
      const RESOLVER_TP =
        "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
      const resolvedTask = await mintTask(db, fx, "completed", RESOLVER_TP)
      await db
        .insertInto("remoteAgentConversationContexts")
        .values({
          remoteAgentId: fx.remoteAgentId,
          conversationId: fx.conversationId,
          activeTaskId: resolvedTask,
        } as any)
        .execute()

      // Runs without "relation tool_call_tasks does not exist".
      const rows = await runReplayQuery(db, fx.machineId, [fx.remoteAgentId])

      assert.equal(rows.length, 1, "the completed task is replayed")
      const row = rows[0] as {
        remoteAgentId: string
        activeTaskId: string
        lifecycleStatus: string
        resolutionTraceparent: string | null
      }
      assert.equal(row.activeTaskId, resolvedTask)
      assert.equal(row.lifecycleStatus, "completed")
      assert.equal(row.resolutionTraceparent, RESOLVER_TP)
    })
  }
)

test(
  "updateResolvedTaskRequestRow stamps the resolver's active span as resolution_traceparent (NULL without a span)",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildAgentMachineFixture(db)

      // Resolve INSIDE a real active span: the single terminal-flip writer
      // must persist exactly that span's traceparent — deleting the stamp
      // line in tasks/repo.ts previously kept every suite green (the fixture
      // INSERTs above seed the column directly), which is the gap this pins.
      const spanStamped = await mintTask(db, fx, "working")
      let expected: string | undefined
      await trace
        .getTracer("resolve-test")
        .startActiveSpan("resolve-task", async (span) => {
          const sc = span.spanContext()
          expected = `00-${sc.traceId}-${sc.spanId}-01`
          await updateResolvedTaskRequestRow(db as any, spanStamped, {
            lifecycleStatus: "completed",
          })
          span.end()
        })
      const stamped = await db
        .selectFrom("toolCallTasks")
        .select(["resolutionTraceparent", "lifecycleStatus"])
        .where("id", "=", spanStamped)
        .executeTakeFirstOrThrow()
      assert.ok(expected, "test span must have run")
      assert.equal(
        stamped.resolutionTraceparent,
        expected,
        "the persisted resolution_traceparent IS the resolver span's traceparent"
      )
      assert.equal(stamped.lifecycleStatus, "completed")

      // No active span ⇒ NULL (never a garbage/stale value).
      const unstamped = await mintTask(db, fx, "working")
      await updateResolvedTaskRequestRow(db as any, unstamped, {
        lifecycleStatus: "completed",
      })
      const bare = await db
        .selectFrom("toolCallTasks")
        .select(["resolutionTraceparent"])
        .where("id", "=", unstamped)
        .executeTakeFirstOrThrow()
      assert.equal(bare.resolutionTraceparent, null)
    })
  }
)

test(
  "replay query: a still-pending (non-terminal) active task is not replayed",
  { timeout: 5 * 60_000 },
  async () => {
    await withTestDb(async (db) => {
      const fx = await buildAgentMachineFixture(db)

      // A non-terminal (auth_required) active task must be skipped.
      const pendingTask = await mintTask(db, fx, "auth_required")
      await db
        .insertInto("remoteAgentConversationContexts")
        .values({
          remoteAgentId: fx.remoteAgentId,
          conversationId: fx.conversationId,
          activeTaskId: pendingTask,
        } as any)
        .execute()

      const rows = await runReplayQuery(db, fx.machineId, [fx.remoteAgentId])

      assert.equal(rows.length, 0, "a non-terminal task must not be replayed")
    })
  }
)
