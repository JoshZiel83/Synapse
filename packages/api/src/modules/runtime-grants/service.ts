import crypto from "node:crypto";
import type {
  RuntimeAuthorizationPreset,
  RuntimeGrantEffect,
  RuntimeGrantRetention,
  RuntimeGrantScope,
  RuntimeGrantStatus,
} from "@synapse/shared/types";
import { sql } from "kysely";
import {
  db,
  executeCompiledQuery,
  executeTakeFirst,
  type QueryExecutor,
  type TableInsert,
} from "../../infrastructure/database/kysely.js";

type Queryable = QueryExecutor;

function isQueryExecutor(value: unknown): value is QueryExecutor {
  return typeof value === "object" && value !== null && "query" in value;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeFilesystemAccess(access: unknown) {
  const normalized =
    typeof access === "string" ? access.trim().toLowerCase() : "";
  if (
    normalized === "read" ||
    normalized === "write" ||
    normalized === "read_write"
  ) {
    return normalized;
  }
  return null;
}

function hashRequestPayload(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex");
}

function runtimeGrantScopeRank(scope: RuntimeGrantScope) {
  switch (scope) {
    case "once":
      return 0;
    case "actor":
      return 1;
    case "conversation":
      return 2;
    case "workspace":
      return 3;
    default:
      return 99;
  }
}

export interface RuntimeGrantRecord {
  id: string;
  workspaceId: string;
  relayDeviceId: string;
  relayExposureId: string;
  conversationId?: string;
  actorId?: string;
  createdByUserId?: string;
  createdByMemberId?: string;
  sourceInteractionId?: string;
  sourceTaskId?: string;
  scope: RuntimeGrantScope;
  retention: RuntimeGrantRetention;
  status: RuntimeGrantStatus;
  relayToolName: string;
  sourceRetryNonce?: string;
  sourceRuntimeSessionId?: string;
  sourceRequestArgs: Record<string, unknown>;
  sourceRequestHash?: string;
  effect: RuntimeGrantEffect;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  consumedAt?: string;
  revokedAt?: string;
  supersededAt?: string;
}

export interface CreateRuntimeGrantParams {
  workspaceId: string;
  relayDeviceId: string;
  relayExposureId: string;
  conversationId?: string;
  actorId?: string;
  createdByUserId?: string;
  createdByMemberId?: string;
  sourceInteractionId?: string;
  sourceTaskId?: string;
  preset: RuntimeAuthorizationPreset;
  relayToolName: string;
  sourceRetryNonce?: string;
  sourceRuntimeSessionId?: string;
  sourceRequestArgs: Record<string, unknown>;
  effect: RuntimeGrantEffect;
  metadata?: Record<string, unknown>;
}

export interface FindMatchingRuntimeGrantParams {
  workspaceId: string;
  relayExposureId: string;
  conversationId?: string;
  actorId?: string;
  relayToolName: string;
  effect: RuntimeGrantEffect;
  retryNonce?: string;
  consumeOnce?: boolean;
}

function mapRuntimeGrantRow(row: any): RuntimeGrantRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    relayDeviceId: row.relay_device_id,
    relayExposureId: row.relay_exposure_id,
    conversationId: row.conversation_id || undefined,
    actorId: row.actor_id || undefined,
    createdByUserId: row.created_by_user_id || undefined,
    createdByMemberId: row.created_by_member_id || undefined,
    sourceInteractionId: row.source_interaction_id || undefined,
    sourceTaskId: row.source_task_id || undefined,
    scope: row.scope,
    retention: row.retention,
    status: row.status,
    relayToolName: row.relay_tool_name,
    sourceRetryNonce: row.source_retry_nonce || undefined,
    sourceRuntimeSessionId: row.source_runtime_session_id || undefined,
    sourceRequestArgs: parseJsonObject(row.source_request_args),
    sourceRequestHash: row.source_request_hash || undefined,
    effect: parseJsonObject(row.effect) as unknown as RuntimeGrantEffect,
    metadata: parseJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date().toISOString(),
    consumedAt: toIsoString(row.consumed_at),
    revokedAt: toIsoString(row.revoked_at),
    supersededAt: toIsoString(row.superseded_at),
  };
}

export function runtimeAuthorizationPresetToGrant(
  preset: RuntimeAuthorizationPreset,
): { scope: RuntimeGrantScope; retention: RuntimeGrantRetention } {
  switch (preset) {
    case "once":
      return { scope: "once", retention: "consume_once" };
    case "actor":
      return { scope: "actor", retention: "until_revoked" };
    case "conversation":
      return { scope: "conversation", retention: "until_revoked" };
    case "workspace":
      return { scope: "workspace", retention: "until_revoked" };
    default:
      return { scope: "once", retention: "consume_once" };
  }
}

export async function createRuntimeGrant(
  params: CreateRuntimeGrantParams,
  queryable?: Queryable,
) {
  const { scope, retention } = runtimeAuthorizationPresetToGrant(params.preset);
  const statement = db
    .insertInto("runtime_grants")
    .values({
      workspace_id: params.workspaceId,
      relay_device_id: params.relayDeviceId,
      relay_exposure_id: params.relayExposureId,
      conversation_id: params.conversationId || null,
      actor_id: params.actorId || null,
      created_by_user_id: params.createdByUserId || null,
      created_by_member_id: params.createdByMemberId || null,
      source_interaction_id: params.sourceInteractionId || null,
      source_task_id: params.sourceTaskId || null,
      scope,
      retention,
      status: "active",
      relay_tool_name: params.relayToolName,
      source_retry_nonce: params.sourceRetryNonce || null,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_request_args:
        params.sourceRequestArgs as TableInsert<"runtime_grants">["source_request_args"],
      source_request_hash: hashRequestPayload(params.sourceRequestArgs),
      effect: params.effect as unknown as TableInsert<"runtime_grants">["effect"],
      metadata:
        (params.metadata || {}) as TableInsert<"runtime_grants">["metadata"],
    })
    .returningAll();
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst();
  if (!row) {
    throw new Error("Failed to create runtime grant");
  }
  return mapRuntimeGrantRow(row);
}

