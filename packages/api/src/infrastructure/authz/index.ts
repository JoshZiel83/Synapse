import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { v1 } from "@authzed/authzed-node";
import { sql } from "kysely";
import { config } from "../../config/index.js";
import { transaction } from "../database/index.js";
import {
  db,
  executeCompiledQuery,
  executeCompiledSql,
  type TableInsert,
  type TableRow,
} from "../database/kysely.js";

export const AUTHZ_PLATFORM_ID = "synapse";

export function buildActorConversationContextId(
  actorId: string,
  conversationId: string,
) {
  return `${actorId}|${conversationId}`;
}

export function buildWorkspaceUserContextId(
  workspaceId: string,
  userId: string,
) {
  return `${workspaceId}|${userId}`;
}

export function buildConversationWorkspaceContextId(
  workspaceId: string,
  conversationId: string,
) {
  return `${workspaceId}|${conversationId}`;
}

export type AuthzObjectType =
  | "platform"
  | "workspace"
  | "workspace_user"
  | "conversation_workspace"
  | "user"
  | "actor"
  | "installed_skill"
  | "plugin_installation"
  | "relay_device"
  | "relay_exposure"
  | "actor_conversation"
  | "conversation"
  | "memory"
  | "mcp_relay"
  | "model_group"
  | "model_profile";

export interface AuthzSubject {
  type: AuthzObjectType;
  id: string;
  relation?: string;
}

export interface AuthzRelationMutation {
  operation?: "touch" | "delete";
  resourceType: AuthzObjectType;
  resourceId: string;
  relation: string;
  subjectType: AuthzObjectType;
  subjectId: string;
  subjectRelation?: string;
}

const AUTHZ_RESOURCE_TYPES: AuthzObjectType[] = [
  "platform",
  "workspace",
  "workspace_user",
  "conversation_workspace",
  "user",
  "actor",
  "installed_skill",
  "plugin_installation",
  "relay_device",
  "relay_exposure",
  "actor_conversation",
  "conversation",
  "memory",
  "mcp_relay",
  "model_group",
  "model_profile",
];

type AuthzOutboxRow = Pick<
  TableRow<"authz_outbox">,
  | "id"
  | "relation"
  | "resource_id"
  | "subject_id"
  | "subject_relation"
> & {
  operation: "touch" | "delete";
  resource_type: AuthzObjectType;
  subject_type: AuthzObjectType;
};

type Queryable = Pick<pg.PoolClient, "query">;

let authzClient: v1.ZedClientInterface | null = null;

const moduleDir = dirname(fileURLToPath(import.meta.url));

function relationMutationKey(entry: Omit<AuthzRelationMutation, "operation">) {
  return [
    entry.resourceType,
    entry.resourceId,
    entry.relation,
    entry.subjectType,
    entry.subjectId,
    entry.subjectRelation || "",
  ].join("::");
}

function ensureAuthzEnabled() {
  if (!config.authz.enabled) {
    throw new Error("SpiceDB authorization is disabled");
  }
}

function getAuthzClient() {
  ensureAuthzEnabled();

  if (!authzClient) {
    const security = config.authz.insecure
      ? v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS
      : v1.ClientSecurity.SECURE;

    authzClient = v1.NewClient(
      config.authz.token,
      config.authz.endpoint,
      security,
    );
  }

  return authzClient;
}

function fullyConsistent() {
  return v1.Consistency.create({
    requirement: {
      oneofKind: "fullyConsistent",
      fullyConsistent: true,
    },
  });
}

function objectRef(objectType: AuthzObjectType, objectId: string) {
  return v1.ObjectReference.create({
    objectType,
    objectId,
  });
}

function subjectRef(subject: AuthzSubject) {
  return v1.SubjectReference.create({
    object: objectRef(subject.type, subject.id),
    optionalRelation: subject.relation || "",
  });
}

function relationshipUpdate(entry: AuthzOutboxRow) {
  return v1.RelationshipUpdate.create({
    operation:
      entry.operation === "delete"
        ? v1.RelationshipUpdate_Operation.DELETE
        : v1.RelationshipUpdate_Operation.TOUCH,
    relationship: v1.Relationship.create({
      resource: objectRef(entry.resource_type, entry.resource_id),
      relation: entry.relation,
      subject: subjectRef({
        type: entry.subject_type,
        id: entry.subject_id,
        relation: entry.subject_relation || undefined,
      }),
    }),
  });
}

