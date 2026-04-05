import path from "node:path";
import type {
  RelayAuthorizationGrantSpec,
  RelayAuthorizationPreset,
  RelayAuthorizationRequirement,
  RelayAuthorizationGrantRetention,
  RelayAuthorizationGrantScope,
  RelayAuthorizationGrantStatus,
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
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function relayAuthorizationScopeRank(scope: RelayAuthorizationGrantScope) {
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

function normalizePathPrefix(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return path.resolve(path.normalize(value.trim()));
}

function pathSeparatorForMatch(value: string) {
  return value.endsWith(path.sep) ? "" : path.sep;
}

function pathWithinPrefix(target: string, prefix: string) {
  return target === prefix || target.startsWith(`${prefix}${pathSeparatorForMatch(prefix)}`);
}

function normalizeCommandText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function hasCompoundShellOperators(command: string) {
  return (
    command.includes("&&") ||
    command.includes("||") ||
    command.includes(";") ||
    command.includes("|") ||
    command.includes("\n")
  );
}

function commandPrefixMatches(prefix: string, command: string) {
  return command === prefix || command.startsWith(`${prefix} `);
}

export interface RelayAuthorizationGrantRecord
  extends RelayAuthorizationGrantSpec {
  id: string;
  workspaceId: string;
  relayDeviceId: string;
  relayCapabilityId: string;
  relayExposureId: string;
  conversationId?: string;
  actorId?: string;
  createdByWorkspaceMemberId?: string;
  sourceInteractionId?: string;
  sourceTaskId?: string;
  sourceRetryNonce?: string;
  sourceRuntimeSessionId?: string;
  sourceRequestArgs: Record<string, unknown>;
  scope: RelayAuthorizationGrantScope;
  retention: RelayAuthorizationGrantRetention;
  status: RelayAuthorizationGrantStatus;
  createdAt: string;
  updatedAt: string;
  consumedAt?: string;
  revokedAt?: string;
  supersededAt?: string;
}

export interface CreateRelayAuthorizationGrantParams {
  workspaceId: string;
  relayDeviceId: string;
  relayCapabilityId: string;
  relayExposureId: string;
  conversationId?: string;
  actorId?: string;
  createdByWorkspaceMemberId?: string;
  sourceInteractionId?: string;
  sourceTaskId?: string;
  preset: RelayAuthorizationPreset;
  grantSpec: RelayAuthorizationGrantSpec;
  sourceRetryNonce?: string;
  sourceRuntimeSessionId?: string;
  sourceRequestArgs?: Record<string, unknown>;
}

export interface FindMatchingRelayAuthorizationGrantsParams {
  workspaceId: string;
  relayDeviceId: string;
  relayCapabilityId: string;
  relayExposureId: string;
  conversationId?: string;
  actorId?: string;
  retryNonce?: string;
  requirements: RelayAuthorizationRequirement[];
  consumeOnce?: boolean;
}

function mapRelayAuthorizationGrantRow(row: any): RelayAuthorizationGrantRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    relayDeviceId: row.relay_device_id,
    relayCapabilityId: row.relay_capability_id,
    relayExposureId: row.relay_exposure_id,
    conversationId: row.conversation_id || undefined,
    actorId: row.actor_id || undefined,
    createdByWorkspaceMemberId:
      row.created_by_workspace_member_id || undefined,
    sourceInteractionId: row.source_interaction_id || undefined,
    sourceTaskId: row.source_task_id || undefined,
    sourceRetryNonce: row.source_retry_nonce || undefined,
    sourceRuntimeSessionId: row.source_runtime_session_id || undefined,
    sourceRequestArgs: parseJsonObject(row.source_request_args),
    scope: row.scope,
    retention: row.retention,
    status: row.status,
    kind: row.kind,
    pathPrefix: row.path_prefix || undefined,
    browserScopeType: row.browser_scope_type || undefined,
    browserOrigin: row.browser_origin || undefined,
    browserHost: row.browser_host || undefined,
    browserRegistrableDomain: row.browser_registrable_domain || undefined,
    commandExecutor: row.command_executor || undefined,
    commandMatchType: row.command_match_type || undefined,
    commandText: row.command_text || undefined,
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) || new Date().toISOString(),
    consumedAt: toIsoString(row.consumed_at),
    revokedAt: toIsoString(row.revoked_at),
    supersededAt: toIsoString(row.superseded_at),
  };
}

