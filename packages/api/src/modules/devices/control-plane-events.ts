// Persisters for Control Plane device → server business events. Each
// function is keyed to a JSON-RPC method the runtime sends after auth.
// Validation is minimal-but-sound: required fields must be UUIDs / strings;
// extra fields are ignored. Mismatches return a Result with `ok:false` so
// the control-plane handler can write a structured JSON-RPC error.

import { z } from "zod"
import { sql } from "kysely"
import { db } from "../../infrastructure/database/kysely.js"

export type PersistResult =
  | { ok: true; payload?: Record<string, unknown> }
  | { ok: false; code: number; message: string }

// ─── device.runtime_session.opened / closed ─────────────────────────────────

const RuntimeSessionOpenedSchema = z.object({
  runtime_session_id: z.uuid(),
  conversation_id: z.uuid().nullable().optional(),
  actor_id: z.uuid().nullable().optional(),
  conversation_actor_context_id: z.uuid().nullable().optional(),
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
        .insertInto("device_runtime_sessions")
        .values({
          id: parsed.data.runtime_session_id,
          device_id: deviceId,
          conversation_id: parsed.data.conversation_id ?? null,
          actor_id: parsed.data.actor_id ?? null,
          conversation_actor_context_id:
            parsed.data.conversation_actor_context_id ?? null,
          status: "open",
          opened_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            status: "open",
            opened_at: sql`NOW()`,
            updated_at: sql`NOW()`,
          })
        )
        .execute()
      await trx
        .insertInto("device_runtime_session_services")
        .values({
          session_id: parsed.data.runtime_session_id,
          service_id: serviceId,
          status: "open",
          opened_at: sql`NOW()`,
        })
        .onConflict((oc) =>
          oc.columns(["session_id", "service_id"]).doUpdateSet({
            status: "open",
            opened_at: sql`NOW()`,
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
        .updateTable("device_runtime_sessions")
        .set({
          status: "closed",
          closed_at: sql`NOW()`,
          updated_at: sql`NOW()`,
        })
        .where("id", "=", parsed.data.runtime_session_id)
        .where("device_id", "=", deviceId)
        .execute()
      await trx
        .updateTable("device_runtime_session_services")
        .set({ status: "closed", closed_at: sql`NOW()` })
        .where("session_id", "=", parsed.data.runtime_session_id)
        .where("service_id", "=", serviceId)
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
    .selectFrom("device_operations")
    .select(["id", "device_id"])
    .where("id", "=", args.operationId)
    .executeTakeFirst()
  if (!op) {
    return {
      ok: false,
      code: -32004,
      message: `operation ${args.operationId} not found`,
    }
  }
  if ((op.device_id as string) !== args.deviceId) {
    return {
      ok: false,
      code: -32005,
      message: `operation ${args.operationId} does not belong to authenticated device`,
    }
  }
  if (args.attemptId) {
    const attempt = await db
      .selectFrom("device_operation_attempts")
      .select(["id", "operation_id", "device_service_id"])
      .where("id", "=", args.attemptId)
      .executeTakeFirst()
    if (!attempt) {
      return {
        ok: false,
        code: -32004,
        message: `attempt ${args.attemptId} not found`,
      }
    }
    if ((attempt.operation_id as string) !== args.operationId) {
      return {
        ok: false,
        code: -32005,
        message: `attempt ${args.attemptId} does not belong to operation ${args.operationId}`,
      }
    }
    if ((attempt.device_service_id as string) !== args.serviceId) {
      return {
        ok: false,
        code: -32005,
        message: `attempt ${args.attemptId} does not belong to authenticated service`,
      }
    }
  }
  return { ok: true }
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
    .updateTable("device_operations")
    .set({ status: "received", updated_at: sql`NOW()` })
    .where("id", "=", parsed.data.operation_id)
    .where("device_id", "=", deviceId)
    .execute()
  if (parsed.data.attempt_id) {
    await db
      .updateTable("device_operation_attempts")
      .set({ status: "sent", updated_at: sql`NOW()` })
      .where("id", "=", parsed.data.attempt_id)
      .where("device_service_id", "=", serviceId)
      .execute()
  }
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
    .updateTable("device_operations")
    .set({ status: "started", updated_at: sql`NOW()` })
    .where("id", "=", parsed.data.operation_id)
    .where("device_id", "=", deviceId)
    .execute()
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
    .updateTable("device_operations")
    .set({ status: "output_streaming", updated_at: sql`NOW()` })
    .where("id", "=", parsed.data.operation_id)
    .where("device_id", "=", deviceId)
    .where("status", "in", ["started", "output_streaming"])
    .execute()
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
      .updateTable("device_operations")
      .set({
        status: parsed.data.ok ? "succeeded" : "failed",
        result_hash: parsed.data.result_hash ?? null,
        error_code: parsed.data.error_code ?? null,
        error_message: parsed.data.error_message ?? null,
        completed_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where("id", "=", parsed.data.operation_id)
      .where("device_id", "=", deviceId)
      .execute()
    if (parsed.data.attempt_id) {
      await trx
        .updateTable("device_operation_attempts")
        .set({
          status: parsed.data.ok ? "acknowledged" : "failed",
          response_at: sql`NOW()`,
          acknowledged_at: parsed.data.ok ? sql`NOW()` : null,
          updated_at: sql`NOW()`,
        })
        .where("id", "=", parsed.data.attempt_id)
        .where("device_service_id", "=", serviceId)
        .execute()
    }
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
    .insertInto("runtime_events")
    .values({
      workspace_id: workspaceId,
      conversation_id: parsed.data.conversation_id ?? null,
      // runtime_events_source enum carries 'device' as the device-emitted
      // event channel.
      source: "device",
      level: parsed.data.level ?? "info",
      event_type: parsed.data.event_type,
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
    .updateTable("device_exposures")
    .set({
      metadata: sql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('vfs', ${JSON.stringify(
        parsed.data.vfs
      )}::jsonb)`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", parsed.data.exposure_id)
    .where("device_id", "=", deviceId)
    .execute()
  return { ok: true }
}