function uniqueOutboxEntries(entries: AuthzOutboxRow[]) {
  const deduped = new Map<string, AuthzOutboxRow>();

  for (const entry of entries) {
    deduped.set(
      relationMutationKey({
        resourceType: entry.resource_type,
        resourceId: entry.resource_id,
        relation: entry.relation,
        subjectType: entry.subject_type,
        subjectId: entry.subject_id,
        subjectRelation: entry.subject_relation || undefined,
      }),
      entry,
    );
  }

  return Array.from(deduped.values());
}

function normalizeSchemaText(text: string) {
  return text.trim().replace(/\r\n/g, "\n");
}

async function resolveSchemaPath() {
  const candidates = [
    config.authz.schemaPath
      ? resolve(process.cwd(), config.authz.schemaPath)
      : "",
    resolve(process.cwd(), "docs/spicedb-schema.zed"),
    resolve(moduleDir, "../../../../../docs/spicedb-schema.zed"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next path
    }
  }

  throw new Error("Unable to locate SpiceDB schema file");
}

async function readSchemaText() {
  const schemaPath = await resolveSchemaPath();
  const schemaText = await readFile(schemaPath, "utf-8");
  return {
    schemaPath,
    schemaText,
  };
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimOutboxEntriesByIds(entryIds: string[]) {
  if (entryIds.length === 0) return [] as AuthzOutboxRow[];

  return transaction(async (client) => {
    const result = await executeCompiledQuery<AuthzOutboxRow>(
      client,
      db
        .updateTable("authz_outbox")
        .set({
          status: "processing",
          attempts: sql`attempts + 1`,
          last_error: null,
          updated_at: sql`NOW()`,
        })
        .where("id", "in", entryIds)
        .where("status", "in", ["pending", "failed"])
        .returning([
          "id",
          "operation",
          "resource_type",
          "resource_id",
          "relation",
          "subject_type",
          "subject_id",
          "subject_relation",
        ]),
    );

    return result.rows;
  });
}

async function claimPendingOutboxEntries(limit: number) {
  return transaction(async (client) => {
    const compiled = sql<AuthzOutboxRow[]>`
      WITH claimed AS (
        SELECT id
        FROM authz_outbox
        WHERE status IN ('pending', 'failed')
        ORDER BY created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE authz_outbox ao
      SET status = 'processing',
          attempts = attempts + 1,
          last_error = NULL,
          updated_at = NOW()
      FROM claimed
      WHERE ao.id = claimed.id
      RETURNING ao.id, ao.operation, ao.resource_type, ao.resource_id, ao.relation, ao.subject_type, ao.subject_id, ao.subject_relation
    `.compile(db);
    const result = await executeCompiledSql<AuthzOutboxRow>(client, compiled);

    return result.rows;
  });
}

async function markOutboxEntriesApplied(entryIds: string[], zedToken?: string) {
  if (entryIds.length === 0) return;

  await db
    .updateTable("authz_outbox")
    .set({
      status: "applied",
      zed_token: zedToken || null,
      last_error: null,
      applied_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where("id", "in", entryIds)
    .execute();
}

async function markOutboxEntriesFailed(entryIds: string[], error: unknown) {
  if (entryIds.length === 0) return;

  const message = error instanceof Error ? error.message : String(error);
  await db
    .updateTable("authz_outbox")
    .set({
      status: "failed",
      last_error: message,
      updated_at: sql`NOW()`,
    })
    .where("id", "in", entryIds)
    .execute();
}

async function insertOutboxEntries(
  queryable: Queryable,
  entries: AuthzRelationMutation[],
  metadata?: Record<string, unknown>,
) {
  if (!config.authz.enabled || entries.length === 0) {
    return [] as string[];
  }

  const ids: string[] = [];

  for (const entry of entries) {
    const row: Pick<
      TableInsert<"authz_outbox">,
      | "metadata"
      | "operation"
      | "relation"
      | "resource_id"
      | "resource_type"
      | "subject_id"
      | "subject_relation"
      | "subject_type"
    > = {
      metadata:
        (metadata || {}) as TableInsert<"authz_outbox">["metadata"],
      operation: entry.operation || "touch",
      relation: entry.relation,
      resource_id: entry.resourceId,
      resource_type: entry.resourceType,
      subject_id: entry.subjectId,
      subject_relation: entry.subjectRelation || null,
      subject_type: entry.subjectType,
    };
    const result = await executeCompiledQuery<{ id: string }>(
      queryable,
      db
        .insertInto("authz_outbox")
        .values(row)
        .returning("id"),
    );
    ids.push(result.rows[0].id);
  }

  return ids;
}

export function authzEnabled() {
  return config.authz.enabled;
}

export function uniqueAuthzRelationships(entries: AuthzRelationMutation[]) {
  const deduped = new Map<string, AuthzRelationMutation>();

  for (const entry of entries) {
    deduped.set(
      relationMutationKey({
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        relation: entry.relation,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        subjectRelation: entry.subjectRelation,
      }),
      {
        operation: entry.operation || "touch",
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        relation: entry.relation,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        subjectRelation: entry.subjectRelation,
      },
    );
  }

  return Array.from(deduped.values());
}

export function touchRelation(
  resourceType: AuthzObjectType,
  resourceId: string,
  relation: string,
  subjectType: AuthzObjectType,
  subjectId: string,
  subjectRelation?: string,
): AuthzRelationMutation {
  return {
    operation: "touch",
    resourceType,
    resourceId,
    relation,
    subjectType,
    subjectId,
    subjectRelation,
  };
}

export function touchActorConversationContext(
  actorId: string,
  conversationId: string,
): AuthzRelationMutation[] {
  const contextId = buildActorConversationContextId(actorId, conversationId);
  return [
    touchRelation("actor_conversation", contextId, "actor", "actor", actorId),
    touchRelation(
      "actor_conversation",
      contextId,
      "conversation",
      "conversation",
      conversationId,
    ),
  ];
}

export function touchWorkspaceUserContext(
  workspaceId: string,
  userId: string,
): AuthzRelationMutation[] {
  const contextId = buildWorkspaceUserContextId(workspaceId, userId);
  return [
    touchRelation(
      "workspace_user",
      contextId,
      "self",
      "workspace_user",
      contextId,
    ),
    touchRelation(
      "workspace_user",
      contextId,
      "workspace",
      "workspace",
      workspaceId,
    ),
    touchRelation("workspace_user", contextId, "user", "user", userId),
  ];
}

export function touchConversationWorkspaceContext(
  workspaceId: string,
  conversationId: string,
): AuthzRelationMutation[] {
  const contextId = buildConversationWorkspaceContextId(
    workspaceId,
    conversationId,
  );
  return [
    touchRelation(
      "conversation_workspace",
      contextId,
      "workspace",
      "workspace",
      workspaceId,
    ),
    touchRelation(
      "conversation_workspace",
      contextId,
      "conversation",
      "conversation",
      conversationId,
    ),
  ];
}

export function touchWorkspaceUserMembership(
  workspaceId: string,
  userId: string,
  relation: string,
): AuthzRelationMutation[] {
  const contextId = buildWorkspaceUserContextId(workspaceId, userId);
  return [
    ...touchWorkspaceUserContext(workspaceId, userId),
    touchRelation(
      "workspace",
      workspaceId,
      relation,
      "workspace_user",
      contextId,
    ),
  ];
}

export function deleteRelation(
  resourceType: AuthzObjectType,
  resourceId: string,
  relation: string,
  subjectType: AuthzObjectType,
  subjectId: string,
  subjectRelation?: string,
): AuthzRelationMutation {
  return {
    operation: "delete",
    resourceType,
    resourceId,
    relation,
    subjectType,
    subjectId,
    subjectRelation,
  };
}

export function diffAuthzRelationships(
  previousEntries: AuthzRelationMutation[],
  nextEntries: AuthzRelationMutation[],
) {
  const previous = uniqueAuthzRelationships(previousEntries).map((entry) => ({
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    relation: entry.relation,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectRelation: entry.subjectRelation,
  }));
  const next = uniqueAuthzRelationships(nextEntries).map((entry) => ({
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    relation: entry.relation,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectRelation: entry.subjectRelation,
  }));

  const previousMap = new Map(
    previous.map((entry) => [relationMutationKey(entry), entry]),
  );
  const nextMap = new Map(
    next.map((entry) => [relationMutationKey(entry), entry]),
  );

  const deletes = Array.from(previousMap.entries())
    .filter(([key]) => !nextMap.has(key))
    .map(([, entry]) =>
      deleteRelation(
        entry.resourceType,
        entry.resourceId,
        entry.relation,
        entry.subjectType,
        entry.subjectId,
        entry.subjectRelation,
      ),
    );

  const touches = Array.from(nextMap.entries())
    .filter(([key]) => !previousMap.has(key))
    .map(([, entry]) =>
      touchRelation(
        entry.resourceType,
        entry.resourceId,
        entry.relation,
        entry.subjectType,
        entry.subjectId,
        entry.subjectRelation,
      ),
    );

  return [...deletes, ...touches];
}

export async function initializeAuthz() {
  if (!config.authz.enabled) {
    return {
      enabled: false,
      schemaUpdated: false,
      drainedOutboxEntries: 0,
    };
  }

  await waitForAuthzReady();
  const schemaResult = await syncAuthzSchema();
  const drainedOutboxEntries = await drainAuthzOutbox(
    config.authz.outboxBatchSize,
  );

  return {
    enabled: true,
    schemaUpdated: schemaResult.updated,
    drainedOutboxEntries,
  };
}

export async function resetAuthzRelationships() {
  if (!config.authz.enabled) {
    return {
      enabled: false,
      schemaUpdated: false,
      relationshipsDeleted: 0,
    };
  }

  await waitForAuthzReady();

  let relationshipsDeleted = 0;

  const legacyResourceTypes = [
    "skill_binding",
    "plugin_mount",
  ] as const;

  for (const resourceType of legacyResourceTypes) {
    try {
      const response = await getAuthzClient().promises.deleteRelationships(
        v1.DeleteRelationshipsRequest.create({
          relationshipFilter: v1.RelationshipFilter.create({
            resourceType,
          }),
          optionalTransactionMetadata: v1.createStructFromObject({
            source: "synapse-authz-reset-legacy",
            resourceType,
          }),
        }),
      );

      relationshipsDeleted += Number.parseInt(
        response.relationshipsDeletedCount || "0",
        10,
      );
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : null;
      if (code !== 3 && code !== 5 && code !== 9) {
        throw error;
      }
    }
  }

  const schemaResult = await syncAuthzSchema();

  for (const resourceType of AUTHZ_RESOURCE_TYPES) {
    const response = await getAuthzClient().promises.deleteRelationships(
      v1.DeleteRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          resourceType,
        }),
        optionalTransactionMetadata: v1.createStructFromObject({
          source: "synapse-authz-reset",
          resourceType,
        }),
      }),
    );

    relationshipsDeleted += Number.parseInt(
      response.relationshipsDeletedCount || "0",
      10,
    );
  }

  return {
    enabled: true,
    schemaUpdated: schemaResult.updated,
    relationshipsDeleted,
  };
}

