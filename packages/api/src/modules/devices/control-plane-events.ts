// Persisters for Control Plane device → server business events. Each
// function is keyed to a JSON-RPC method the runtime sends after auth.
// Validation is minimal-but-sound: required fields must be UUIDs / strings;
// extra fields are ignored. Mismatches return a Result with `ok:false` so
// the control-plane handler can write a structured JSON-RPC error.

import { z } from "zod"
import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"
import {
  appendToolCallTaskOutput,
  getToolCallTask,
  markToolCallTaskWorking,
  completeToolCallTask,
  failToolCallTask,
} from "../tool-call-tasks/service.js"
import { textBlocks } from "@synapse/shared"

export type PersistResult =
  | { ok: true; payload?: Record<string, unknown> }
  | { ok: false; code: number; message: string }

// ─── device.runtime_session.opened / closed ─────────────────────────────────

const RuntimeSessionOpenedSchema = z.object({
  runtime_session_id: z.uuid(),
  conversation_id: z.uuid().nullable().optional(),
  actor_id: z.uuid().nullable().optional(),
})

export async function persistRuntimeSessionOpened(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = RuntimeSessionOpenedSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: -32602,
      message: `Invalid device.runtime_session.opened params: ${parsed.error.message}`,
    }
  }
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("deviceRuntimeSessions")
        .values({
          id: parsed.data.runtime_session_id,
          deviceId: deviceId,
          conversationId: parsed.data.conversation_id ?? null,
          actorId: parsed.data.actor_id ?? null,
          status: "open",
          openedAt: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            status: "open",
            openedAt: sql`NOW()`,
          })
        )
        .execute()
      await trx
        .insertInto("deviceRuntimeSessionServices")
        .values({
          sessionId: parsed.data.runtime_session_id,
          serviceId: serviceId,
          status: "open",
          openedAt: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.columns(["sessionId", "serviceId"]).doUpdateSet({
            status: "open",
            openedAt: sql`NOW()`,
          })
        )
        .execute()
    })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      code: -32603,
      message: `runtime_session insert failed: ${(err as Error).message}`,
    }
  }
}

const RuntimeSessionClosedSchema = z.object({
  runtime_session_id: z.uuid(),
})

export async function persistRuntimeSessionClosed(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = RuntimeSessionClosedSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: -32602,
      message: `Invalid device.runtime_session.closed params: ${parsed.error.message}`,
    }
  }
  try {
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("deviceRuntimeSessions")
        .set({
          status: "closed",
          closedAt: sql`NOW()`,
        })
        .where("id", "=", parsed.data.runtime_session_id)
        .where("deviceId", "=", deviceId)
        .execute()
      await trx
        .updateTable("deviceRuntimeSessionServices")
        .set({ status: "closed", closedAt: sql`NOW()` })
        .where("sessionId", "=", parsed.data.runtime_session_id)
        .where("serviceId", "=", serviceId)
        .execute()
    })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      code: -32603,
      message: `runtime_session close failed: ${(err as Error).message}`,
    }
  }
}

// ─── device.task.* (async lifecycle for existing device_operations) ─────────

