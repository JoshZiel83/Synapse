import path from "node:path"
import type {
  RuntimeAuthorizationGrantSpec,
  RuntimeAuthorizationPreset,
  RuntimeAuthorizationGrantRetention,
  RuntimeAuthorizationGrantScope,
  RuntimeAuthorizationGrantStatus,
  RuntimeAuthorizationRequestedAction,
} from "@synapse/shared/types"
import { sql } from "kysely"
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type QueryExecutor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js"
import { SUBJECT_KIND, type SubjectRef } from "@synapse/shared"
import { GrantPolicySchema } from "@synapse/shared/access/policies"
import {
  upsertAccessSubject,
  upsertAccessSubjectOn,
} from "../access/subject-registry.js"

/**
 * P1b: derive the SubjectRef for a relay authorization grant from the
 * (scope, actorId, conversationId, workspaceId) tuple. Returns null for
 * `once` scope (single-use grants don't bind a subject) and workspaces with
 * no actor/conversation context.
 */
function buildRelayGrantSubjectRef(input: {
  scope: RuntimeAuthorizationGrantScope
  workspaceId: string
  actorId?: string | null
  conversationId?: string | null
}): SubjectRef | null {
  switch (input.scope) {
    case "once":
      return null
    case "workspace":
      return { kind: SUBJECT_KIND.WORKSPACE, workspaceId: input.workspaceId }
    case "actor":
      if (!input.actorId) {
        throw new Error("actorId required for actor-scope relay grant")
      }
      return { kind: SUBJECT_KIND.ACTOR, actorId: input.actorId }
    case "conversation":
      if (!input.conversationId) {
        throw new Error(
          "conversationId required for conversation-scope relay grant"
        )
      }
      return {
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: input.conversationId,
      }
    case "actor_in_conversation":
      // v3 scope added in PR #1 of the device-runtime refactor; the legacy
      // relay code path does not emit this scope. The device-side runtime-
      // authorizations module (PR #15 rename) handles it via
      // ensureConversationActorContext + SUBJECT_KIND.CONVERSATION_ACTOR_CONTEXT.
      throw new Error(
        "actor_in_conversation scope is not supported by the legacy relay-authorizations module; use the device path"
      )
  }
}

type Queryable = QueryExecutor

function isQueryExecutor(value: unknown): value is QueryExecutor {
  return typeof value === "object" && value !== null && "query" in value
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {}
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) {
    return undefined
  }
  return value instanceof Date ? value.toISOString() : value
}

function runtimeAuthorizationScopeRank(scope: RuntimeAuthorizationGrantScope) {
  switch (scope) {
    case "once":
      return 0
    case "actor":
      return 1
    case "actor_in_conversation":
      // Narrower than `conversation` (one actor only) but more specific than
      // `actor` (only inside this conversation). Rank between actor and
      // conversation so policy resolution prefers it over `actor` when
      // available.
      return 2
    case "conversation":
      return 3
    case "workspace":
      return 4
    default:
      return 99
  }
}

function normalizePathPrefix(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null
  }
  return path.resolve(path.normalize(value.trim()))
}

function normalizePathPrefixes(values: unknown) {
  if (!Array.isArray(values)) {
    return [] as string[]
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizePathPrefix(value))
        .filter((value): value is string => Boolean(value))
    )
  ).sort()
}

function pathSeparatorForMatch(value: string) {
  return value.endsWith(path.sep) ? "" : path.sep
}

function pathWithinPrefix(target: string, prefix: string) {
  return (
    target === prefix ||
    target.startsWith(`${prefix}${pathSeparatorForMatch(prefix)}`)
  )
}

