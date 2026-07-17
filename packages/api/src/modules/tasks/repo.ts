/**
 * tasks module repo — owns DB I/O for the tasks module. This is the only
 * file in the module that may import the db client (guard r8 exempts
 * repo*.ts); service.ts threads its transaction `client` into these fns so
 * the load-bearing multi-statement transactions in service.ts stay atomic.
 *
 * Repo functions return camelCase DOMAIN records and KEEP Date objects;
 * time serialization belongs to presenters (guard r3). Raw `sql` joins alias
 * their computed/renamed result columns to double-quoted camelCase identifiers
 * (RawTaskRow) so the rows arrive camelCase under CamelCasePlugin's
 * unconditional `transformResult`; the presenter consumes that shape directly.
 */

import { z } from "zod"
import { CompiledQuery, sql } from "kysely"
import {
  db,
  runBuilder,
  type Executor,
} from "../../infrastructure/database/kysely.js"
import { withDbTransaction } from "../../infrastructure/database/kysely.js"
import type { DatabaseTransaction } from "../../infrastructure/database/kysely.js"
import type {
  ChatTaskResolveOutcome,
  RuntimeAuthorizationGrantOption,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationRequestMode,
  RuntimeAuthorizationRequestedAction,
  TaskRequestKind,
  Timestamp,
} from "@synapse/shared/types"
import {
  parseRuntimeAuthorizationGrantOptions,
  parseRuntimeAuthorizationPresets,
  parseRuntimeAuthorizationRequestedAction,
} from "@synapse/shared/schemas"
import { activeTraceparent } from "../../infrastructure/observability/traceparent.js"
import type { ToolCallTaskExecutorKind } from "../tool-call-tasks/service.js"
import type {
  ActionTokenPayload,
  RawTaskCommandRow,
  RawTaskDbRow,
  RawTaskRow,
  TaskCommandRow,
  ToolCallTaskActionTokensPayload,
  ToolCallTaskResponseCommandsBaseRevision,
  ToolCallTaskResponseCommandsRequestPayload,
  ToolCallTaskResponseCommandsResponsePayload,
  ToolCallTaskRuntimeAuthorizationAvailablePresets,
  ToolCallTaskRuntimeAuthorizationGrantOptions,
  ToolCallTaskRuntimeAuthorizationRequestedAction,
  ToolCallTaskRuntimeAuthorizationSourceRequestArgs,
  ToolCallTasksFinalResultPayload,
} from "./repo.types.js"

const ActionTokenPayloadSchema = z
  .object({
    decision: z.string().min(1),
    preset: z.string().min(1).optional(),
    selectedGrantOptionId: z.string().min(1).optional(),
  })
  .strict()

/**
 * Open a tasks-module transaction. Thin re-export of {@link withDbTransaction}
 * so service.ts keeps its multi-statement transactions (interleaving repo
 * writes with cross-module side effects) WITHOUT importing the db client.
 * The callback receives the tx executor the service threads into repo fns.
 */