export async function waitForAuthzReady(maxAttempts = 15) {
  ensureAuthzEnabled();

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await getAuthzClient().promises.readSchema(
        v1.ReadSchemaRequest.create({}),
      );
      return;
    } catch (error) {
      if (authzSchemaMissing(error)) {
        return;
      }
      lastError = error;
      if (attempt === maxAttempts) break;
      await wait(Math.min(attempt * 500, 3000));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("SpiceDB did not become ready in time");
}

export async function syncAuthzSchema() {
  ensureAuthzEnabled();

  const { schemaPath, schemaText } = await readSchemaText();
  const normalizedDesired = normalizeSchemaText(schemaText);
  const client = getAuthzClient();

  const current = await readCurrentAuthzSchema(client);
  const normalizedCurrent = normalizeSchemaText(current || "");

  if (normalizedCurrent === normalizedDesired) {
    return { updated: false, schemaPath };
  }

  await client.promises.writeSchema(
    v1.WriteSchemaRequest.create({
      schema: schemaText,
    }),
  );

  return { updated: true, schemaPath };
}

async function readCurrentAuthzSchema(
  client: ReturnType<typeof getAuthzClient>,
) {
  try {
    const current = await client.promises.readSchema(
      v1.ReadSchemaRequest.create({}),
    );
    return current.schemaText || "";
  } catch (error) {
    if (authzSchemaMissing(error)) {
      return "";
    }
    throw error;
  }
}