function normalizeCommandText(value: unknown) {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function hasCompoundShellOperators(command: string) {
  return (
    command.includes("&&") ||
    command.includes("||") ||
    command.includes(";") ||
    command.includes("|") ||
    command.includes("\n")
  )
}

function commandPrefixMatches(prefix: string, command: string) {
  return command === prefix || command.startsWith(`${prefix} `)
}

export interface RuntimeAuthorizationGrantRecord extends RuntimeAuthorizationGrantSpec {
  id: string
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  /**
   * Raw access_subjects.id this grant binds to. NULL only for `once` and
   * `workspace` scopes; non-null for actor / conversation /
   * actor_in_conversation / remote_agent. Callers MUST use this (not the
   * derived actor/conversation ids) to verify the grant applies to the
   * caller's principal — without it, grant selection cross-contaminates
   * between actors that share a capability.
   */
  subjectId: string | null
  conversationId?: string
  actorId?: string
  createdByWorkspaceMemberId?: string
  sourceInteractionId?: string
  sourceTaskId?: string
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs: Record<string, unknown>
  scope: RuntimeAuthorizationGrantScope
  retention: RuntimeAuthorizationGrantRetention
  status: RuntimeAuthorizationGrantStatus
  createdAt: string
  updatedAt: string
  consumedAt?: string
  revokedAt?: string
  supersededAt?: string
}

export interface CreateRuntimeAuthorizationGrantParams {
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  conversationId?: string
  actorId?: string
  createdByWorkspaceMemberId?: string
  sourceInteractionId?: string
  sourceTaskId?: string
  preset: RuntimeAuthorizationPreset
  grantSpec: RuntimeAuthorizationGrantSpec
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs?: Record<string, unknown>
}

export interface FindMatchingRuntimeAuthorizationGrantParams {
  workspaceId: string
  deviceId: string
  deviceCapabilityId: string
  deviceExposureId: string
  conversationId?: string
  actorId?: string
  retryNonce?: string
  requestedAction: RuntimeAuthorizationRequestedAction
  consumeOnce?: boolean
}

function normalizeGrantSpecForInsert(
  grantSpec: RuntimeAuthorizationGrantSpec
): RuntimeAuthorizationGrantSpec {
  return {
    capability: grantSpec.capability,
    filesystem: grantSpec.filesystem
      ? {
          access: grantSpec.filesystem.access,
          pathPrefixes: normalizePathPrefixes(
            grantSpec.filesystem.pathPrefixes
          ),
        }
      : undefined,
    cua: grantSpec.cua
      ? {
          access: grantSpec.cua.access,
        }
      : undefined,
    browser: grantSpec.browser
      ? {
          action: grantSpec.browser.action,
          scopeType: grantSpec.browser.scopeType,
          origin:
            typeof grantSpec.browser.origin === "string" &&
            grantSpec.browser.origin.trim()
              ? grantSpec.browser.origin.trim()
              : undefined,
          host:
            typeof grantSpec.browser.host === "string" &&
            grantSpec.browser.host.trim()
              ? grantSpec.browser.host.trim().toLowerCase()
              : undefined,
          registrableDomain:
            typeof grantSpec.browser.registrableDomain === "string" &&
            grantSpec.browser.registrableDomain.trim()
              ? grantSpec.browser.registrableDomain.trim().toLowerCase()
              : undefined,
        }
      : undefined,
    commandline: grantSpec.commandline
      ? {
          executor: grantSpec.commandline.executor,
          commandMatchType: grantSpec.commandline.commandMatchType,
          commandText:
            normalizeCommandText(grantSpec.commandline.commandText) ||
            undefined,
          workingDirectory:
            normalizePathPrefix(grantSpec.commandline.workingDirectory) ||
            undefined,
        }
      : undefined,
  }
}

function parseGrantSpec(value: unknown): RuntimeAuthorizationGrantSpec {
  // Validate the JSON we read out of the DB against the Zod schema before
  // handing it back up. This guarantees the wire shape we emit matches what
  // the Go relay expects, even if older rows pre-date the current schema.
  const policy = GrantPolicySchema.parse(
    parseJsonObject(value)
  ) as RuntimeAuthorizationGrantSpec
  return normalizeGrantSpecForInsert(policy)
}

function mapRuntimeAuthorizationGrantRow(
  row: any
): RuntimeAuthorizationGrantRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    deviceId: row.device_id,
    deviceCapabilityId: row.device_capability_id,
    deviceExposureId: row.device_exposure_id,
    // P1b: actor_id and conversation_id are no longer stored on the grant
    // row; they live on the joined access_subjects row. SELECT helpers below
    // project subj.actor_id AS subject_actor_id and subj.conversation_id AS
    // subject_conversation_id so this mapper can pick them up. (For `once` /
    // `workspace` scopes subject_id is NULL, so these are also undefined.)
    subjectId: row.subject_id || null,
    conversationId: row.subject_conversation_id || undefined,
    actorId: row.subject_actor_id || undefined,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    sourceInteractionId: row.source_interaction_id || undefined,
    sourceTaskId: row.source_task_id || undefined,
    sourceRetryNonce: row.source_retry_nonce || undefined,
    sourceRuntimeSessionId: row.source_runtime_session_id || undefined,
    sourceRequestArgs: parseJsonObject(row.source_request_args),
    scope: row.scope,
    retention: row.retention,
    status: row.status,
    ...parseGrantSpec(row.policy),
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date().toISOString(),
    consumedAt: toIsoString(row.consumed_at),
    revokedAt: toIsoString(row.revoked_at),
    supersededAt: toIsoString(row.superseded_at),
  }
}