export async function getRuntimeGrant(id: string, queryable?: Queryable) {
  const statement = db
    .selectFrom("runtime_grants")
    .selectAll()
    .where("id", "=", id)
    .limit(1);
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst();
  return row ? mapRuntimeGrantRow(row) : null;
}

export async function revokeRuntimeGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .updateTable("runtime_grants")
    .set({
      status: "revoked",
      revoked_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active");
  if (isQueryExecutor(queryable)) {
    await executeCompiledQuery(queryable, statement);
    return;
  }
  await statement.execute();
}

export async function supersedeRuntimeGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .updateTable("runtime_grants")
    .set({
      status: "superseded",
      superseded_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active");
  if (isQueryExecutor(queryable)) {
    await executeCompiledQuery(queryable, statement);
    return;
  }
  await statement.execute();
}

export async function consumeRuntimeGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .updateTable("runtime_grants")
    .set({
      status: "consumed",
      consumed_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "=", id)
    .where("status", "=", "active");
  if (isQueryExecutor(queryable)) {
    await executeCompiledQuery(queryable, statement);
    return;
  }
  await statement.execute();
}

function filesystemGrantCovers(
  granted: RuntimeGrantEffect,
  requested: RuntimeGrantEffect,
) {
  if (granted.capability !== "filesystem" || requested.capability !== "filesystem") {
    return false;
  }
  const grantedAccess = normalizeFilesystemAccess(granted.access);
  const requestedAccess = normalizeFilesystemAccess(requested.access);
  if (!grantedAccess || !requestedAccess) {
    return false;
  }
  if (
    grantedAccess !== "read_write" &&
    grantedAccess !== requestedAccess
  ) {
    return false;
  }
  return (
    requested.path === granted.path ||
    requested.path.startsWith(`${granted.path}${pathSeparatorForMatch(granted.path)}`)
  );
}

function pathSeparatorForMatch(value: string) {
  return value.endsWith("/") ? "" : "/";
}

function commandlineGrantCovers(
  granted: RuntimeGrantEffect,
  requested: RuntimeGrantEffect,
) {
  if (
    granted.capability !== "commandline" ||
    requested.capability !== "commandline"
  ) {
    return false;
  }
  if (granted.executor !== requested.executor) {
    return false;
  }
  if (!granted.cwdPrefix) {
    return true;
  }
  if (!requested.cwdPrefix) {
    return false;
  }
  return (
    requested.cwdPrefix === granted.cwdPrefix ||
    requested.cwdPrefix.startsWith(
      `${granted.cwdPrefix}${pathSeparatorForMatch(granted.cwdPrefix)}`,
    )
  );
}

export function runtimeGrantEffectMatches(
  granted: RuntimeGrantEffect,
  requested: RuntimeGrantEffect,
) {
  if (granted.capability !== requested.capability) {
    return false;
  }
  if (granted.capability === "filesystem") {
    return filesystemGrantCovers(granted, requested);
  }
  if (granted.capability === "commandline") {
    return commandlineGrantCovers(granted, requested);
  }
  if (granted.capability === "cua" && requested.capability === "cua") {
    return granted.mode === requested.mode;
  }
  if (granted.capability === "chrome" && requested.capability === "chrome") {
    return granted.mode === requested.mode;
  }
  return false;
}

export async function findMatchingRuntimeGrant(
  params: FindMatchingRuntimeGrantParams,
  queryable?: Queryable,
) {
  const statement = db
    .selectFrom("runtime_grants")
    .selectAll()
    .where("workspace_id", "=", params.workspaceId)
    .where("relay_exposure_id", "=", params.relayExposureId)
    .where("relay_tool_name", "=", params.relayToolName)
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
      ]),
    );
  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute();
  const grants = rows
    .map((row) => mapRuntimeGrantRow(row))
    .filter((grant) => runtimeGrantEffectMatches(grant.effect, params.effect))
    .sort((left, right) => {
      const byScope =
        runtimeGrantScopeRank(left.scope) - runtimeGrantScopeRank(right.scope);
      if (byScope !== 0) {
        return byScope;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });

  const match = grants[0];
  if (!match) {
    return null;
  }
  if (params.consumeOnce && match.scope === "once") {
    await consumeRuntimeGrant(match.id, queryable);
    match.status = "consumed";
    match.consumedAt = new Date().toISOString();
  }
  return match;
}

export async function listActiveRuntimeGrantsForExposure(
  relayExposureId: string,
  queryable?: Queryable,
) {
  const statement = db
    .selectFrom("runtime_grants")
    .selectAll()
    .where("relay_exposure_id", "=", relayExposureId)
    .where("status", "=", "active")
    .orderBy("created_at", "desc");
  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute();
  return rows.map((row) => mapRuntimeGrantRow(row));
}