function authzSchemaMissing(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  return code === 5;
}

export async function testAuthzConnection() {
  if (!config.authz.enabled) return true;

  try {
    await getAuthzClient().promises.readSchema(v1.ReadSchemaRequest.create({}));
    return true;
  } catch {
    return false;
  }
}

export async function closeAuthzClient() {
  authzClient?.close();
  authzClient = null;
}

export async function queueAuthzRelationships(
  client: Queryable,
  entries: AuthzRelationMutation[],
  metadata?: Record<string, unknown>,
) {
  return insertOutboxEntries(client, entries, metadata);
}

export async function enqueueAuthzRelationships(
  entries: AuthzRelationMutation[],
  metadata?: Record<string, unknown>,
) {
  return transaction(async (client) =>
    insertOutboxEntries(client, entries, metadata),
  );
}

export async function flushAuthzOutboxEntries(entryIds: string[]) {
  if (!config.authz.enabled || entryIds.length === 0) {
    return 0;
  }

  const entries = await claimOutboxEntriesByIds(entryIds);
  if (entries.length === 0) {
    return 0;
  }

  try {
    const updates = uniqueOutboxEntries(entries);
    const response = await getAuthzClient().promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: updates.map(relationshipUpdate),
        optionalTransactionMetadata: v1.createStructFromObject({
          source: "synapse-authz-outbox",
          entryCount: entries.length,
          dedupedEntryCount: updates.length,
        }),
      }),
    );

    await markOutboxEntriesApplied(
      entries.map((entry) => entry.id),
      response.writtenAt?.token,
    );
    return entries.length;
  } catch (error) {
    await markOutboxEntriesFailed(
      entries.map((entry) => entry.id),
      error,
    );
    throw error;
  }
}