/**
 * P1b: the canonical SELECT projection for runtime_authorization_grants rows
 * that will be passed to mapRuntimeAuthorizationGrantRow. LEFT JOINs
 * access_subjects (subject_id is nullable for `once` / `workspace` scopes)
 * and surfaces subject_actor_id / subject_conversation_id derived from the
 * subject row, so the mapper doesn't have to know about the join.
 */
function relayGrantSelectColumns() {
  return [
    "g.id",
    "g.workspace_id",
    "g.device_id",
    "g.device_capability_id",
    "g.device_exposure_id",
    "g.subject_id",
    "g.created_by_workspace_member_id",
    "g.source_interaction_id",
    "g.source_task_id",
    "g.scope",
    "g.retention",
    "g.status",
    "g.policy",
    "g.source_retry_nonce",
    "g.source_runtime_session_id",
    "g.source_request_args",
    "g.consumed_at",
    "g.revoked_at",
    "g.superseded_at",
    "g.created_at",
    "g.updated_at",
    "subj.actor_id as subject_actor_id",
    "subj.conversation_id as subject_conversation_id",
    "subj.kind as subject_kind",
  ] as const
}

export function runtimeAuthorizationPresetToGrant(
  preset: RuntimeAuthorizationPreset
): {
  scope: RuntimeAuthorizationGrantScope
  retention: RuntimeAuthorizationGrantRetention
} {
  switch (preset) {
    case "once":
      return { scope: "once", retention: "consume_once" }
    case "actor":
      return { scope: "actor", retention: "until_revoked" }
    case "conversation":
      return { scope: "conversation", retention: "until_revoked" }
    case "workspace":
      return { scope: "workspace", retention: "until_revoked" }
    default:
      return { scope: "once", retention: "consume_once" }
  }
}

export async function createRuntimeAuthorizationGrant(
  params: CreateRuntimeAuthorizationGrantParams,
  queryable?: Queryable
) {
  const { scope, retention } = runtimeAuthorizationPresetToGrant(params.preset)
  // Zod-parse on the write side as well — any caller that hand-builds a
  // grantSpec gets the same shape validation as the read path.
  const grantSpec = normalizeGrantSpecForInsert(
    GrantPolicySchema.parse(params.grantSpec) as RuntimeAuthorizationGrantSpec
  )
  const subjectRef = buildRelayGrantSubjectRef({
    scope,
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
  })
  const subjectId = subjectRef
    ? isQueryExecutor(queryable)
      ? await upsertAccessSubjectOn(queryable, subjectRef)
      : await upsertAccessSubject(db, subjectRef)
    : null
  const insertStatement = db
    .insertInto("runtime_authorization_grants")
    .values({
      workspace_id: params.workspaceId,
      device_id: params.deviceId,
      device_capability_id: params.deviceCapabilityId,
      device_exposure_id: params.deviceExposureId,
      subject_id: subjectId,
      created_by_workspace_member_id: params.createdByWorkspaceMemberId || null,
      source_interaction_id: params.sourceInteractionId || null,
      source_task_id: params.sourceTaskId || null,
      scope,
      retention,
      status: "active",
      policy:
        grantSpec as unknown as TableInsert<"runtime_authorization_grants">["policy"],
      source_retry_nonce: params.sourceRetryNonce || null,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_request_args: (params.sourceRequestArgs ||
        {}) as TableInsert<"runtime_authorization_grants">["source_request_args"],
    })
    .returning("id")

  const inserted = isQueryExecutor(queryable)
    ? await executeTakeFirst<{ id: string }>(queryable, insertStatement)
    : await insertStatement.executeTakeFirst()
  if (!inserted) {
    throw new Error("Failed to create relay authorization grant")
  }
  // Re-fetch with the access_subjects join so the mapper can populate
  // actorId / conversationId from the subject row (P1b: actor_id and
  // conversation_id were dropped from the grant table).
  const selectStatement = db
    .selectFrom("runtime_authorization_grants as g")
    .leftJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .select(relayGrantSelectColumns())
    .where("g.id", "=", inserted.id)
    .limit(1)
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, selectStatement)
    : await selectStatement.executeTakeFirst()
  if (!row) {
    throw new Error("Failed to re-fetch inserted relay authorization grant")
  }
  return mapRuntimeAuthorizationGrantRow(row)
}