const TaskRefSchema = z.object({
  operation_id: z.uuid(),
  attempt_id: z.uuid().optional(),
})
const TaskOutputSchema = TaskRefSchema.extend({
  output: z.unknown(),
})
const TaskResultSchema = TaskRefSchema.extend({
  ok: z.boolean(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  result_hash: z.string().optional(),
})

/**
 * Verifies the operation row belongs to the authenticated device + the
 * attempt (if any) belongs to the authenticated service. Without this
 * check any authenticated device could forge state transitions on
 * another device's operations by guessing UUIDs.
 */
async function assertOperationOwnership(args: {
  operationId: string
  attemptId?: string
  deviceId: string
  serviceId: string
}): Promise<PersistResult> {
  const op = await db
    .selectFrom("deviceOperations")
    .select(["id", "deviceId"])
    .where("id", "=", args.operationId)
    .executeTakeFirst()
  if (!op) {
    return {
      ok: false,
      code: -32004,
      message: `operation ${args.operationId} not found`,
    }
  }
  if ((op.deviceId as string) !== args.deviceId) {
    return {
      ok: false,
      code: -32005,
      message: `operation ${args.operationId} does not belong to authenticated device`,
    }
  }
  if (args.attemptId) {
    const attempt = await db
      .selectFrom("deviceOperationAttempts")
      .select(["id", "operationId", "deviceServiceId"])
      .where("id", "=", args.attemptId)
      .executeTakeFirst()
    if (!attempt) {
      return {
        ok: false,
        code: -32004,
        message: `attempt ${args.attemptId} not found`,
      }
    }
    if ((attempt.operationId as string) !== args.operationId) {
      return {
        ok: false,
        code: -32005,
        message: `attempt ${args.attemptId} does not belong to operation ${args.operationId}`,
      }
    }
    if ((attempt.deviceServiceId as string) !== args.serviceId) {
      return {
        ok: false,
        code: -32005,
        message: `attempt ${args.attemptId} does not belong to authenticated service`,
      }
    }
  }
  return { ok: true }
}

// ─── device_tool rendezvous (design §3.6) ───────────────────────────────────
// When a device operation carries a tool_call_tasks.id (task_mode='async'
// dispatch), the device.task.* persisters ALSO drive that task: received/started
// → working; output → output chunk; result → terminal completion + delivery
// (notice + session wakeup). The task's SQL-predicate terminal guard +
// emitTaskNotice's atomic RETURNING flip make a retransmitted device.task.result
// an idempotent no-op (delivery fires exactly once even under concurrent
// terminal sources). Output seq is allocated atomically in-DB
// (appendToolCallTaskOutput without an explicit seq), and driveDeviceTaskOutput
// skips already-terminal tasks, so a replayed/out-of-order output can neither
// collide on seq nor mutate a completed task. NOTE: per-frame monotonic
// ordering across the control-plane socket is NOT yet enforced
// (device_control_plane_sessions.last_sequence is still unused); the guards
// above are what make replay/out-of-order safe today.

async function taskIdForOperation(operationId: string): Promise<string | null> {
  const row = await db
    .selectFrom("deviceOperations")
    .select("taskId")
    .where("id", "=", operationId)
    .executeTakeFirst()
  return row?.taskId || null
}

/** Drive the task to `working` when the device acks/starts (best-effort). */
async function driveDeviceTaskWorking(operationId: string) {
  const taskId = await taskIdForOperation(operationId)
  if (!taskId) return
  const task = await getToolCallTask(taskId)
  if (!task || task.lifecycleStatus === "completed") return
  await markToolCallTaskWorking(taskId).catch(() => undefined)
}

/** Append a device output chunk to the task's output tail (best-effort). */
async function driveDeviceTaskOutput(operationId: string, output: unknown) {
  const taskId = await taskIdForOperation(operationId)
  if (!taskId) return
  const task = await getToolCallTask(taskId)
  if (!task) return
  // Don't append to an already-terminal task (a late/replayed output after the
  // result frame); it can't reopen the task and shouldn't mutate it.
  if (
    task.lifecycleStatus === "completed" ||
    task.lifecycleStatus === "failed" ||
    task.lifecycleStatus === "cancelled" ||
    task.lifecycleStatus === "expired"
  ) {
    return
  }
  const text =
    typeof output === "string" ? output : JSON.stringify(output ?? "")
  if (!text.trim()) return
  // Omit seq → atomic server-side allocation (race-safe under concurrent
  // device.task.output frames; explicit seq + ON CONFLICT would silently drop).
  await appendToolCallTaskOutput(taskId, {
    stream: "stdout",
    text,
  }).catch(() => undefined)
}

/** Terminalize the task from the device result + deliver (idempotent). */
async function driveDeviceTaskResult(
  operationId: string,
  result: { ok: boolean; errorMessage?: string; resultHash?: string }
) {
  const taskId = await taskIdForOperation(operationId)
  if (!taskId) return
  const summary = result.ok
    ? "Device tool completed."
    : result.errorMessage?.trim() || "Device tool failed."
  await completeToolCallTask(taskId, {
    summary,
    outcome: result.ok ? "ok" : "tool_error",
    finalResultPayload: {
      content: textBlocks(summary),
      isError: !result.ok,
      resultHash: result.resultHash,
    },
    finalErrorPayload: result.ok
      ? undefined
      : { code: "device_tool_error", message: summary },
  }).catch(() => undefined)
}

/**
 * On device disconnect (control-plane socket close), fail every in-flight
 * device_tool task for that device so the waiting agent is woken with a
 * failure instead of hanging forever (design §3.6). Operations that already
 * completed are skipped via the task's terminal guard.
 */
export async function failInFlightDeviceTasksForDevice(
  deviceId: string,
  reason = "Device disconnected before the tool finished."
): Promise<number> {
  const rows = await db
    .selectFrom("deviceOperations as op")
    .innerJoin("toolCallTasks as t", "t.id", "op.taskId")
    .select("op.taskId as taskId")
    .where("op.deviceId", "=", deviceId)
    .where("op.taskId", "is not", null)
    .where("t.lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .execute()
  let failed = 0
  for (const row of rows) {
    if (!row.taskId) continue
    const task = await getToolCallTask(row.taskId)
    if (!task) continue
    // Disconnect is a machinery breakdown → lifecycle `failed` (retryable), not
    // completed/tool_error (which means the tool ran and returned an error).
    await failToolCallTask(row.taskId, {
      summary: reason,
      finalResultPayload: { content: textBlocks(reason), isError: true },
      finalErrorPayload: { code: "device_disconnected", message: reason },
    }).catch(() => undefined)
    failed += 1
  }
  return failed
}

/**
 * TTL sweeper: fail device_tool tasks whose deadline has elapsed while still
 * non-terminal (design §3.6 — `expires_at` was written but never enforced).
 * Returns the count swept. Call from a periodic worker.
 */
export async function sweepExpiredDeviceTasks(
  now = new Date()
): Promise<number> {
  const rows = await db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("executorKind", "=", "device_tool")
    .where("lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .where("expiresAt", "is not", null)
    .where("expiresAt", "<", now)
    .execute()
  let swept = 0
  for (const row of rows) {
    const reason = "Device tool timed out."
    // Timeout is a machinery breakdown → lifecycle `failed`, not tool_error.
    await failToolCallTask(row.id, {
      summary: reason,
      finalResultPayload: { content: textBlocks(reason), isError: true },
      finalErrorPayload: { code: "device_tool_timeout", message: reason },
    }).catch(() => undefined)
    swept += 1
  }
  return swept
}

export async function persistTaskReceived(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = TaskRefSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  const ownership = await assertOperationOwnership({
    operationId: parsed.data.operation_id,
    attemptId: parsed.data.attempt_id,
    deviceId,
    serviceId,
  })
  if (!ownership.ok) return ownership
  await db
    .updateTable("deviceOperations")
    .set({ status: "received" })
    .where("id", "=", parsed.data.operation_id)
    .where("deviceId", "=", deviceId)
    .execute()
  if (parsed.data.attempt_id) {
    await db
      .updateTable("deviceOperationAttempts")
      .set({ status: "sent" })
      .where("id", "=", parsed.data.attempt_id)
      .where("deviceServiceId", "=", serviceId)
      .execute()
  }
  await driveDeviceTaskWorking(parsed.data.operation_id)
  return { ok: true }
}

export async function persistTaskStarted(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = TaskRefSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  const ownership = await assertOperationOwnership({
    operationId: parsed.data.operation_id,
    attemptId: parsed.data.attempt_id,
    deviceId,
    serviceId,
  })
  if (!ownership.ok) return ownership
  await db
    .updateTable("deviceOperations")
    .set({ status: "started" })
    .where("id", "=", parsed.data.operation_id)
    .where("deviceId", "=", deviceId)
    .execute()
  await driveDeviceTaskWorking(parsed.data.operation_id)
  return { ok: true }
}

export async function persistTaskOutput(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = TaskOutputSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  const ownership = await assertOperationOwnership({
    operationId: parsed.data.operation_id,
    attemptId: parsed.data.attempt_id,
    deviceId,
    serviceId,
  })
  if (!ownership.ok) return ownership
  await db
    .updateTable("deviceOperations")
    .set({ status: "output_streaming" })
    .where("id", "=", parsed.data.operation_id)
    .where("deviceId", "=", deviceId)
    .where("status", "in", ["started", "output_streaming"])
    .execute()
  await driveDeviceTaskOutput(parsed.data.operation_id, parsed.data.output)
  return { ok: true }
}

export async function persistTaskStatus(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  return persistTaskStarted(deviceId, serviceId, raw)
}

export async function persistTaskResult(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = TaskResultSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  const ownership = await assertOperationOwnership({
    operationId: parsed.data.operation_id,
    attemptId: parsed.data.attempt_id,
    deviceId,
    serviceId,
  })
  if (!ownership.ok) return ownership
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("deviceOperations")
      .set({
        status: parsed.data.ok ? "succeeded" : "failed",
        resultHash: parsed.data.result_hash ?? null,
        errorCode: parsed.data.error_code ?? null,
        errorMessage: parsed.data.error_message ?? null,
        completedAt: sql`NOW()`,
      })
      .where("id", "=", parsed.data.operation_id)
      .where("deviceId", "=", deviceId)
      .execute()
    if (parsed.data.attempt_id) {
      await trx
        .updateTable("deviceOperationAttempts")
        .set({
          status: parsed.data.ok ? "acknowledged" : "failed",
          responseAt: sql`NOW()`,
          acknowledgedAt: parsed.data.ok ? sql`NOW()` : null,
        })
        .where("id", "=", parsed.data.attempt_id)
        .where("deviceServiceId", "=", serviceId)
        .execute()
    }
  })
  await driveDeviceTaskResult(parsed.data.operation_id, {
    ok: parsed.data.ok,
    errorMessage: parsed.data.error_message,
    resultHash: parsed.data.result_hash,
  })
  return { ok: true }
}

// ─── device.event.emit ──────────────────────────────────────────────────────

const EventEmitSchema = z.object({
  event_type: z.string().min(1).max(80),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  conversation_id: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

export async function persistDeviceEventEmit(
  workspaceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = EventEmitSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  await db
    .insertInto("runtimeEvents")
    .values({
      workspaceId: workspaceId,
      conversationId: parsed.data.conversation_id ?? null,
      // runtime_events_source enum carries 'device' as the device-emitted
      // event channel.
      source: "device",
      level: parsed.data.level ?? "info",
      eventType: parsed.data.event_type,
      payload: sql`${JSON.stringify(parsed.data.payload ?? {})}::jsonb`,
    })
    .execute()
  return { ok: true }
}

// ─── device.vfs.exposure.upsert ─────────────────────────────────────────────

const VfsExposureUpsertSchema = z.object({
  exposure_id: z.uuid(),
  vfs: z.record(z.string(), z.unknown()),
})

/**
 * VFS exposures are projections on top of filesystem / browser / cua
 * exposures. The v3.0 skeleton doesn't have a dedicated table for the
 * semantic tree; instead the device-side runtime maintains the projection
 * and the API persists a JSON snapshot on device_exposures.metadata.vfs so
 * the dashboard can render it.
 */
export async function persistVfsExposureUpsert(
  deviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = VfsExposureUpsertSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  await db
    .updateTable("deviceExposures")
    .set({
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('vfs', ${JSON.stringify(
        parsed.data.vfs
      )}::jsonb)`,
    })
    .where("id", "=", parsed.data.exposure_id)
    .where("deviceId", "=", deviceId)
    .execute()
  return { ok: true }
}