export async function drainAuthzOutbox(
  batchSize = config.authz.outboxBatchSize,
) {
  if (!config.authz.enabled) {
    return 0;
  }

  let processed = 0;

  while (true) {
    const entries = await claimPendingOutboxEntries(batchSize);
    if (entries.length === 0) {
      return processed;
    }

    try {
      const updates = uniqueOutboxEntries(entries);
      const response = await getAuthzClient().promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: updates.map(relationshipUpdate),
          optionalTransactionMetadata: v1.createStructFromObject({
            source: "synapse-authz-outbox-drain",
            entryCount: entries.length,
            dedupedEntryCount: updates.length,
          }),
        }),
      );

      await markOutboxEntriesApplied(
        entries.map((entry) => entry.id),
        response.writtenAt?.token,
      );
      processed += entries.length;
    } catch (error) {
      await markOutboxEntriesFailed(
        entries.map((entry) => entry.id),
        error,
      );
      throw error;
    }
  }
}

export async function checkPermission(params: {
  resourceType: AuthzObjectType;
  resourceId: string;
  permission: string;
  subject: AuthzSubject;
}) {
  ensureAuthzEnabled();

  const response = await getAuthzClient().promises.checkPermission(
    v1.CheckPermissionRequest.create({
      consistency: fullyConsistent(),
      resource: objectRef(params.resourceType, params.resourceId),
      permission: params.permission,
      subject: subjectRef(params.subject),
    }),
  );

  return (
    response.permissionship ===
      v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION ||
    response.permissionship ===
      v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION
  );
}

export async function lookupResources(params: {
  resourceType: AuthzObjectType;
  permission: string;
  subject: AuthzSubject;
  limit?: number;
}) {
  ensureAuthzEnabled();

  const results = await getAuthzClient().promises.lookupResources(
    v1.LookupResourcesRequest.create({
      consistency: fullyConsistent(),
      resourceObjectType: params.resourceType,
      permission: params.permission,
      subject: subjectRef(params.subject),
      optionalLimit: params.limit || 0,
    }),
  );

  return results
    .filter(
      (result) =>
        result.permissionship === v1.LookupPermissionship.HAS_PERMISSION ||
        result.permissionship ===
          v1.LookupPermissionship.CONDITIONAL_PERMISSION,
    )
    .map((result) => result.resourceObjectId);
}