export async function getRuntimeAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .selectFrom("runtime_authorization_grants as g")
    .leftJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .select(relayGrantSelectColumns())
    .where("g.id", "=", id)
    .limit(1)
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst()
  return row ? mapRuntimeAuthorizationGrantRow(row) : null
}

export async function revokeRuntimeAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .updateTable("runtime_authorization_grants")
    .set({
      status: "revoked",
      revoked_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
  if (isQueryExecutor(queryable)) {
    await executeCompiledQuery(queryable, statement)
    return
  }
  await statement.execute()
}

export async function supersedeRuntimeAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .updateTable("runtime_authorization_grants")
    .set({
      status: "superseded",
      superseded_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
  if (isQueryExecutor(queryable)) {
    await executeCompiledQuery(queryable, statement)
    return
  }
  await statement.execute()
}

export async function consumeRuntimeAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .updateTable("runtime_authorization_grants")
    .set({
      status: "consumed",
      consumed_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
  if (isQueryExecutor(queryable)) {
    await executeCompiledQuery(queryable, statement)
    return
  }
  await statement.execute()
}

export function filesystemPolicyMatches(
  grant: RuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction
) {
  const granted = grant.filesystem
  const requested = action.filesystem
  if (!granted || !requested || granted.access !== requested.access) {
    return false
  }
  if (
    granted.pathPrefixes.length === 0 ||
    requested.pathPrefixes.length === 0
  ) {
    return false
  }
  return requested.pathPrefixes.every((requestedPrefix) =>
    granted.pathPrefixes.some((grantedPrefix) =>
      pathWithinPrefix(requestedPrefix, grantedPrefix)
    )
  )
}

export function browserPolicyMatches(
  grant: RuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction
) {
  const granted = grant.browser
  const requested = action.browser
  if (!granted || !requested || granted.action !== requested.action) {
    return false
  }
  switch (granted.scopeType) {
    case "origin":
      return Boolean(
        granted.origin &&
        requested.origin &&
        granted.origin === requested.origin
      )
    case "host":
      return Boolean(
        granted.host && requested.host && granted.host === requested.host
      )
    case "domain":
      return Boolean(
        granted.registrableDomain &&
        requested.registrableDomain &&
        granted.registrableDomain === requested.registrableDomain
      )
    default:
      // P4: previously `return true` — that silently granted access for any
      // unknown scopeType, which is unsafe. Match Go behavior: deny.
      return false
  }
}

export function commandlinePolicyMatches(
  grant: RuntimeAuthorizationGrantSpec,
  action: RuntimeAuthorizationRequestedAction
) {
  const granted = grant.commandline
  const requested = action.commandline
  if (!granted || !requested) {
    return false
  }
  if (granted.executor !== requested.executor) {
    return false
  }
  if (granted.workingDirectory) {
    const requestedWorkingDirectory = normalizePathPrefix(
      requested.workingDirectory
    )
    if (!requestedWorkingDirectory) {
      return false
    }
    if (
      !pathWithinPrefix(requestedWorkingDirectory, granted.workingDirectory)
    ) {
      return false
    }
  }
  const grantedText = normalizeCommandText(granted.commandText)
  const requestedText = normalizeCommandText(requested.commandText)
  if (!requestedText) {
    return false
  }
  switch (granted.commandMatchType) {
    case "exact":
      return Boolean(grantedText && grantedText === requestedText)
    case "prefix":
      if (!grantedText || hasCompoundShellOperators(requestedText)) {
        return false
      }
      return commandPrefixMatches(grantedText, requestedText)
    case "tool":
      return true
    default:
      return false
  }
}

export function runtimeAuthorizationGrantMatches(
  grant: RuntimeAuthorizationGrantRecord,
  requestedAction: RuntimeAuthorizationRequestedAction
) {
  if (grant.capability !== requestedAction.capability) {
    return false
  }
  switch (grant.capability) {
    case "filesystem":
      return filesystemPolicyMatches(grant, requestedAction)
    case "cua":
      return Boolean(
        grant.cua &&
        requestedAction.cua &&
        grant.cua.access === requestedAction.cua.access
      )
    case "browser":
      return browserPolicyMatches(grant, requestedAction)
    case "commandline":
      return commandlinePolicyMatches(grant, requestedAction)
    default:
      return false
  }
}

export async function findMatchingRuntimeAuthorizationGrant(
  params: FindMatchingRuntimeAuthorizationGrantParams,
  queryable?: Queryable
) {
  // P1b: subject upserts must run on the same connection as the surrounding
  // transaction (when one was passed via `queryable`) — otherwise the upsert
  // commits independently and the subsequent SELECT inside the trx sees a
  // subject_id that hasn't been visible if the trx is later rolled back.
  const upsertSubject = async (ref: SubjectRef) =>
    isQueryExecutor(queryable)
      ? upsertAccessSubjectOn(queryable, ref)
      : upsertAccessSubject(db, ref)

  const conversationSubjectId = params.conversationId
    ? await upsertSubject({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
    : null
  const actorSubjectId = params.actorId
    ? await upsertSubject({ kind: SUBJECT_KIND.ACTOR, actorId: params.actorId })
    : null

  const statement = db
    .selectFrom("runtime_authorization_grants as g")
    .leftJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .select(relayGrantSelectColumns())
    .where("g.workspace_id", "=", params.workspaceId)
    .where("g.device_id", "=", params.deviceId)
    .where("g.device_capability_id", "=", params.deviceCapabilityId)
    .where("g.device_exposure_id", "=", params.deviceExposureId)
    .where("g.status", "=", "active")
    .where((eb) =>
      eb.or([
        eb("g.scope", "=", "workspace"),
        ...(conversationSubjectId
          ? [
              eb.and([
                eb("g.scope", "=", "conversation"),
                eb("g.subject_id", "=", conversationSubjectId),
              ]),
            ]
          : []),
        ...(actorSubjectId
          ? [
              eb.and([
                eb("g.scope", "=", "actor"),
                eb("g.subject_id", "=", actorSubjectId),
              ]),
            ]
          : []),
        ...(params.retryNonce
          ? [
              eb.and([
                eb("g.scope", "=", "once"),
                eb("g.source_retry_nonce", "=", params.retryNonce),
              ]),
            ]
          : []),
      ])
    )

  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute()
  const candidates = rows
    .map((row) => mapRuntimeAuthorizationGrantRow(row))
    .sort((left, right) => {
      const byScope =
        runtimeAuthorizationScopeRank(left.scope) -
        runtimeAuthorizationScopeRank(right.scope)
      if (byScope !== 0) {
        return byScope
      }
      return right.createdAt.localeCompare(left.createdAt)
    })

  const matchedGrant =
    candidates.find((candidate) =>
      runtimeAuthorizationGrantMatches(candidate, params.requestedAction)
    ) || null

  if (matchedGrant && params.consumeOnce && matchedGrant.scope === "once") {
    await consumeRuntimeAuthorizationGrant(matchedGrant.id, queryable)
    matchedGrant.status = "consumed"
    matchedGrant.consumedAt = new Date().toISOString()
  }

  return {
    matchedGrant,
  }
}

export async function listActiveRuntimeAuthorizationGrantsForExposure(
  deviceCapabilityId: string,
  queryable?: Queryable
) {
  const statement = db
    .selectFrom("runtime_authorization_grants as g")
    .leftJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .select(relayGrantSelectColumns())
    .where("g.device_capability_id", "=", deviceCapabilityId)
    .where("g.status", "=", "active")
    .orderBy("g.created_at", "desc")
  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute()
  return rows.map((row) => mapRuntimeAuthorizationGrantRow(row))
}
