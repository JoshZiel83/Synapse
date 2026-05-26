import path from "node:path"
import type {
  RelayAuthorizationGrantSpec,
  RelayAuthorizationPreset,
  RelayAuthorizationGrantRetention,
  RelayAuthorizationGrantStatus,
  RelayAuthorizationRequestedAction,
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
 * D1 (subject-scope refactor, final): every grant now has a non-null
 * `subject_id` (the principal/group authorized) and an optional
 * `scope_subject_id` (the runtime context the grant is restricted to). The
 * legacy `scope` enum is gone — preset selection translates to
 * (subject, scope?, retention) here.
 *
 * Preset → grant shape:
 *   - `once`              subject = originating principal (actor if known, else workspace),
 *                         scope?  = conversation if known,
 *                         retention = consume_once
 *   - `actor`             subject = actor (required),
 *                         scope?  = conversation if known,
 *                         retention = until_revoked
 *   - `conversation`      subject = conversation (required),
 *                         scope?  = undefined,
 *                         retention = until_revoked
 *   - `workspace`         subject = workspace,
 *                         scope?  = undefined,
 *                         retention = until_revoked
 */
function buildRelayGrantSubjectAndScope(input: {
  preset: RelayAuthorizationPreset
  workspaceId: string
  actorId?: string | null
  conversationId?: string | null
}): {
  subject: SubjectRef
  scope?: SubjectRef
  retention: RelayAuthorizationGrantRetention
} {
  switch (input.preset) {
    case "once": {
      const subject: SubjectRef = input.actorId
        ? { kind: SUBJECT_KIND.ACTOR, actorId: input.actorId }
        : { kind: SUBJECT_KIND.WORKSPACE, workspaceId: input.workspaceId }
      const scope: SubjectRef | undefined = input.conversationId
        ? {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: input.conversationId,
          }
        : undefined
      return { subject, scope, retention: "consume_once" }
    }
    case "actor": {
      if (!input.actorId) {
        throw new Error("actorId required for actor-preset relay grant")
      }
      const scope: SubjectRef | undefined = input.conversationId
        ? {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: input.conversationId,
          }
        : undefined
      return {
        subject: { kind: SUBJECT_KIND.ACTOR, actorId: input.actorId },
        scope,
        retention: "until_revoked",
      }
    }
    case "conversation":
      if (!input.conversationId) {
        throw new Error(
          "conversationId required for conversation-preset relay grant"
        )
      }
      return {
        subject: {
          kind: SUBJECT_KIND.CONVERSATION,
          conversationId: input.conversationId,
        },
        retention: "until_revoked",
      }
    case "workspace":
      return {
        subject: {
          kind: SUBJECT_KIND.WORKSPACE,
          workspaceId: input.workspaceId,
        },
        retention: "until_revoked",
      }
    default:
      // Defensive default — treat unknown preset as `once` bound to workspace.
      return {
        subject: {
          kind: SUBJECT_KIND.WORKSPACE,
          workspaceId: input.workspaceId,
        },
        retention: "consume_once",
      }
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

/**
 * D1: rank candidate grants when multiple match the same request. More
 * specific bindings win, so callers consume the tightest grant first.
 *   - retention=consume_once outranks until_revoked (single-shot tickets
 *     should be burnt first; per plan they are also ordered ahead of broad
 *     long-lived grants)
 *   - scope_subject_id present outranks scope_subject_id NULL (grant
 *     restricted to a conversation outranks an unrestricted one)
 *   - subject precision: actor/remote_agent/workspace_member > conversation
 *     > workspace
 * Returns smaller numbers for higher-precedence rows.
 */
function relayGrantSpecificityRank(grant: {
  retention: RelayAuthorizationGrantRetention
  hasScopeSubject: boolean
  subjectKind: string | null
}) {
  let rank = 0
  if (grant.retention !== "consume_once") {
    rank += 100
  }
  if (!grant.hasScopeSubject) {
    rank += 20
  }
  switch (grant.subjectKind) {
    case SUBJECT_KIND.ACTOR:
    case SUBJECT_KIND.REMOTE_AGENT:
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      rank += 0
      break
    case SUBJECT_KIND.CONVERSATION:
      rank += 2
      break
    case SUBJECT_KIND.WORKSPACE:
      rank += 5
      break
    default:
      rank += 9
  }
  return rank
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

export interface RelayAuthorizationGrantRecord extends RelayAuthorizationGrantSpec {
  id: string
  workspaceId: string
  relayDeviceId: string
  relayCapabilityId: string
  relayExposureId: string
  conversationId?: string
  actorId?: string
  createdByWorkspaceMemberId?: string
  sourceInteractionId?: string
  sourceTaskId?: string
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs: Record<string, unknown>
  /**
   * D1: surface the SubjectRef + optional scope SubjectRef instead of the
   * legacy `scope` enum. Consumers that want to display "what's bound" should
   * read `subject` and `scope`; everyone else should rely on the matcher's
   * runtimeSubjectIds/runtimeScopeSubjectIds and the (`retention`) field.
   */
  subject: SubjectRef
  scope?: SubjectRef
  retention: RelayAuthorizationGrantRetention
  status: RelayAuthorizationGrantStatus
  createdAt: string
  updatedAt: string
  consumedAt?: string
  revokedAt?: string
  supersededAt?: string
}

export interface CreateRelayAuthorizationGrantParams {
  workspaceId: string
  relayDeviceId: string
  relayCapabilityId: string
  relayExposureId: string
  conversationId?: string
  actorId?: string
  createdByWorkspaceMemberId?: string
  sourceInteractionId?: string
  sourceTaskId?: string
  preset: RelayAuthorizationPreset
  grantSpec: RelayAuthorizationGrantSpec
  sourceRetryNonce?: string
  sourceRuntimeSessionId?: string
  sourceRequestArgs?: Record<string, unknown>
}

export interface FindMatchingRelayAuthorizationGrantParams {
  workspaceId: string
  relayDeviceId: string
  relayCapabilityId: string
  relayExposureId: string
  conversationId?: string
  actorId?: string
  /**
   * D1: subject_ids the principal can claim. If not provided, the matcher
   * derives a default set from (workspaceId, actorId, conversationId-if-active)
   * so existing tool-flow callers keep working without explicit runtime context.
   */
  runtimeSubjectIds?: string[]
  /**
   * D1: scope_subject_ids that represent the runtime context the principal is
   * currently inside (workspace + active conversation). Defaults derived from
   * the same params.
   */
  runtimeScopeSubjectIds?: string[]
  /**
   * D1: consume_once fail-closed key. Per plan, a once grant must have AT
   * LEAST one of `source_retry_nonce` / `source_task_id` matched against the
   * incoming dispatch; if neither is supplied, the matcher refuses to surface
   * any once candidate (the grant is "burnt" but unclaimable from the wrong
   * context).
   */
  retryNonce?: string
  sourceTaskId?: string
  requestedAction: RelayAuthorizationRequestedAction
  consumeOnce?: boolean
}

function normalizeGrantSpecForInsert(
  grantSpec: RelayAuthorizationGrantSpec
): RelayAuthorizationGrantSpec {
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

function parseGrantSpec(value: unknown): RelayAuthorizationGrantSpec {
  // Validate the JSON we read out of the DB against the Zod schema before
  // handing it back up. This guarantees the wire shape we emit matches what
  // the Go relay expects, even if older rows pre-date the current schema.
  const policy = GrantPolicySchema.parse(
    parseJsonObject(value)
  ) as RelayAuthorizationGrantSpec
  return normalizeGrantSpecForInsert(policy)
}

function decodeSubjectRefFromRow(input: {
  kind: string | null
  actor_id: string | null
  remote_agent_id: string | null
  conversation_id: string | null
  workspace_id: string | null
  workspace_member_id: string | null
  user_id: string | null
}): SubjectRef | null {
  if (!input.kind) {
    return null
  }
  switch (input.kind) {
    case SUBJECT_KIND.ACTOR:
      return input.actor_id
        ? { kind: SUBJECT_KIND.ACTOR, actorId: input.actor_id }
        : null
    case SUBJECT_KIND.REMOTE_AGENT:
      return input.remote_agent_id
        ? {
            kind: SUBJECT_KIND.REMOTE_AGENT,
            remoteAgentId: input.remote_agent_id,
          }
        : null
    case SUBJECT_KIND.CONVERSATION:
      return input.conversation_id
        ? {
            kind: SUBJECT_KIND.CONVERSATION,
            conversationId: input.conversation_id,
          }
        : null
    case SUBJECT_KIND.WORKSPACE:
      return input.workspace_id
        ? { kind: SUBJECT_KIND.WORKSPACE, workspaceId: input.workspace_id }
        : null
    case SUBJECT_KIND.WORKSPACE_MEMBER:
      return input.workspace_member_id
        ? {
            kind: SUBJECT_KIND.WORKSPACE_MEMBER,
            memberId: input.workspace_member_id,
          }
        : null
    case SUBJECT_KIND.USER:
      return input.user_id
        ? { kind: SUBJECT_KIND.USER, userId: input.user_id }
        : null
    default:
      return null
  }
}

function mapRelayAuthorizationGrantRow(
  row: any
): RelayAuthorizationGrantRecord {
  const subject = decodeSubjectRefFromRow({
    kind: row.subject_kind,
    actor_id: row.subject_actor_id,
    remote_agent_id: row.subject_remote_agent_id,
    conversation_id: row.subject_conversation_id,
    workspace_id: row.subject_workspace_id,
    workspace_member_id: row.subject_workspace_member_id,
    user_id: row.subject_user_id,
  })
  if (!subject) {
    throw new Error(
      `relay_authorization_grants row ${row.id} has invalid subject_id (kind=${row.subject_kind})`
    )
  }
  const scopeSubject = decodeSubjectRefFromRow({
    kind: row.scope_subject_kind,
    actor_id: null,
    remote_agent_id: null,
    conversation_id: row.scope_subject_conversation_id,
    workspace_id: row.scope_subject_workspace_id,
    workspace_member_id: null,
    user_id: null,
  })
  // Backwards-compatible derived fields for callers that haven't moved off
  // actorId / conversationId — populate from the subject (and scope subject)
  // SubjectRefs.
  const conversationIdFromSubject =
    subject.kind === SUBJECT_KIND.CONVERSATION
      ? subject.conversationId
      : scopeSubject?.kind === SUBJECT_KIND.CONVERSATION
        ? scopeSubject.conversationId
        : undefined
  const actorIdFromSubject =
    subject.kind === SUBJECT_KIND.ACTOR ? subject.actorId : undefined
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    relayDeviceId: row.relay_device_id,
    relayCapabilityId: row.relay_capability_id,
    relayExposureId: row.relay_exposure_id,
    conversationId: conversationIdFromSubject,
    actorId: actorIdFromSubject,
    createdByWorkspaceMemberId: row.created_by_workspace_member_id || undefined,
    sourceInteractionId: row.source_interaction_id || undefined,
    sourceTaskId: row.source_task_id || undefined,
    sourceRetryNonce: row.source_retry_nonce || undefined,
    sourceRuntimeSessionId: row.source_runtime_session_id || undefined,
    sourceRequestArgs: parseJsonObject(row.source_request_args),
    subject,
    scope: scopeSubject || undefined,
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
 * D1: canonical SELECT projection for relay_authorization_grants rows. JOINs
 * access_subjects twice — once for `subject_id` (always non-null post-D1) and
 * once for `scope_subject_id` (nullable). The mapper decodes both into
 * SubjectRef using the column-by-kind decoder above.
 */
function relayGrantSelectColumns() {
  return [
    "g.id",
    "g.workspace_id",
    "g.relay_device_id",
    "g.relay_capability_id",
    "g.relay_exposure_id",
    "g.subject_id",
    "g.scope_subject_id",
    "g.created_by_workspace_member_id",
    "g.source_interaction_id",
    "g.source_task_id",
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
    "subj.kind as subject_kind",
    "subj.actor_id as subject_actor_id",
    "subj.remote_agent_id as subject_remote_agent_id",
    "subj.conversation_id as subject_conversation_id",
    "subj.workspace_id as subject_workspace_id",
    "subj.workspace_member_id as subject_workspace_member_id",
    "subj.user_id as subject_user_id",
    "scope_subj.kind as scope_subject_kind",
    "scope_subj.conversation_id as scope_subject_conversation_id",
    "scope_subj.workspace_id as scope_subject_workspace_id",
  ] as const
}

function relayGrantSelectFrom() {
  return db
    .selectFrom("relay_authorization_grants as g")
    .innerJoin("access_subjects as subj", "subj.id", "g.subject_id")
    .leftJoin(
      "access_subjects as scope_subj",
      "scope_subj.id",
      "g.scope_subject_id"
    )
}

export function relayAuthorizationPresetToGrant(
  preset: RelayAuthorizationPreset
): {
  retention: RelayAuthorizationGrantRetention
} {
  switch (preset) {
    case "once":
      return { retention: "consume_once" }
    case "actor":
    case "conversation":
    case "workspace":
      return { retention: "until_revoked" }
    default:
      return { retention: "consume_once" }
  }
}

export async function createRelayAuthorizationGrant(
  params: CreateRelayAuthorizationGrantParams,
  queryable?: Queryable
) {
  const { subject, scope, retention } = buildRelayGrantSubjectAndScope({
    preset: params.preset,
    workspaceId: params.workspaceId,
    actorId: params.actorId,
    conversationId: params.conversationId,
  })
  // Zod-parse on the write side as well — any caller that hand-builds a
  // grantSpec gets the same shape validation as the read path.
  const grantSpec = normalizeGrantSpecForInsert(
    GrantPolicySchema.parse(params.grantSpec) as RelayAuthorizationGrantSpec
  )
  const upsert = async (ref: SubjectRef) =>
    isQueryExecutor(queryable)
      ? upsertAccessSubjectOn(queryable, ref)
      : upsertAccessSubject(db, ref)
  const subjectId = await upsert(subject)
  const scopeSubjectId = scope ? await upsert(scope) : null
  const insertStatement = db
    .insertInto("relay_authorization_grants")
    .values({
      workspace_id: params.workspaceId,
      relay_device_id: params.relayDeviceId,
      relay_capability_id: params.relayCapabilityId,
      relay_exposure_id: params.relayExposureId,
      subject_id: subjectId,
      scope_subject_id: scopeSubjectId,
      created_by_workspace_member_id: params.createdByWorkspaceMemberId || null,
      source_interaction_id: params.sourceInteractionId || null,
      source_task_id: params.sourceTaskId || null,
      retention,
      status: "active",
      policy:
        grantSpec as unknown as TableInsert<"relay_authorization_grants">["policy"],
      source_retry_nonce: params.sourceRetryNonce || null,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_request_args: (params.sourceRequestArgs ||
        {}) as TableInsert<"relay_authorization_grants">["source_request_args"],
    })
    .returning("id")

  const inserted = isQueryExecutor(queryable)
    ? await executeTakeFirst<{ id: string }>(queryable, insertStatement)
    : await insertStatement.executeTakeFirst()
  if (!inserted) {
    throw new Error("Failed to create relay authorization grant")
  }
  const selectStatement = relayGrantSelectFrom()
    .select(relayGrantSelectColumns())
    .where("g.id", "=", inserted.id)
    .limit(1)
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, selectStatement)
    : await selectStatement.executeTakeFirst()
  if (!row) {
    throw new Error("Failed to re-fetch inserted relay authorization grant")
  }
  return mapRelayAuthorizationGrantRow(row)
}

export async function getRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = relayGrantSelectFrom()
    .select(relayGrantSelectColumns())
    .where("g.id", "=", id)
    .limit(1)
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst()
  return row ? mapRelayAuthorizationGrantRow(row) : null
}

export async function revokeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .updateTable("relay_authorization_grants")
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

export async function supersedeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .updateTable("relay_authorization_grants")
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

/**
 * PR4 (subject-scope refactor): atomic consume of a once-only grant.
 * Returns true if the UPDATE actually flipped status from 'active' →
 * 'consumed'; false if the row was already consumed/revoked (lost the
 * race to another consumer). Callers MUST check the return value when
 * they care about strict once-only semantics — `findMatchingRelayAuthorizationGrant`
 * uses this as the signal for its bounded-retry loop so concurrent matches
 * for the same once grant degrade to "next candidate" instead of double-spend.
 */
export async function consumeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable
): Promise<boolean> {
  const statement = db
    .updateTable("relay_authorization_grants")
    .set({
      status: "consumed",
      consumed_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active")
    .returning("id")
  let rows: { id: string }[]
  if (isQueryExecutor(queryable)) {
    rows = (await executeCompiledQuery<{ id: string }>(queryable, statement))
      .rows
  } else {
    rows = await statement.execute()
  }
  return rows.length > 0
}

export function filesystemPolicyMatches(
  grant: RelayAuthorizationGrantSpec,
  action: RelayAuthorizationRequestedAction
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
  grant: RelayAuthorizationGrantSpec,
  action: RelayAuthorizationRequestedAction
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
  grant: RelayAuthorizationGrantSpec,
  action: RelayAuthorizationRequestedAction
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

export function relayAuthorizationGrantMatches(
  grant: RelayAuthorizationGrantRecord,
  requestedAction: RelayAuthorizationRequestedAction
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

export async function findMatchingRelayAuthorizationGrant(
  params: FindMatchingRelayAuthorizationGrantParams,
  queryable?: Queryable
) {
  // D1: derive runtimeSubjectIds / runtimeScopeSubjectIds from the legacy
  // (actorId, conversationId, workspaceId) tuple when the caller didn't pass
  // an explicit set. Subject upserts run on the surrounding txn so the join
  // sees the same writes.
  const upsert = async (ref: SubjectRef) =>
    isQueryExecutor(queryable)
      ? upsertAccessSubjectOn(queryable, ref)
      : upsertAccessSubject(db, ref)

  let runtimeSubjectIds = params.runtimeSubjectIds
    ? [...params.runtimeSubjectIds]
    : null
  let runtimeScopeSubjectIds = params.runtimeScopeSubjectIds
    ? [...params.runtimeScopeSubjectIds]
    : null

  if (!runtimeSubjectIds || !runtimeScopeSubjectIds) {
    const collected: string[] = []
    const collectedScopes: string[] = []
    const workspaceSubjectId = await upsert({
      kind: SUBJECT_KIND.WORKSPACE,
      workspaceId: params.workspaceId,
    })
    collected.push(workspaceSubjectId)
    collectedScopes.push(workspaceSubjectId)
    if (params.actorId) {
      collected.push(
        await upsert({ kind: SUBJECT_KIND.ACTOR, actorId: params.actorId })
      )
    }
    if (params.conversationId) {
      // Mirror buildConversationCapabilitySubjects gating: only surface the
      // conversation subject when the actor is an active participant. The
      // matcher caller usually passes a server-trusted actorId, so we let
      // the upsert in (subject_id ANY check handles non-membership: an actor
      // who isn't in the conversation won't have a matching binding).
      const convSubjectId = await upsert({
        kind: SUBJECT_KIND.CONVERSATION,
        conversationId: params.conversationId,
      })
      collected.push(convSubjectId)
      collectedScopes.push(convSubjectId)
    }
    runtimeSubjectIds = runtimeSubjectIds ?? Array.from(new Set(collected))
    runtimeScopeSubjectIds =
      runtimeScopeSubjectIds ?? Array.from(new Set(collectedScopes))
  }

  if (runtimeSubjectIds.length === 0) {
    return { matchedGrant: null }
  }

  // D1: once grants must additionally match at least one of source_retry_nonce
  // or source_task_id — see plan. If the caller supplies neither, no `once`
  // grant is eligible (fail-closed).
  const onceUnlockExpr = sql<boolean>`(
    g.retention <> 'consume_once'
    OR (
      (${params.retryNonce ?? null}::text IS NOT NULL AND g.source_retry_nonce = ${params.retryNonce ?? null}::text)
      OR (${params.sourceTaskId ?? null}::uuid IS NOT NULL AND g.source_task_id = ${params.sourceTaskId ?? null}::uuid)
    )
  )`

  const statement = relayGrantSelectFrom()
    .select(relayGrantSelectColumns())
    .where("g.workspace_id", "=", params.workspaceId)
    .where("g.relay_device_id", "=", params.relayDeviceId)
    .where("g.relay_capability_id", "=", params.relayCapabilityId)
    .where("g.relay_exposure_id", "=", params.relayExposureId)
    .where("g.status", "=", "active")
    .where("g.subject_id", "in", runtimeSubjectIds)
    .where((eb) =>
      eb.or([
        eb("g.scope_subject_id", "is", null),
        ...(runtimeScopeSubjectIds.length > 0
          ? [eb("g.scope_subject_id", "in", runtimeScopeSubjectIds)]
          : []),
      ])
    )
    .where(onceUnlockExpr)

  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute()
  const candidates = rows
    .map((row) => mapRelayAuthorizationGrantRow(row))
    .sort((left, right) => {
      const byRank =
        relayGrantSpecificityRank({
          retention: left.retention,
          hasScopeSubject: Boolean(left.scope),
          subjectKind: left.subject.kind,
        }) -
        relayGrantSpecificityRank({
          retention: right.retention,
          hasScopeSubject: Boolean(right.scope),
          subjectKind: right.subject.kind,
        })
      if (byRank !== 0) {
        return byRank
      }
      return right.createdAt.localeCompare(left.createdAt)
    })

  // D1: bounded-retry consume for once-only grants. Atomic UPDATE in
  // consumeRelayAuthorizationGrant returns false when another concurrent
  // matcher consumed the same row first; try the next matching candidate
  // up to MAX_CONSUME_RETRIES times before giving up.
  const MAX_CONSUME_RETRIES = 3
  let attempts = 0
  for (const candidate of candidates) {
    if (!relayAuthorizationGrantMatches(candidate, params.requestedAction)) {
      continue
    }
    if (!params.consumeOnce || candidate.retention !== "consume_once") {
      // Non-once grants don't need an atomic claim — return the first match.
      return { matchedGrant: candidate }
    }
    if (attempts >= MAX_CONSUME_RETRIES) {
      return { matchedGrant: null }
    }
    attempts += 1
    const consumed = await consumeRelayAuthorizationGrant(
      candidate.id,
      queryable
    )
    if (consumed) {
      candidate.status = "consumed"
      candidate.consumedAt = new Date().toISOString()
      return { matchedGrant: candidate }
    }
    // Lost the race — try the next candidate.
  }
  return { matchedGrant: null }
}

export async function listActiveRelayAuthorizationGrantsForExposure(
  relayCapabilityId: string,
  queryable?: Queryable
) {
  const statement = relayGrantSelectFrom()
    .select(relayGrantSelectColumns())
    .where("g.relay_capability_id", "=", relayCapabilityId)
    .where("g.status", "=", "active")
    .orderBy("g.created_at", "desc")
  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute()
  return rows.map((row) => mapRelayAuthorizationGrantRow(row))
}