export function relayAuthorizationPresetToGrant(
  preset: RelayAuthorizationPreset,
): { scope: RelayAuthorizationGrantScope; retention: RelayAuthorizationGrantRetention } {
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

function normalizeGrantSpecForInsert(
  grantSpec: RelayAuthorizationGrantSpec,
): RelayAuthorizationGrantSpec {
  return {
    kind: grantSpec.kind,
    pathPrefix: normalizePathPrefix(grantSpec.pathPrefix) || undefined,
    browserScopeType: grantSpec.browserScopeType,
    browserOrigin:
      typeof grantSpec.browserOrigin === "string" && grantSpec.browserOrigin.trim()
        ? grantSpec.browserOrigin.trim()
        : undefined,
    browserHost:
      typeof grantSpec.browserHost === "string" && grantSpec.browserHost.trim()
        ? grantSpec.browserHost.trim().toLowerCase()
        : undefined,
    browserRegistrableDomain:
      typeof grantSpec.browserRegistrableDomain === "string" &&
      grantSpec.browserRegistrableDomain.trim()
        ? grantSpec.browserRegistrableDomain.trim().toLowerCase()
        : undefined,
    commandExecutor: grantSpec.commandExecutor,
    commandMatchType: grantSpec.commandMatchType,
    commandText: normalizeCommandText(grantSpec.commandText) || undefined,
  };
}

export async function createRelayAuthorizationGrant(
  params: CreateRelayAuthorizationGrantParams,
  queryable?: Queryable,
) {
  const { scope, retention } = relayAuthorizationPresetToGrant(params.preset);
  const grantSpec = normalizeGrantSpecForInsert(params.grantSpec);
  const statement = db
    .insertInto("relay_authorization_grants")
    .values({
      workspace_id: params.workspaceId,
      relay_device_id: params.relayDeviceId,
      relay_capability_id: params.relayCapabilityId,
      relay_exposure_id: params.relayExposureId,
      conversation_id: params.conversationId || null,
      actor_id: params.actorId || null,
      created_by_workspace_member_id:
        params.createdByWorkspaceMemberId || null,
      source_interaction_id: params.sourceInteractionId || null,
      source_task_id: params.sourceTaskId || null,
      scope,
      retention,
      status: "active",
      kind: grantSpec.kind,
      path_prefix: grantSpec.pathPrefix || null,
      browser_scope_type: grantSpec.browserScopeType || null,
      browser_origin: grantSpec.browserOrigin || null,
      browser_host: grantSpec.browserHost || null,
      browser_registrable_domain: grantSpec.browserRegistrableDomain || null,
      command_executor: grantSpec.commandExecutor || null,
      command_match_type: grantSpec.commandMatchType || null,
      command_text: grantSpec.commandText || null,
      source_retry_nonce: params.sourceRetryNonce || null,
      source_runtime_session_id: params.sourceRuntimeSessionId || null,
      source_request_args:
        (params.sourceRequestArgs || {}) as TableInsert<"relay_authorization_grants">["source_request_args"],
    })
    .returningAll();

  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst();
  if (!row) {
    throw new Error("Failed to create relay authorization grant");
  }
  return mapRelayAuthorizationGrantRow(row);
}

export async function createRelayAuthorizationGrants(
  params: Omit<CreateRelayAuthorizationGrantParams, "grantSpec"> & {
    grantSpecs: RelayAuthorizationGrantSpec[];
  },
  queryable?: Queryable,
) {
  const created: RelayAuthorizationGrantRecord[] = [];
  for (const grantSpec of params.grantSpecs) {
    created.push(
      await createRelayAuthorizationGrant(
        {
          ...params,
          grantSpec,
        },
        queryable,
      ),
    );
  }
  return created;
}

export async function getRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .selectFrom("relay_authorization_grants")
    .selectAll()
    .where("id", "=", id)
    .limit(1);
  const row = isQueryExecutor(queryable)
    ? await executeTakeFirst<any>(queryable, statement)
    : await statement.executeTakeFirst();
  return row ? mapRelayAuthorizationGrantRow(row) : null;
}

export async function revokeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .updateTable("relay_authorization_grants")
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

