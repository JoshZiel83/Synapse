// Persisters for Control Plane device → server business events. Each
// function is keyed to a JSON-RPC method the runtime sends after auth.
// Validation is minimal-but-sound: required fields must be UUIDs / strings;
// extra fields are ignored. Mismatches return a Result with `ok:false` so
// the control-plane handler can write a structured JSON-RPC error.

import {
  DeviceEventEmitParamsSchema,
  DeviceRuntimeSessionClosedParamsSchema,
  DeviceRuntimeSessionOpenedParamsSchema,
  DeviceTaskOutputParamsSchema,
  DeviceTaskRefParamsSchema,
  DeviceTaskResultParamsSchema,
  DeviceVfsExposureUpsertParamsSchema,
} from "@synapse/device-protocol"
import {
  upsertRuntimeSessionOpened,
  closeRuntimeSession,
  selectDeviceOperationOwner,
  selectDeviceOperationAttempt,
  selectTaskIdForOperation,
  setDeviceOperationStatus,
  setDeviceOperationAttemptStatus,
  markDeviceOperationOutputStreaming,
  finalizeDeviceOperationResult,
  selectInFlightDeviceTaskIds,
  selectExpiredDeviceTaskIds,
  insertRuntimeEvent,
  mergeVfsExposureMetadata,
} from "./repo.js"
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

export async function persistRuntimeSessionOpened(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = DeviceRuntimeSessionOpenedParamsSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: -32602,
      message: `Invalid device.runtime_session.opened params: ${parsed.error.message}`,
    }
  }
  try {
    await upsertRuntimeSessionOpened({
      runtimeSessionId: parsed.data.runtime_session_id,
      deviceId: deviceId,
      serviceId: serviceId,
      conversationId: parsed.data.conversation_id ?? null,
      actorId: parsed.data.actor_id ?? null,
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

export async function persistRuntimeSessionClosed(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = DeviceRuntimeSessionClosedParamsSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      code: -32602,
      message: `Invalid device.runtime_session.closed params: ${parsed.error.message}`,
    }
  }
  try {
    await closeRuntimeSession({
      runtimeSessionId: parsed.data.runtime_session_id,
      deviceId: deviceId,
      serviceId: serviceId,
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
  const op = await selectDeviceOperationOwner(args.operationId)
  if (!op) {
    return {
      ok: false,
      code: -32004,
      message: `operation ${args.operationId} not found`,
    }
  }
  if (op.deviceId !== args.deviceId) {
    return {
      ok: false,
      code: -32005,
      message: `operation ${args.operationId} does not belong to authenticated device`,
    }
  }
  if (args.attemptId) {
    const attempt = await selectDeviceOperationAttempt(args.attemptId)
    if (!attempt) {
      return {
        ok: false,
        code: -32004,
        message: `attempt ${args.attemptId} not found`,
      }
    }
    if (attempt.operationId !== args.operationId) {
      return {
        ok: false,
        code: -32005,
        message: `attempt ${args.attemptId} does not belong to operation ${args.operationId}`,
      }
    }
    if (attempt.deviceServiceId !== args.serviceId) {
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
  return selectTaskIdForOperation(operationId)
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
  const taskIds = await selectInFlightDeviceTaskIds(deviceId)
  let failed = 0
  for (const taskId of taskIds) {
    const task = await getToolCallTask(taskId)
    if (!task) continue
    // Disconnect is a machinery breakdown → lifecycle `failed` (retryable), not
    // completed/tool_error (which means the tool ran and returned an error).
    await failToolCallTask(taskId, {
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
  const taskIds = await selectExpiredDeviceTaskIds(now)
  let swept = 0
  for (const taskId of taskIds) {
    const reason = "Device tool timed out."
    // Timeout is a machinery breakdown → lifecycle `failed`, not tool_error.
    await failToolCallTask(taskId, {
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
  const parsed = DeviceTaskRefParamsSchema.safeParse(raw)
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
  await setDeviceOperationStatus(parsed.data.operation_id, deviceId, "received")
  if (parsed.data.attempt_id) {
    await setDeviceOperationAttemptStatus(
      parsed.data.attempt_id,
      serviceId,
      "sent"
    )
  }
  await driveDeviceTaskWorking(parsed.data.operation_id)
  return { ok: true }
}

export async function persistTaskStarted(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = DeviceTaskRefParamsSchema.safeParse(raw)
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
  await setDeviceOperationStatus(parsed.data.operation_id, deviceId, "started")
  await driveDeviceTaskWorking(parsed.data.operation_id)
  return { ok: true }
}

export async function persistTaskOutput(
  deviceId: string,
  serviceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = DeviceTaskOutputParamsSchema.safeParse(raw)
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
  await markDeviceOperationOutputStreaming(parsed.data.operation_id, deviceId)
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
  const parsed = DeviceTaskResultParamsSchema.safeParse(raw)
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
  await finalizeDeviceOperationResult({
    operationId: parsed.data.operation_id,
    deviceId,
    attemptId: parsed.data.attempt_id,
    serviceId,
    ok: parsed.data.ok,
    resultHash: parsed.data.result_hash ?? null,
    errorCode: parsed.data.error_code ?? null,
    errorMessage: parsed.data.error_message ?? null,
  })
  await driveDeviceTaskResult(parsed.data.operation_id, {
    ok: parsed.data.ok,
    errorMessage: parsed.data.error_message,
    resultHash: parsed.data.result_hash,
  })
  return { ok: true }
}

// ─── device.event.emit ──────────────────────────────────────────────────────

export async function persistDeviceEventEmit(
  workspaceId: string,
  raw: unknown
): Promise<PersistResult> {
  const parsed = DeviceEventEmitParamsSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  await insertRuntimeEvent({
    workspaceId: workspaceId,
    conversationId: parsed.data.conversation_id ?? null,
    level: parsed.data.level ?? "info",
    eventType: parsed.data.event_type,
    payloadJson: JSON.stringify(parsed.data.payload ?? {}),
  })
  return { ok: true }
}

// ─── device.vfs.exposure.upsert ─────────────────────────────────────────────

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
  const parsed = DeviceVfsExposureUpsertParamsSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, code: -32602, message: parsed.error.message }
  }
  await mergeVfsExposureMetadata(
    parsed.data.exposure_id,
    deviceId,
    JSON.stringify(parsed.data.vfs)
  )
  return { ok: true }
}