export function withTaskTransaction<T>(
  fn: (client: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return withDbTransaction(fn)
}

/** Run raw SQL (text+params) on db / trx. */
export async function runOn<T extends object = Record<string, unknown>>(
  executor: Executor,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await executor.executeQuery<T>(
    CompiledQuery.raw(text, [...params])
  )
  return {
    rows: result.rows as T[],
    rowCount:
      result.numAffectedRows === undefined
        ? null
        : Number(result.numAffectedRows),
  }
}

/**
 * Run a pre-compiled query on an optional executor: native executeQuery for
 * Kysely executors / top-level db (when undefined).
 */
export async function runCompiledOn<T = any>(
  executor: Executor | undefined,
  compiled: CompiledQuery<T>
): Promise<{ rows: T[]; rowCount?: number | null }> {
  const result = await (executor ?? db).executeQuery(compiled)
  return {
    rows: result.rows as T[],
    rowCount:
      result.numAffectedRows === undefined
        ? null
        : Number(result.numAffectedRows),
  }
}

/** `value::jsonb` cast helper used by the task writers. */
export function jsonbValue<T>(value: T) {
  return sql<T>`${JSON.stringify(value ?? null)}::jsonb`
}

export interface UpsertProjectionParams {
  taskId: string
  workspaceId: string
  conversationId: string
}

/**
 * Insert (or re-arm) the task transport projection row. Re-arm only fires when
 * the existing row is skipped for a recoverable binding/transport reason.
 */
export async function upsertTaskTransportProjection(
  executor: Executor,
  params: UpsertProjectionParams
): Promise<void> {
  await sql`
    INSERT INTO tool_call_task_transport_projections (
      task_id, workspace_id, conversation_id, status
    )
    VALUES (${params.taskId}, ${params.workspaceId}, ${params.conversationId}, 'pending')
    ON CONFLICT (task_id) DO UPDATE
      SET status = 'pending',
          next_attempt_at = NOW(),
          attempts = 0,
          error = NULL,
          transport_message_link_id = NULL
      WHERE tool_call_task_transport_projections.status = 'skipped'
        AND tool_call_task_transport_projections.error IN (
          'no_binding',
          'outbound_disabled',
          'webhook_inbound_unavailable'
        )
  `.execute(executor)
}

function requireJsonObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new Error(`${label} is required`)
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      throw new Error(`${label} is required`)
    }
    try {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON object`)
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `${label} must be a JSON object`
      ) {
        throw error
      }
      throw new Error(`${label} must be a valid JSON object`)
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseOptionalJsonObject(
  value: unknown,
  label: string
): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null
  }
  return requireJsonObject(value, label)
}

function parseJsonArray<T>(value: unknown, label: string): T[] {
  if (value === null || value === undefined) {
    return []
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array`)
      }
      return parsed as T[]
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `${label} must be a JSON array`
      ) {
        throw error
      }
      throw new Error(`${label} must be a valid JSON array`)
    }
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`)
  }
  return value as T[]
}

function parseOptionalJsonArray<T>(value: unknown, label: string): T[] | null {
  if (value === null || value === undefined) {
    return null
  }
  return parseJsonArray<T>(value, label)
}

function parseOptionalRuntimeAuthorizationRequestedAction(
  value: unknown,
  label: string
): RuntimeAuthorizationRequestedAction | null {
  const parsed = parseOptionalJsonObject(value, label)
  if (parsed === null) {
    return null
  }
  try {
    return parseRuntimeAuthorizationRequestedAction(parsed)
  } catch {
    throw new Error(`${label} is invalid`)
  }
}

function parseOptionalRuntimeAuthorizationGrantOptions(
  value: unknown,
  label: string
): RuntimeAuthorizationGrantOption[] | null {
  const parsed = parseOptionalJsonArray<unknown>(value, label)
  if (parsed === null) {
    return null
  }
  try {
    return parseRuntimeAuthorizationGrantOptions(parsed)
  } catch {
    throw new Error(`${label} is invalid`)
  }
}

function parseOptionalRuntimeAuthorizationPresets(
  value: unknown,
  label: string
): RuntimeAuthorizationPreset[] | null {
  const parsed = parseOptionalJsonArray<unknown>(value, label)
  if (parsed === null) {
    return null
  }
  try {
    return parseRuntimeAuthorizationPresets(parsed)
  } catch {
    throw new Error(`${label} is invalid`)
  }
}

export function decodeTaskPromptPayload(row: {
  promptPayload: unknown
}): Record<string, unknown> {
  return requireJsonObject(row.promptPayload, "Task prompt_payload")
}

export function decodeTaskResolutionPayload(row: {
  resolutionPayload: unknown
}): Record<string, unknown> {
  return requireJsonObject(row.resolutionPayload, "Task resolution_payload")
}

export function decodeActionTokenPayload(row: {
  token?: string
  payload: unknown
}): ActionTokenPayload {
  const label = row.token ? `Action token ${row.token}` : "Action token"
  const parsed = ActionTokenPayloadSchema.safeParse(
    requireJsonObject(row.payload, `${label} payload`)
  )
  if (!parsed.success) {
    throw new Error(`${label} payload is invalid`)
  }
  return parsed.data
}

export function normalizeTaskRow(row: RawTaskDbRow): RawTaskRow {
  const normalized = {
    ...row,
    promptPayload: requireJsonObject(
      row.promptPayload,
      `Task ${row.id} prompt_payload`
    ),
    planPayload: requireJsonObject(
      row.planPayload,
      `Task ${row.id} plan_payload`
    ),
    resolutionPayload: requireJsonObject(
      row.resolutionPayload,
      `Task ${row.id} resolution_payload`
    ),
    requestedAction: parseOptionalRuntimeAuthorizationRequestedAction(
      row.requestedAction,
      `Task ${row.id} requested_action`
    ),
    grantOptions: parseOptionalRuntimeAuthorizationGrantOptions(
      row.grantOptions,
      `Task ${row.id} grant_options`
    ),
    availablePresets: parseOptionalRuntimeAuthorizationPresets(
      row.availablePresets,
      `Task ${row.id} available_presets`
    ),
    sourceRequestArgs: parseOptionalJsonObject(
      row.sourceRequestArgs,
      `Task ${row.id} source_request_args`
    ),
  }
  return normalized
}

export function normalizeTaskCommandRow(
  row: RawTaskCommandRow
): TaskCommandRow {
  return {
    id: row.id,
    taskId: row.taskId,
    commandId: row.commandId,
    baseRevision: row.baseRevision,
    outcome: row.outcome,
    requestPayload: requireJsonObject(
      row.requestPayload,
      `Task command ${row.id} request_payload`
    ),
    responsePayload: requireJsonObject(
      row.responsePayload,
      `Task command ${row.id} response_payload`
    ),
    createdByWorkspaceMemberId: row.createdByWorkspaceMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Atomic insert on the caller's executor (preserves the tx-mint contract:
 * the worker passes its tx `client` so the token row commits in the SAME
 * transaction as the projection write). The payload is cast via raw
 * `::jsonb` to bypass CamelCasePlugin nested-key mangling.
 */
export async function insertActionToken(
  executor: Executor,
  row: {
    token: string
    taskId: string
    payload: ActionTokenPayload
    expiresAt: Date
  }
): Promise<void> {
  await runBuilder(
    executor,
    db.insertInto("toolCallTaskActionTokens").values({
      token: row.token,
      taskId: row.taskId,
      payload: sql`${JSON.stringify(
        row.payload
      )}::jsonb` as unknown as ToolCallTaskActionTokensPayload,
      expiresAt: row.expiresAt,
    })
  )
}

/**
 * Direct read on the singleton — returns a camelCase domain record
 * (Date kept) or null.
 */
export async function findActionTokenRow(token: string): Promise<{
  token: string
  taskId: string
  payload: ActionTokenPayload
  expiresAt: Date
} | null> {
  const row = await db
    .selectFrom("toolCallTaskActionTokens")
    .select(["token", "taskId", "payload", "expiresAt"])
    .where("token", "=", token)
    .limit(1)
    .executeTakeFirst()
  if (!row) return null
  return {
    token: row.token,
    taskId: row.taskId,
    payload: decodeActionTokenPayload({
      token: row.token,
      payload: row.payload,
    }),
    expiresAt: row.expiresAt,
  }
}

/**
 * Direct delete sweep of expired token rows — returns affected count.
 * Uses a server-side `NOW()` comparison to avoid app/db clock skew.
 */
export async function deleteExpiredActionTokens(): Promise<number> {
  const result = await db
    .deleteFrom("toolCallTaskActionTokens")
    .where("expiresAt", "<", sql<Date>`NOW()`)
    .executeTakeFirst()
  return Number(result.numDeletedRows ?? 0)
}

/**
 * Resolve a conversation participant to its access_subjects id (the task
 * delivery key). Used by the remote-agent task paths that mint their own
 * task (the principal is the requesting remote_agent's participant subject).
 */
export async function resolveParticipantSubjectId(
  client: Executor,
  participantId: string
): Promise<string> {
  const row = await client
    .selectFrom("conversationParticipants")
    .select("subjectId")
    .where("id", "=", participantId)
    .limit(1)
    .executeTakeFirst()
  if (!row?.subjectId) {
    throw new Error(`Participant ${participantId} has no subject`)
  }
  return row.subjectId
}

export async function getTaskRowById(taskId: string, queryable?: Executor) {
  const compiled = sql<RawTaskDbRow>`
    SELECT ir.*,
            ir.executor_kind AS "kind",
            ir.request_payload AS "promptPayload",
            ir.request_payload AS "planPayload",
            auth.requested_tool_name AS "requestedToolName",
            auth.reason AS "reason",
            auth.request_mode AS "requestMode",
            auth.requested_action AS "requestedAction",
            auth.grant_options AS "grantOptions",
            auth.available_presets AS "availablePresets",
            auth.source_request_args AS "sourceRequestArgs",
            auth.source_runtime_session_id AS "sourceRuntimeSessionId",
            auth.source_retry_nonce AS "sourceRetryNonce",
            auth.principal_subject_id AS "principalSubjectId",
            auth.principal_scope_subject_id AS "principalScopeSubjectId",
            principal_subj.kind AS "principalSubjectKind",
            principal_subj.remote_agent_id AS "principalRemoteAgentId",
            ir.final_result_payload AS "resolutionPayload",
            auth.runtime_id AS "runtimeId",
            auth.runtime_capability_id AS "runtimeCapabilityId",
            auth.runtime_exposure_id AS "runtimeExposureId",
            auth.runtime_tool_stable_key AS "runtimeToolStableKey",
            requester_subj.workspace_member_id AS "requesterWorkspaceMemberId",
            requester_subj.actor_id AS "requesterActorId",
            requester_subj.remote_agent_id AS "requesterRemoteAgentId",
            requester_subj.kind AS "requesterParticipantType",
            COALESCE(requester_remote_agent_app.display_name, requester_actor_app.display_name, requester_user.name, requester.display_name) AS "requesterName",
            COALESCE(requester_remote_agent.title, requester_actor.title) AS "requesterTitle",
            COALESCE(CASE WHEN requester_remote_agent.id IS NOT NULL THEN 'remote_agent' END, requester_actor.role::text) AS "requesterRole",
            requester_actor.avatar_file_id AS "requesterActorAvatarFileId",
            requester_user.avatar_file_id AS "requesterUserAvatarFileId",
            requester_remote_agent.avatar_file_id AS "requesterRemoteAgentAvatarFileId",
            COALESCE(requester_remote_agent.avatar_emoji, requester_actor.avatar_emoji) AS "requesterAvatarEmoji",
            target_subj.workspace_member_id AS "targetWorkspaceMemberId",
            target_subj.actor_id AS "targetActorId",
            target_subj.remote_agent_id AS "targetRemoteAgentId",
            target_subj.kind AS "targetParticipantType",
            COALESCE(target_remote_agent_app.display_name, target_actor_app.display_name, target_user.name, target.display_name) AS "targetName",
            COALESCE(target_remote_agent.title, target_actor.title) AS "targetTitle",
            COALESCE(CASE WHEN target_remote_agent.id IS NOT NULL THEN 'remote_agent' END, target_actor.role::text) AS "targetRole",
            target_actor.avatar_file_id AS "targetActorAvatarFileId",
            target_user.avatar_file_id AS "targetUserAvatarFileId",
            target_remote_agent.avatar_file_id AS "targetRemoteAgentAvatarFileId",
            COALESCE(target_remote_agent.avatar_emoji, target_actor.avatar_emoji) AS "targetAvatarEmoji",
            resolver_subj.workspace_member_id AS "resolvedByWorkspaceMemberId",
            resolver_subj.actor_id AS "resolvedByActorId",
            resolver_subj.remote_agent_id AS "resolvedByRemoteAgentId",
            resolver_subj.kind AS "resolvedByParticipantType",
            COALESCE(resolver_remote_agent_app.display_name, resolver_actor_app.display_name, resolver_user.name, resolver.display_name) AS "resolvedByName",
            COALESCE(resolver_remote_agent.title, resolver_actor.title) AS "resolvedByTitle",
            COALESCE(CASE WHEN resolver_remote_agent.id IS NOT NULL THEN 'remote_agent' END, resolver_actor.role::text) AS "resolvedByRole",
            resolver_actor.avatar_file_id AS "resolvedByActorAvatarFileId",
            resolver_user.avatar_file_id AS "resolvedByUserAvatarFileId",
            resolver_remote_agent.avatar_file_id AS "resolvedByRemoteAgentAvatarFileId",
            COALESCE(resolver_remote_agent.avatar_emoji, resolver_actor.avatar_emoji) AS "resolvedByAvatarEmoji",
            COALESCE(device.title, 'Sandbox') AS "runtimeDisplayName",
            exposure.display_name AS "exposureDisplayName",
            exposure.stable_key AS "exposureStableKey"
     FROM tool_call_tasks ir
     LEFT JOIN tool_call_task_runtime_authorization auth
       ON auth.task_id = ir.id
     LEFT JOIN access_subjects principal_subj
       ON principal_subj.id = auth.principal_subject_id
     LEFT JOIN conversation_participants requester
       ON requester.id = ir.requester_participant_id
     LEFT JOIN access_subjects requester_subj
       ON requester_subj.id = requester.subject_id
     LEFT JOIN actors requester_actor
       ON requester_actor.id = requester_subj.actor_id
     LEFT JOIN workspace_resources_live requester_actor_app
       ON requester_actor_app.id = requester_actor.id
     LEFT JOIN remote_agents requester_remote_agent
       ON requester_remote_agent.id = requester_subj.remote_agent_id
     LEFT JOIN workspace_resources_live requester_remote_agent_app
       ON requester_remote_agent_app.id = requester_remote_agent.id
     LEFT JOIN workspace_members requester_wm
       ON requester_wm.id = requester_subj.workspace_member_id
     LEFT JOIN users requester_user
       ON requester_user.id = requester_wm.user_id
     LEFT JOIN conversation_participants target
       ON target.id = ir.target_participant_id
     LEFT JOIN access_subjects target_subj
       ON target_subj.id = target.subject_id
     LEFT JOIN actors target_actor
       ON target_actor.id = target_subj.actor_id
     LEFT JOIN workspace_resources_live target_actor_app
       ON target_actor_app.id = target_actor.id
     LEFT JOIN remote_agents target_remote_agent
       ON target_remote_agent.id = target_subj.remote_agent_id
     LEFT JOIN workspace_resources_live target_remote_agent_app
       ON target_remote_agent_app.id = target_remote_agent.id
     LEFT JOIN workspace_members target_wm
       ON target_wm.id = target_subj.workspace_member_id
     LEFT JOIN users target_user
       ON target_user.id = target_wm.user_id
     LEFT JOIN conversation_participants resolver
       ON resolver.id = ir.resolved_by_participant_id
     LEFT JOIN access_subjects resolver_subj
       ON resolver_subj.id = resolver.subject_id
     LEFT JOIN actors resolver_actor
       ON resolver_actor.id = resolver_subj.actor_id
     LEFT JOIN workspace_resources_live resolver_actor_app
       ON resolver_actor_app.id = resolver_actor.id
     LEFT JOIN remote_agents resolver_remote_agent
       ON resolver_remote_agent.id = resolver_subj.remote_agent_id
     LEFT JOIN workspace_resources_live resolver_remote_agent_app
       ON resolver_remote_agent_app.id = resolver_remote_agent.id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver_subj.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN devices device
       ON device.id = auth.runtime_id
     LEFT JOIN runtime_exposures exposure
       ON exposure.id = auth.runtime_exposure_id
     WHERE ir.id = ${taskId}
     LIMIT 1
  `.compile(db)
  const result = await runCompiledOn<RawTaskDbRow>(queryable, compiled)
  const row = result.rows[0]
  return row ? normalizeTaskRow(row) : null
}

export async function getTaskRowByIdForUpdate(
  taskId: string,
  queryable: Executor
) {
  const compiled = sql<RawTaskDbRow>`
    SELECT ir.*,
            ir.executor_kind AS "kind",
            ir.request_payload AS "promptPayload",
            ir.request_payload AS "planPayload",
            auth.requested_tool_name AS "requestedToolName",
            auth.reason AS "reason",
            auth.request_mode AS "requestMode",
            auth.requested_action AS "requestedAction",
            auth.grant_options AS "grantOptions",
            auth.available_presets AS "availablePresets",
            auth.source_request_args AS "sourceRequestArgs",
            auth.source_runtime_session_id AS "sourceRuntimeSessionId",
            auth.source_retry_nonce AS "sourceRetryNonce",
            auth.principal_subject_id AS "principalSubjectId",
            auth.principal_scope_subject_id AS "principalScopeSubjectId",
            principal_subj.kind AS "principalSubjectKind",
            principal_subj.remote_agent_id AS "principalRemoteAgentId",
            ir.final_result_payload AS "resolutionPayload",
            auth.runtime_id AS "runtimeId",
            auth.runtime_capability_id AS "runtimeCapabilityId",
            auth.runtime_exposure_id AS "runtimeExposureId",
            auth.runtime_tool_stable_key AS "runtimeToolStableKey",
            requester_subj.workspace_member_id AS "requesterWorkspaceMemberId",
            requester_subj.actor_id AS "requesterActorId",
            requester_subj.remote_agent_id AS "requesterRemoteAgentId",
            requester_subj.kind AS "requesterParticipantType",
            COALESCE(requester_remote_agent_app.display_name, requester_actor_app.display_name, requester_user.name, requester.display_name) AS "requesterName",
            COALESCE(requester_remote_agent.title, requester_actor.title) AS "requesterTitle",
            COALESCE(CASE WHEN requester_remote_agent.id IS NOT NULL THEN 'remote_agent' END, requester_actor.role::text) AS "requesterRole",
            requester_actor.avatar_file_id AS "requesterActorAvatarFileId",
            requester_user.avatar_file_id AS "requesterUserAvatarFileId",
            requester_remote_agent.avatar_file_id AS "requesterRemoteAgentAvatarFileId",
            COALESCE(requester_remote_agent.avatar_emoji, requester_actor.avatar_emoji) AS "requesterAvatarEmoji",
            target_subj.workspace_member_id AS "targetWorkspaceMemberId",
            target_subj.actor_id AS "targetActorId",
            target_subj.remote_agent_id AS "targetRemoteAgentId",
            target_subj.kind AS "targetParticipantType",
            COALESCE(target_remote_agent_app.display_name, target_actor_app.display_name, target_user.name, target.display_name) AS "targetName",
            COALESCE(target_remote_agent.title, target_actor.title) AS "targetTitle",
            COALESCE(CASE WHEN target_remote_agent.id IS NOT NULL THEN 'remote_agent' END, target_actor.role::text) AS "targetRole",
            target_actor.avatar_file_id AS "targetActorAvatarFileId",
            target_user.avatar_file_id AS "targetUserAvatarFileId",
            target_remote_agent.avatar_file_id AS "targetRemoteAgentAvatarFileId",
            COALESCE(target_remote_agent.avatar_emoji, target_actor.avatar_emoji) AS "targetAvatarEmoji",
            resolver_subj.workspace_member_id AS "resolvedByWorkspaceMemberId",
            resolver_subj.actor_id AS "resolvedByActorId",
            resolver_subj.remote_agent_id AS "resolvedByRemoteAgentId",
            resolver_subj.kind AS "resolvedByParticipantType",
            COALESCE(resolver_remote_agent_app.display_name, resolver_actor_app.display_name, resolver_user.name, resolver.display_name) AS "resolvedByName",
            COALESCE(resolver_remote_agent.title, resolver_actor.title) AS "resolvedByTitle",
            COALESCE(CASE WHEN resolver_remote_agent.id IS NOT NULL THEN 'remote_agent' END, resolver_actor.role::text) AS "resolvedByRole",
            resolver_actor.avatar_file_id AS "resolvedByActorAvatarFileId",
            resolver_user.avatar_file_id AS "resolvedByUserAvatarFileId",
            resolver_remote_agent.avatar_file_id AS "resolvedByRemoteAgentAvatarFileId",
            COALESCE(resolver_remote_agent.avatar_emoji, resolver_actor.avatar_emoji) AS "resolvedByAvatarEmoji",
            COALESCE(device.title, 'Sandbox') AS "runtimeDisplayName",
            exposure.display_name AS "exposureDisplayName",
            exposure.stable_key AS "exposureStableKey"
     FROM tool_call_tasks ir
     LEFT JOIN tool_call_task_runtime_authorization auth
       ON auth.task_id = ir.id
     LEFT JOIN access_subjects principal_subj
       ON principal_subj.id = auth.principal_subject_id
     LEFT JOIN conversation_participants requester
       ON requester.id = ir.requester_participant_id
     LEFT JOIN access_subjects requester_subj
       ON requester_subj.id = requester.subject_id
     LEFT JOIN actors requester_actor
       ON requester_actor.id = requester_subj.actor_id
     LEFT JOIN workspace_resources_live requester_actor_app
       ON requester_actor_app.id = requester_actor.id
     LEFT JOIN remote_agents requester_remote_agent
       ON requester_remote_agent.id = requester_subj.remote_agent_id
     LEFT JOIN workspace_resources_live requester_remote_agent_app
       ON requester_remote_agent_app.id = requester_remote_agent.id
     LEFT JOIN workspace_members requester_wm
       ON requester_wm.id = requester_subj.workspace_member_id
     LEFT JOIN users requester_user
       ON requester_user.id = requester_wm.user_id
     LEFT JOIN conversation_participants target
       ON target.id = ir.target_participant_id
     LEFT JOIN access_subjects target_subj
       ON target_subj.id = target.subject_id
     LEFT JOIN actors target_actor
       ON target_actor.id = target_subj.actor_id
     LEFT JOIN workspace_resources_live target_actor_app
       ON target_actor_app.id = target_actor.id
     LEFT JOIN remote_agents target_remote_agent
       ON target_remote_agent.id = target_subj.remote_agent_id
     LEFT JOIN workspace_resources_live target_remote_agent_app
       ON target_remote_agent_app.id = target_remote_agent.id
     LEFT JOIN workspace_members target_wm
       ON target_wm.id = target_subj.workspace_member_id
     LEFT JOIN users target_user
       ON target_user.id = target_wm.user_id
     LEFT JOIN conversation_participants resolver
       ON resolver.id = ir.resolved_by_participant_id
     LEFT JOIN access_subjects resolver_subj
       ON resolver_subj.id = resolver.subject_id
     LEFT JOIN actors resolver_actor
       ON resolver_actor.id = resolver_subj.actor_id
     LEFT JOIN workspace_resources_live resolver_actor_app
       ON resolver_actor_app.id = resolver_actor.id
     LEFT JOIN remote_agents resolver_remote_agent
       ON resolver_remote_agent.id = resolver_subj.remote_agent_id
     LEFT JOIN workspace_resources_live resolver_remote_agent_app
       ON resolver_remote_agent_app.id = resolver_remote_agent.id
     LEFT JOIN workspace_members resolver_wm
       ON resolver_wm.id = resolver_subj.workspace_member_id
     LEFT JOIN users resolver_user
       ON resolver_user.id = resolver_wm.user_id
     LEFT JOIN devices device
       ON device.id = auth.runtime_id
     LEFT JOIN runtime_exposures exposure
       ON exposure.id = auth.runtime_exposure_id
     WHERE ir.id = ${taskId}
     LIMIT 1
     FOR UPDATE OF ir
  `.compile(db)
  const result = await runCompiledOn<RawTaskDbRow>(queryable, compiled)
  const row = result.rows[0]
  return row ? normalizeTaskRow(row) : null
}

export async function getTaskCommandRow(
  taskId: string,
  commandId: string,
  queryable?: Executor
) {
  const compiled = db
    .selectFrom("toolCallTaskResponseCommands")
    .selectAll()
    .where("taskId", "=", taskId)
    .where("commandId", "=", commandId)
    .limit(1)
    .compile()
  const result = await runCompiledOn<RawTaskCommandRow>(queryable, compiled)
  const row = result.rows[0]
  return row ? normalizeTaskCommandRow(row) : null
}

export async function insertTaskCommandRow(
  client: Executor,
  params: {
    taskId: string
    commandId: string
    baseRevision: number
    outcome: ChatTaskResolveOutcome
    requestPayload: Record<string, unknown>
    responsePayload: unknown
    createdByWorkspaceMemberId: string
  }
) {
  await runBuilder(
    client,
    db.insertInto("toolCallTaskResponseCommands").values({
      taskId: params.taskId,
      commandId: params.commandId,
      baseRevision:
        params.baseRevision as unknown as ToolCallTaskResponseCommandsBaseRevision,
      outcome: params.outcome,
      requestPayload: jsonbValue(
        params.requestPayload
      ) as unknown as ToolCallTaskResponseCommandsRequestPayload,
      responsePayload: jsonbValue(
        params.responsePayload
      ) as unknown as ToolCallTaskResponseCommandsResponsePayload,
      createdByWorkspaceMemberId: params.createdByWorkspaceMemberId,
    })
  )
}

export async function insertTaskRequest(
  client: Executor,
  params: {
    workspaceId: string
    conversationId: string
    taskId?: string
    remoteAgentRunId?: string
    requesterParticipantId: string
    kind: TaskRequestKind
    requestKey: string
    targetParticipantId?: string
    expiresAt?: Timestamp
  }
): Promise<string | null> {
  // The caller already created the tool_call_tasks row with its request_key and
  // dedupe metadata. Here we attach the human-facing participant fields and
  // return the parent id. The dedupe ON CONFLICT lives at task creation; this
  // UPDATE only succeeds while the task is still non-terminal.
  if (!params.taskId) {
    throw new Error("insertTaskRequest requires a taskId")
  }
  const updated = await runCompiledOn<{ id: string }>(
    client,
    sql<{ id: string }>`
      UPDATE tool_call_tasks
      SET requester_participant_id = ${params.requesterParticipantId},
          target_participant_id = ${params.targetParticipantId || null},
          remote_agent_run_id = COALESCE(${params.remoteAgentRunId || null}, remote_agent_run_id),
          expires_at = COALESCE(${params.expiresAt || null}, expires_at)
      WHERE id = ${params.taskId}
        AND lifecycle_status IN ('submitted', 'working', 'input_required', 'auth_required')
      RETURNING id
    `.compile(db)
  )
  return updated.rows[0]?.id ?? null
}

export async function findTaskIdByTaskId(taskId: string, queryable?: Executor) {
  // Confirm the task exists and is non-terminal so dedupe-reuse only returns a
  // live row.
  const compiled = db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("id", "=", taskId)
    .limit(1)
    .compile()
  const result = await runCompiledOn<{ id: string }>(queryable, compiled)
  return result.rows[0]?.id || null
}

export async function findPendingTaskIdByRequestKey(
  workspaceId: string,
  requestKey: string,
  queryable?: Executor
) {
  const compiled = db
    .selectFrom("toolCallTasks")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("requestKey", "=", requestKey)
    .where("lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .limit(1)
    .compile()
  const result = await runCompiledOn<{ id: string }>(queryable, compiled)
  return result.rows[0]?.id || null
}

export async function insertRuntimeAuthorizationTaskDetails(
  client: Executor,
  params: {
    taskId: string
    runtimeId: string
    runtimeCapabilityId: string
    runtimeExposureId: string
    requestedToolName: string
    runtimeToolStableKey: string
    reason: string
    requestMode: RuntimeAuthorizationRequestMode
    sourceRuntimeSessionId?: string
    sourceRetryNonce?: string
    sourceRequestArgs: Record<string, unknown>
    requestedAction: RuntimeAuthorizationRequestedAction
    grantOptions: RuntimeAuthorizationGrantOption[]
    availablePresets: RuntimeAuthorizationPreset[]
    dedupeKey: string
    principalSubjectId: string
    principalScopeSubjectId?: string | null
    principalRemoteAgentId?: string
  }
) {
  await runBuilder(
    client,
    db.insertInto("toolCallTaskRuntimeAuthorization").values({
      taskId: params.taskId,
      runtimeId: params.runtimeId,
      runtimeCapabilityId: params.runtimeCapabilityId,
      runtimeExposureId: params.runtimeExposureId,
      requestedToolName: params.requestedToolName,
      runtimeToolStableKey: params.runtimeToolStableKey,
      reason: params.reason,
      requestMode: params.requestMode,
      sourceRuntimeSessionId: params.sourceRuntimeSessionId || null,
      sourceRetryNonce: params.sourceRetryNonce || null,
      sourceRequestArgs: jsonbValue(
        params.sourceRequestArgs
      ) as unknown as ToolCallTaskRuntimeAuthorizationSourceRequestArgs,
      principalSubjectId: params.principalSubjectId,
      principalScopeSubjectId: params.principalScopeSubjectId || null,
      requestedAction: jsonbValue(
        params.requestedAction
      ) as unknown as ToolCallTaskRuntimeAuthorizationRequestedAction,
      grantOptions: jsonbValue(
        params.grantOptions
      ) as unknown as ToolCallTaskRuntimeAuthorizationGrantOptions,
      availablePresets: jsonbValue(
        params.availablePresets
      ) as unknown as ToolCallTaskRuntimeAuthorizationAvailablePresets,
      dedupeKey: params.dedupeKey,
    })
  )
}

export async function updateTaskConversationItemId(
  client: Executor,
  taskId: string,
  conversationItemId: string
) {
  const result = await runBuilder(
    client,
    db
      .updateTable("toolCallTasks")
      .set({
        conversationItemId: conversationItemId,
      })
      .where("id", "=", taskId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update conversation item for task ${taskId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

export async function updateTaskRequestRow(
  client: Executor,
  taskId: string,
  values: Record<string, unknown>
) {
  const result = await runBuilder(
    client,
    db.updateTable("toolCallTasks").set(values).where("id", "=", taskId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update task ${taskId}, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

export async function updateResolvedTaskRequestRow(
  client: Executor,
  taskId: string,
  values: Record<string, unknown>
) {
  await updateTaskRequestRow(client, taskId, {
    ...values,
    revision: sql`revision + 1`,
    resolvedAt: sql`NOW()`,
    // The single terminal-flip writer stamps the resolver's trace so the
    // reconnect-replayed agent:task:resolved frame (task-resolution-notifier)
    // stays correlated after a daemon restart. Traceparent-only per §3c; NULL
    // when tracing is off / no active span.
    resolutionTraceparent: activeTraceparent() ?? null,
  })
}

export async function updateTaskResolutionPayload(
  client: Executor,
  taskId: string,
  payload: Record<string, unknown>
) {
  // Task unification: resolution payload lives on the task (final_result_payload)
  // for all kinds — no per-kind detail-table write.
  const result = await runBuilder(
    client,
    db
      .updateTable("toolCallTasks")
      .set({
        finalResultPayload: jsonbValue(
          payload
        ) as unknown as ToolCallTasksFinalResultPayload,
      })
      .where("id", "=", taskId)
  )
  if (result.rowCount !== 1) {
    throw new Error(
      `Expected to update task ${taskId} resolution payload, but affected ${result.rowCount ?? 0} rows`
    )
  }
}

/**
 * Upsert the remote_agent_conversation_contexts row for a plan-approval
 * request mint (created within the caller's tx so it commits atomically with
 * the parent task + feed item). Returns the matched remote_agent_id (null if
 * the requester participant is not a remote_agent). Raw SQL preserves the
 * `$2::jsonb` cast and the ON CONFLICT (remote_agent_id, conversation_id) upsert.
 */
export async function upsertRemoteAgentConversationContextForPlan(
  client: Executor,
  params: {
    conversationId: string
    collaborationState: Record<string, unknown> | undefined
    taskId: string
    requesterParticipantId: string
  }
): Promise<string | null> {
  const contextUpsert = await runOn<{ remoteAgentId: string }>(
    client,
    `
        INSERT INTO remote_agent_conversation_contexts (
          remote_agent_id,
          conversation_id,
          collaboration_mode,
          collaboration_state,
          active_plan_approval_task_id
        )
        SELECT
          cpsubj.remote_agent_id,
          $1,
          'plan_awaiting_approval',
          $2::jsonb,
          $3
        FROM conversation_participants cp
        INNER JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
        WHERE cp.id = $4
          AND cpsubj.remote_agent_id IS NOT NULL
        ON CONFLICT (remote_agent_id, conversation_id)
        DO UPDATE SET
          collaboration_mode = EXCLUDED.collaboration_mode,
          collaboration_state = EXCLUDED.collaboration_state,
          active_plan_approval_task_id = EXCLUDED.active_plan_approval_task_id
        RETURNING remote_agent_id
      `,
    [
      params.conversationId,
      JSON.stringify(params.collaborationState || {}),
      params.taskId,
      params.requesterParticipantId,
    ]
  )
  return contextUpsert.rows[0]?.remoteAgentId ?? null
}

/**
 * Find the id of an open (non-terminal, unexpired) runtime_authorization task
 * matching the dedupe key. Returns the task id or null. The dedupeKey is built
 * by the caller (buildRuntimeAuthorizationDedupeKey). Preserves the
 * lifecycle-status `in [...]` guard, the expiry OR-predicate, and the
 * raw-sql snake_case equality fragments.
 */
export async function findOpenRuntimeAuthorizationTaskId(params: {
  workspaceId: string
  conversationId: string
  requesterParticipantId: string
  runtimeId: string
  runtimeCapabilityId: string
  runtimeExposureId: string
  requestedToolName: string
  runtimeToolStableKey: string
  requestMode: RuntimeAuthorizationRequestMode
  dedupeKey: string
}): Promise<string | null> {
  const row = await db
    .selectFrom("toolCallTasks as ir")
    .innerJoin(
      "toolCallTaskRuntimeAuthorization as auth",
      "auth.taskId",
      "ir.id"
    )
    .select("ir.id")
    .where("ir.workspaceId", "=", params.workspaceId)
    .where("ir.conversationId", "=", params.conversationId)
    .where(
      sql<boolean>`ir.requester_participant_id = ${params.requesterParticipantId}`
    )
    .where("ir.executorKind", "=", "runtime_authorization")
    .where("ir.lifecycleStatus", "in", [
      "submitted",
      "working",
      "input_required",
      "auth_required",
    ])
    .where((eb) =>
      eb.or([
        eb("ir.expiresAt", "is", null),
        eb("ir.expiresAt", ">", new Date()),
      ])
    )
    .where("auth.runtimeId", "=", params.runtimeId)
    .where("auth.runtimeCapabilityId", "=", params.runtimeCapabilityId)
    .where("auth.runtimeExposureId", "=", params.runtimeExposureId)
    .where("auth.requestedToolName", "=", params.requestedToolName)
    .where(
      sql<boolean>`auth.runtime_tool_stable_key = ${params.runtimeToolStableKey}`
    )
    .where("auth.requestMode", "=", params.requestMode)
    .where("auth.dedupeKey", "=", params.dedupeKey)
    .orderBy("ir.updatedAt", "desc")
    .limit(1)
    .executeTakeFirst()
  return row?.id ?? null
}

/**
 * Can-view predicate (SELECT EXISTS over participant/membership joins).
 * Returns whether a task is viewable by the given user. Raw-sql EXISTS
 * fragments (snake_case identifiers, the active-participant guard, the
 * remote-agent group-visibility branch) are preserved verbatim.
 */
export async function taskViewableByUser(params: {
  taskId: string
  userId: string
}): Promise<boolean> {
  const row = await db
    .selectFrom("toolCallTasks as ir")
    .select("ir.id")
    .where("ir.id", "=", params.taskId)
    .where((eb) =>
      eb.or([
        sql<boolean>`EXISTS (
          SELECT 1
          FROM conversation_participants cp
          JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
          JOIN workspace_members wm
            ON wm.id = cpsubj.workspace_member_id
          WHERE cp.id = ir.requester_participant_id
            AND wm.user_id = ${params.userId}
        )`,
        eb.and([
          eb("ir.executorKind", "in", [
            "user_input",
            "plan_approval",
          ] satisfies ToolCallTaskExecutorKind[]),
          eb.or([
            sql<boolean>`EXISTS (
              SELECT 1
              FROM conversation_participants cp
              JOIN access_subjects cpsubj ON cpsubj.id = cp.subject_id
              JOIN workspace_members wm
                ON wm.id = cpsubj.workspace_member_id
              WHERE cp.id = ir.target_participant_id
                AND wm.user_id = ${params.userId}
            )`,
            sql<boolean>`EXISTS (
              SELECT 1
              FROM conversation_participants requester_cp
              JOIN access_subjects requester_subj ON requester_subj.id = requester_cp.subject_id
              JOIN conversation_participants viewer_cp
                ON viewer_cp.conversation_id = requester_cp.conversation_id
               AND viewer_cp.state = 'active'
              JOIN access_subjects viewer_subj ON viewer_subj.id = viewer_cp.subject_id
              JOIN workspace_members viewer_wm
                ON viewer_wm.id = viewer_subj.workspace_member_id
              WHERE requester_cp.id = ir.requester_participant_id
                AND requester_subj.remote_agent_id IS NOT NULL
                AND ir.remote_agent_run_id IS NOT NULL
                AND viewer_wm.user_id = ${params.userId}
            )`,
          ]),
        ]),
        eb.and([
          eb("ir.executorKind", "=", "runtime_authorization"),
          sql<boolean>`EXISTS (
            SELECT 1
            FROM conversation_participants cm
            JOIN access_subjects cm_subj ON cm_subj.id = cm.subject_id
            JOIN workspace_members wm
              ON wm.id = cm_subj.workspace_member_id
            WHERE cm.conversation_id = ir.conversation_id
              AND wm.user_id = ${params.userId}
              AND cm.state = 'active'
          )`,
        ]),
      ])
    )
    .limit(1)
    .executeTakeFirst()
  return Boolean(row)
}

/**
 * Is the given target participant an active conversation participant owned by
 * the user? (can-resolve target check.)
 */
export async function isActiveTargetParticipantForUser(params: {
  targetParticipantId: string
  userId: string
}): Promise<boolean> {
  const viewerParticipant = await db
    .selectFrom("conversationParticipants as cp")
    .innerJoin("accessSubjects as subj", "subj.id", "cp.subjectId")
    .innerJoin("workspaceMembers as wm", "wm.id", "subj.workspaceMemberId")
    .select("cp.id")
    .where("cp.id", "=", params.targetParticipantId)
    .where("cp.state", "=", "active")
    .where("wm.userId", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  return Boolean(viewerParticipant?.id)
}

/**
 * Look up the viewer's active membership in a conversation (workspace member
 * id + conversation kind) for the remote-agent group-resolve check.
 */
export async function findViewerConversationMembership(params: {
  conversationId: string
  userId: string
}): Promise<{
  workspaceMemberId: string | null
  conversationKind: string
} | null> {
  const viewerMembership = await db
    .selectFrom("conversationParticipants as cp")
    .innerJoin("accessSubjects as subj", "subj.id", "cp.subjectId")
    .innerJoin("workspaceMembers as wm", "wm.id", "subj.workspaceMemberId")
    .innerJoin("conversations as c", "c.id", "cp.conversationId")
    .select([
      "subj.workspaceMemberId as workspaceMemberId",
      "c.kind as conversationKind",
    ])
    .where("cp.conversationId", "=", params.conversationId)
    .where("cp.state", "=", "active")
    .where("wm.userId", "=", params.userId)
    .limit(1)
    .executeTakeFirst()
  return viewerMembership ?? null
}

/**
 * Does a remote_agent_group_task_grants row exist for (remoteAgentId,
 * workspaceMemberId)? Runs on the optional executor (the resolveTaskRequest
 * tx threads its `client`; the can-resolve read uses the singleton).
 */
export async function findRemoteAgentGroupTaskGrant(
  params: { remoteAgentId: string; workspaceMemberId: string },
  queryable?: Executor
): Promise<boolean> {
  const grant = await runBuilder(
    queryable ?? db,
    db
      .selectFrom("remoteAgentGroupTaskGrants")
      .select("workspaceMemberId")
      .where("remoteAgentId", "=", params.remoteAgentId)
      .where("workspaceMemberId", "=", params.workspaceMemberId)
      .limit(1)
  )
  return Boolean(grant.rows[0]?.workspaceMemberId)
}

/**
 * Read a conversation's kind on the caller's executor (used inside the
 * resolveTaskRequest transaction). Returns null when the conversation is
 * missing.
 */
export async function findConversationKindOn(
  client: Executor,
  conversationId: string
): Promise<{ kind: string } | null> {
  const row = await client
    .selectFrom("conversations")
    .select("kind")
    .where("id", "=", conversationId)
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

/**
 * Reset the remote_agent_conversation_contexts collaboration fields after a
 * plan-approval resolve (within the resolve tx). `approved` chooses the next
 * collaboration mode. Preserves the `{}::jsonb` reset of collaboration_state.
 */
export async function clearRemoteAgentConversationContextOnResolve(
  client: Executor,
  params: {
    remoteAgentId: string
    conversationId: string
    approved: boolean
  }
): Promise<void> {
  await client
    .updateTable("remoteAgentConversationContexts")
    .set({
      collaborationMode: params.approved ? "default" : "plan_drafting",
      collaborationState: jsonbValue({}),
      activePlanApprovalTaskId: null,
    })
    .where("remoteAgentId", "=", params.remoteAgentId)
    .where("conversationId", "=", params.conversationId)
    .execute()
}

/**
 * Load the session + conversation row referenced by a plan-approval task
 * (within the resolve tx). Returns the collaboration fields + conversation
 * kind, or null when the session is missing.
 */
export async function findSessionPlanRowOn(
  client: Executor,
  sessionId: string
): Promise<{
  collaborationState: Record<string, unknown>
  collaborationMode: string | null
  activePlanApprovalTaskId: string | null
  conversationKind: string
} | null> {
  const row = await client
    .selectFrom("sessions as s")
    .innerJoin("conversations as c", "c.id", "s.conversationId")
    .select([
      "s.collaborationState",
      "s.collaborationMode",
      "s.activePlanApprovalTaskId",
      "c.kind as conversationKind",
    ])
    .where("s.id", "=", sessionId)
    .limit(1)
    .executeTakeFirst()
  return row
    ? {
        collaborationState:
          row.collaborationState == null
            ? {}
            : requireJsonObject(
                row.collaborationState,
                `Session ${sessionId} collaboration_state`
              ),
        collaborationMode: row.collaborationMode,
        activePlanApprovalTaskId: row.activePlanApprovalTaskId,
        conversationKind: row.conversationKind,
      }
    : null
}

/**
 * Default-bound (Kysely-form, singleton-db) wrapper for the post-commit
 * runtime principal-context rebuild. The pg transaction is already closed by
 * the time the auto-retry path runs, so this builds on the singleton `db`.
 * Lives in the repo so service.ts never threads the db client itself.
 */
export async function buildRuntimePrincipalContextDefault(params: {
  principal: import("@synapse/shared").SubjectRef
  workspaceId: string
  conversationId: string | null
}) {
  const { buildRuntimePrincipalContext } =
    await import("../access/subject-resolution.js")
  return buildRuntimePrincipalContext(db, params)
}