export async function supersedeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .updateTable("relay_authorization_grants")
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

export async function consumeRelayAuthorizationGrant(
  id: string,
  queryable?: Queryable,
) {
  const statement = db
    .updateTable("relay_authorization_grants")
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

function relayAuthorizationGrantMatches(
  grant: RelayAuthorizationGrantRecord,
  requirement: RelayAuthorizationRequirement,
) {
  if (grant.kind !== requirement.kind) {
    return false;
  }

  switch (grant.kind) {
    case "filesystem.directory":
    case "commandline.directory": {
      const grantedPrefix = normalizePathPrefix(grant.pathPrefix);
      const requestedPrefix = normalizePathPrefix(requirement.pathPrefix);
      if (!grantedPrefix || !requestedPrefix) {
        return false;
      }
      return pathWithinPrefix(requestedPrefix, grantedPrefix);
    }
    case "browser.site": {
      switch (grant.browserScopeType) {
        case "origin":
          return Boolean(
            grant.browserOrigin &&
              requirement.browserOrigin &&
              grant.browserOrigin === requirement.browserOrigin,
          );
        case "host":
          return Boolean(
            grant.browserHost &&
              requirement.browserHost &&
              grant.browserHost === requirement.browserHost,
          );
        case "domain":
          return Boolean(
            grant.browserRegistrableDomain &&
              requirement.browserRegistrableDomain &&
              grant.browserRegistrableDomain ===
                requirement.browserRegistrableDomain,
          );
        default:
          return false;
      }
    }
    case "commandline.command": {
      if (grant.commandExecutor !== requirement.commandExecutor) {
        return false;
      }
      const grantedText = normalizeCommandText(grant.commandText);
      const requestedText = normalizeCommandText(requirement.commandText);
      if (!grantedText || !requestedText) {
        return false;
      }
      if (grant.commandMatchType === "exact") {
        return grantedText === requestedText;
      }
      if (grant.commandMatchType === "prefix") {
        if (hasCompoundShellOperators(requestedText)) {
          return false;
        }
        return commandPrefixMatches(grantedText, requestedText);
      }
      return false;
    }
    default:
      return true;
  }
}

export async function findMatchingRelayAuthorizationGrants(
  params: FindMatchingRelayAuthorizationGrantsParams,
  queryable?: Queryable,
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
      ]),
    );

  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute();
  const candidates = rows
    .map((row) => mapRelayAuthorizationGrantRow(row))
    .sort((left, right) => {
      const byScope =
        relayAuthorizationScopeRank(left.scope) -
        relayAuthorizationScopeRank(right.scope);
      if (byScope !== 0) {
        return byScope;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });

  const matchedGrants: RelayAuthorizationGrantRecord[] = [];
  const missingRequirements: RelayAuthorizationRequirement[] = [];

  for (const requirement of params.requirements) {
    const match = candidates.find((grant) =>
      relayAuthorizationGrantMatches(grant, requirement),
    );
    if (!match) {
      missingRequirements.push(requirement);
      continue;
    }
    matchedGrants.push(match);
  }

  if (missingRequirements.length === 0 && params.consumeOnce) {
    const onceGrantIds = Array.from(
      new Set(
        matchedGrants
          .filter((grant) => grant.scope === "once")
          .map((grant) => grant.id),
      ),
    );
    for (const grantId of onceGrantIds) {
      await consumeRelayAuthorizationGrant(grantId, queryable);
    }
    const consumedAt = new Date().toISOString();
    for (const grant of matchedGrants) {
      if (grant.scope === "once") {
        grant.status = "consumed";
        grant.consumedAt = consumedAt;
      }
    }
  }

  return {
    matchedGrants,
    missingRequirements,
  };
}

export async function listActiveRelayAuthorizationGrantsForExposure(
  relayCapabilityId: string,
  queryable?: Queryable,
) {
  const statement = db
    .selectFrom("relay_authorization_grants")
    .selectAll()
    .where("relay_capability_id", "=", relayCapabilityId)
    .where("status", "=", "active")
    .orderBy("created_at", "desc");
  const rows = isQueryExecutor(queryable)
    ? (await executeCompiledQuery<any>(queryable, statement)).rows
    : await statement.execute();
  return rows.map((row) => mapRelayAuthorizationGrantRow(row));
}
