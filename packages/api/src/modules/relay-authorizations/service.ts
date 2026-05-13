import path from "node:path"
import type {
  RelayAuthorizationGrantSpec,
  RelayAuthorizationPreset,
  RelayAuthorizationGrantRetention,
  RelayAuthorizationGrantScope,
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

function relayAuthorizationScopeRank(scope: RelayAuthorizationGrantScope) {
  switch (scope) {
    case "once":
      return 0
    case "actor":
      return 1
    case "conversation":
      return 2
    case "workspace":
      return 3
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
  scope: RelayAuthorizationGrantScope
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
  retryNonce?: string
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
  const policy = parseJsonObject(
    value
  ) as unknown as RelayAuthorizationGrantSpec
  return normalizeGrantSpecForInsert(policy)
}

function mapRelayAuthorizationGrantRow(
  row: any
): RelayAuthorizationGrantRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    relayDeviceId: row.relay_device_id,
    relayCapabilityId: row.relay_capability_id,
    relayExposureId: row.relay_exposure_id,
    conversationId: row.conversation_id || undefined,
    actorId: row.actor_id || undefined,
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

export function relayAuthorizationPresetToGrant(
  preset: RelayAuthorizationPreset
): {
  scope: RelayAuthorizationGrantScope
  retention: RelayAuthorizationGrantRetention
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

export async function createRelayAuthorizationGrant(
  params: CreateRelayAuthorizationGrantParams,
  queryable?: Queryable
) {
  const { scope, retention } = relayAuthorizationPresetToGrant(params.preset)
  const grantSpec = normalizeGrantSpecForInsert(params.grantSpec)
  const statement = db
    .insertInto("relay_authorization_grants")
    .values({
      workspace_id: params.workspaceId,
      relay_device_id: params.relayDeviceId,
      relay_capability_id: params.relayCapabilityId,
      relay_exposure_id: params.relayExposureId,
      conversation_id: params.conversationId || null,
      actor_id: params.actorId || null,
      created_by_workspace_member_id: params.createdByWorkspaceMemberId || null,
      source_interaction_id: params.sourceInteractionId || null,
      source_task_id: params.sourceTaskId || null,
      scope,
      retention,
      status: "active",
      policy:
        grantSpec as unknown as TableInsert<"relay_authorization_grants">["policy"],
      source_retry_nonce: params.sourceRetryNonce || null,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_request_args: (params.sourceRequestArgs ||
        {}) as TableInsert<"relay_authorization_grants">["source_request_args"],
    })
    .returningAll()

  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst()
  if (!row) {
    throw new Error("Failed to create relay authorization grant")
  }
  return mapRelayAuthorizationGrantRow(row)
}

export async function getRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .selectFrom("relay_authorization_grants")
    .selectAll()
    .where("id", "=", id)
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

export async function consumeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable
) {
  const statement = db
    .updateTable("relay_authorization_grants")
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

function filesystemPolicyMatches(
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

function browserPolicyMatches(
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
      return true
  }
}

function commandlinePolicyMatches(
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

function relayAuthorizationGrantMatches(
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
  const statement = db
    .selectFrom("relay_authorization_grants")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("relay_device_id", "=", params.relayDeviceId)
    .where("relay_capability_id", "=", params.relayCapabilityId)
    .where("relay_exposure_id", "=", params.relayExposureId)
    .where("status", "=", "active")
    .where((eb) =>
      eb.or([
        eb("scope", "=", "workspace"),
        ...(params.conversationId
          ? [
              eb.and([
                eb("scope", "=", "conversation"),
                eb("conversation_id", "=", params.conversationId),
              ]),
            ]
          : []),
        ...(params.actorId
          ? [
              eb.and([
                eb("scope", "=", "actor"),
                eb("actor_id", "=", params.actorId),
              ]),
            ]
          : []),
        ...(params.retryNonce
          ? [
              eb.and([
                eb("scope", "=", "once"),
                eb("source_retry_nonce", "=", params.retryNonce),
              ]),
            ]
          : []),
      ])
    )

  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute()
  const candidates = rows
    .map((row) => mapRelayAuthorizationGrantRow(row))
    .sort((left, right) => {
      const byScope =
        relayAuthorizationScopeRank(left.scope) -
        relayAuthorizationScopeRank(right.scope)
      if (byScope !== 0) {
        return byScope
      }
      return right.createdAt.localeCompare(left.createdAt)
    })

  const matchedGrant =
    candidates.find((candidate) =>
      relayAuthorizationGrantMatches(candidate, params.requestedAction)
    ) || null

  if (matchedGrant && params.consumeOnce && matchedGrant.scope === "once") {
    await consumeRelayAuthorizationGrant(matchedGrant.id, queryable)
    matchedGrant.status = "consumed"
    matchedGrant.consumedAt = new Date().toISOString()
  }

  return {
    matchedGrant,
  }
}

export async function listActiveRelayAuthorizationGrantsForExposure(
  relayCapabilityId: string,
  queryable?: Queryable
) {
  const statement = db
    .selectFrom("relay_authorization_grants")
    .selectAll()
    .where("relay_capability_id", "=", relayCapabilityId)
    .where("status", "=", "active")
    .orderBy("created_at", "desc")
  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute()
  return rows.map((row) => mapRelayAuthorizationGrantRow(row))
}
