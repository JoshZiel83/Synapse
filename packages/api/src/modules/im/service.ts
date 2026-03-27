import type {
  ConversationTransportBindingSummary,
  TransportAccountSummary,
  TransportAccountOwnerScope,
  TransportConnectionMode,
  TransportDeliveryStatus,
  TransportEndpointSummary,
  TransportEndpointType,
  TransportExternalUserSessionRef,
  TransportExternalUserSummary,
  TransportKind,
  TransportSessionSummary,
} from "@synapse/shared/types";
import { query, transaction } from "../../infrastructure/database/index.js";
import { v4 as uuidv4 } from "uuid";
import { enqueueTransportDeliveryJobs } from "../../workers/queues.js";
import { ensureConversationMember } from "../conversation/service.js";
import { activateConversationParticipant } from "../conversation/participant-activation.js";
import {
  assertSupportedConnectionMode,
  assertSupportedEndpointType,
} from "./connectors/index.js";

function parseJsonObject(value: unknown) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonArray<T>(value: unknown): T[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as T[]) : [];
}

function readTrimmedString(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
  }
  return undefined;
}

function assertTransportAccountConfiguration(params: {
  transportKind: TransportKind;
  connectionMode: TransportConnectionMode;
  status: "active" | "disabled" | "error";
  credentials?: Record<string, unknown>;
}) {
  if (params.status === "disabled") {
    return;
  }

  const credentials = params.credentials || {};

  if (params.transportKind === "feishu") {
    const appId = readTrimmedString(credentials, "appId", "appID", "cliAppId");
    const appSecret = readTrimmedString(
      credentials,
      "appSecret",
      "app_secret",
      "cliAppSecret",
    );
    if (!appId || !appSecret) {
      throw new Error("Feishu account requires appId and appSecret");
    }

    if (params.connectionMode === "webhook") {
      const verificationToken = readTrimmedString(
        credentials,
        "verificationToken",
        "verification_token",
      );
      const encryptKey = readTrimmedString(
        credentials,
        "encryptKey",
        "encrypt_key",
      );
      if (!verificationToken || !encryptKey) {
        throw new Error(
          "Feishu webhook mode requires verificationToken and encryptKey",
        );
      }
    }
    return;
  }

  if (params.transportKind === "weixin") {
    const token = readTrimmedString(credentials, "token");
    if (!token) {
      throw new Error("Weixin account requires token");
    }
  }
}

function normalizeAccountRow(row: any): TransportAccountSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transportKind: row.transport_kind,
    accountKey: row.account_key,
    displayName: row.display_name,
    ownerScope:
      (row.owner_scope as TransportAccountOwnerScope | undefined) ||
      "workspace",
    ownerUserId: row.owner_user_id || undefined,
    connectionMode: row.connection_mode,
    status: row.status,
    credentials: parseJsonObject(row.credentials),
    config: parseJsonObject(row.config),
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeEndpointRow(
  row: any,
  transportKind: TransportKind,
): TransportEndpointSummary {
  return {
    id: row.endpoint_id || row.id,
    transportAccountId: row.transport_account_id,
    transportKind,
    endpointType: row.endpoint_type,
    externalId: row.endpoint_external_id || row.external_id,
    parentExternalId: row.parent_external_id || undefined,
    displayName: row.endpoint_display_name || row.display_name || undefined,
    metadata: parseJsonObject(row.endpoint_metadata || row.metadata),
    createdAt: row.endpoint_created_at || row.created_at,
    updatedAt: row.endpoint_updated_at || row.updated_at,
  };
}

function normalizeBindingRow(row: any): ConversationTransportBindingSummary {
  const account = normalizeAccountRow(row);
  return {
    id: row.binding_id || row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    transportKind: row.transport_kind,
    outboundEnabled: Boolean(row.outbound_enabled),
    defaultTargetParticipantId: row.default_target_member_id || undefined,
    metadata: parseJsonObject(row.binding_metadata || row.metadata),
    createdAt: row.binding_created_at || row.created_at,
    updatedAt: row.binding_updated_at || row.updated_at,
    account,
    endpoint: normalizeEndpointRow(row, row.transport_kind),
  };
}

function normalizeTransportSessionRow(row: any): TransportSessionSummary {
  const workspaceId = row.account_workspace_id || row.workspace_id;
  const account = normalizeAccountRow({
    ...row,
    workspace_id: workspaceId,
  });
  return {
    id: row.endpoint_id || row.binding_id || row.id,
    workspaceId,
    transportKind: row.transport_kind,
    outboundEnabled: Boolean(row.outbound_enabled),
    defaultTargetParticipantId: row.default_target_member_id || undefined,
    metadata: parseJsonObject(
      row.binding_metadata || row.endpoint_metadata || row.metadata,
    ),
    createdAt:
      row.binding_created_at || row.endpoint_created_at || row.created_at,
    updatedAt:
      row.binding_updated_at || row.endpoint_updated_at || row.updated_at,
    conversationId: row.conversation_id || undefined,
    conversationTitle: readTrimmedString(row, "conversation_title"),
    lastInboundAt: row.last_inbound_at || undefined,
    lastOutboundAt: row.last_outbound_at || undefined,
    account,
    endpoint: normalizeEndpointRow(row, row.transport_kind),
  };
}

function normalizeTransportExternalUserRow(
  row: any,
): TransportExternalUserSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    transportAccountId: row.transport_account_id,
    transportKind: row.transport_kind,
    accountDisplayName: row.account_display_name || "Transport account",
    externalId: row.external_id,
    displayName: row.display_name || undefined,
    linkedUserId: row.linked_user_id || undefined,
    linkedUserName: row.linked_user_name || undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at || undefined,
    sessions: parseJsonArray<TransportExternalUserSessionRef>(row.sessions),
  };
}

async function assertTransportAccountOwner(params: {
  workspaceId: string;
  ownerScope: TransportAccountOwnerScope;
  ownerUserId?: string | null;
}) {
  if (params.ownerScope === "workspace") {
    if (params.ownerUserId) {
      throw new Error(
        "Workspace-owned transport account cannot have an owner user",
      );
    }
    return null;
  }

  const ownerUserId = params.ownerUserId || null;
  if (!ownerUserId) {
    throw new Error("Workspace-user transport account requires ownerUserId");
  }

  const isWorkspaceMember = await assertWorkspaceMember({
    workspaceId: params.workspaceId,
    userId: ownerUserId,
  });
  if (!isWorkspaceMember) {
    throw new Error("Transport account owner must be a workspace member");
  }

  return ownerUserId;
}

async function loadTransportAccountRow(workspaceId: string, accountId: string) {
  const result = await query(
    `SELECT *
     FROM transport_accounts
     WHERE workspace_id = $1
       AND id = $2
     LIMIT $3`,
    [workspaceId, accountId, 1],
  );
  return result.rows[0] ?? null;
}

async function loadTransportAccountRowByWorkspaceKey(params: {
  workspaceId: string;
  transportKind: TransportKind;
  accountKey: string;
}) {
  const result = await query(
    `SELECT *
     FROM transport_accounts
     WHERE workspace_id = $1
       AND transport_kind = $2
       AND account_key = $3
     LIMIT $4`,
    [params.workspaceId, params.transportKind, params.accountKey.trim(), 1],
  );
  return result.rows[0] ?? null;
}

async function loadTransportAccountRowById(accountId: string) {
  const result = await query(
    `SELECT *
     FROM transport_accounts
     WHERE id = $1
     LIMIT $2`,
    [accountId, 1],
  );
  return result.rows[0] ?? null;
}

async function assertConversationMembers(params: {
  conversationId: string;
  memberIds: string[];
}) {
  if (params.memberIds.length === 0) return;
  const result = await query(
    `SELECT id
     FROM conversation_members
     WHERE conversation_id = $1
       AND id = ANY($2::uuid[])`,
    [params.conversationId, params.memberIds],
  );
  const existing = new Set(result.rows.map((row) => row.id as string));
  const missing = params.memberIds.filter(
    (memberId) => !existing.has(memberId),
  );
  if (missing.length > 0) {
    throw new Error(
      "One or more target participants do not belong to this conversation",
    );
  }
}

async function assertConversationMemberType(params: {
  conversationId: string;
  memberId?: string | null;
  allowedTypes: Array<"actor" | "user" | "external">;
  label: string;
}) {
  if (!params.memberId) return;

  const result = await query(
    `SELECT member_type
     FROM conversation_members
     WHERE conversation_id = $1
       AND id = $2
     LIMIT $3`,
    [params.conversationId, params.memberId, 1],
  );
  const memberType = result.rows[0]?.member_type as
    | "actor"
    | "user"
    | "external"
    | undefined;
  if (!memberType) {
    throw new Error(`${params.label} does not belong to this conversation`);
  }
  if (!params.allowedTypes.includes(memberType)) {
    throw new Error(
      `${params.label} must be one of: ${params.allowedTypes.join(", ")}`,
    );
  }
}

function normalizeTransportMessageLinkRow(row: any) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    itemId: row.item_id,
    transportAccountId: row.transport_account_id,
    transportEndpointId: row.transport_endpoint_id,
    transportKind: row.transport_kind as TransportKind,
    direction: row.direction as "inbound" | "outbound",
    deliveryStatus: row.delivery_status as TransportDeliveryStatus,
    externalMessageId: row.external_message_id || undefined,
    metadata: parseJsonObject(row.metadata),
    deliveredAt: row.delivered_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listTransportAccounts(
  workspaceId: string,
): Promise<TransportAccountSummary[]> {
  const result = await query(
    `SELECT *
     FROM transport_accounts
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(normalizeAccountRow);
}

export async function getTransportAccountById(accountId: string) {
  const row = await loadTransportAccountRowById(accountId);
  return row ? normalizeAccountRow(row) : null;
}

export async function getTransportAccountByKindAndId(params: {
  accountId: string;
  transportKind: TransportKind;
}) {
  const result = await query(
    `SELECT *
     FROM transport_accounts
     WHERE id = $1
       AND transport_kind = $2
     LIMIT $3`,
    [params.accountId, params.transportKind, 1],
  );
  return result.rows[0] ? normalizeAccountRow(result.rows[0]) : null;
}

export async function getTransportAccountByWorkspaceKindAndKey(params: {
  workspaceId: string;
  transportKind: TransportKind;
  accountKey: string;
}) {
  const row = await loadTransportAccountRowByWorkspaceKey(params);
  return row ? normalizeAccountRow(row) : null;
}

export async function listActiveTransportAccounts(params?: {
  connectionMode?: TransportConnectionMode;
  transportKind?: TransportKind;
}) {
  const values: any[] = ["active"];
  const filters = [`status = $1`];
  if (params?.connectionMode) {
    values.push(params.connectionMode);
    filters.push(`connection_mode = $${values.length}`);
  }
  if (params?.transportKind) {
    values.push(params.transportKind);
    filters.push(`transport_kind = $${values.length}`);
  }
  const result = await query(
    `SELECT *
     FROM transport_accounts
     WHERE ${filters.join(" AND ")}
     ORDER BY created_at ASC`,
    values,
  );
  return result.rows.map(normalizeAccountRow);
}

export async function listTransportSessions(
  workspaceId: string,
): Promise<TransportSessionSummary[]> {
  const result = await query(
    `SELECT ctb.id AS binding_id,
            ctb.workspace_id,
            ctb.conversation_id,
            ctb.outbound_enabled,
            ctb.default_target_member_id,
            ctb.metadata AS binding_metadata,
            ctb.created_at AS binding_created_at,
            ctb.updated_at AS binding_updated_at,
            c.title AS conversation_title,
            ta.id,
            ta.workspace_id AS account_workspace_id,
            ta.account_key,
            ta.display_name,
            ta.transport_kind,
            ta.owner_scope,
            ta.owner_user_id,
            ta.connection_mode,
            ta.status,
            ta.credentials,
            ta.config,
            ta.metadata,
            ta.created_at,
            ta.updated_at,
            te.id AS endpoint_id,
            te.transport_account_id,
            te.endpoint_type,
            te.external_id AS endpoint_external_id,
            te.parent_external_id,
            te.display_name AS endpoint_display_name,
            te.metadata AS endpoint_metadata,
            te.created_at AS endpoint_created_at,
            te.updated_at AS endpoint_updated_at,
            inbound_activity.last_inbound_at,
            outbound_activity.last_outbound_at
     FROM transport_endpoints te
     JOIN transport_accounts ta ON ta.id = te.transport_account_id
     LEFT JOIN conversation_transport_bindings ctb
       ON ctb.transport_endpoint_id = te.id
     LEFT JOIN conversations c ON c.id = ctb.conversation_id
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_inbound_at
       FROM transport_message_links
       WHERE transport_endpoint_id = te.id
         AND direction = 'inbound'
     ) inbound_activity ON TRUE
     LEFT JOIN LATERAL (
       SELECT MAX(created_at) AS last_outbound_at
       FROM transport_message_links
       WHERE transport_endpoint_id = te.id
         AND direction = 'outbound'
     ) outbound_activity ON TRUE
     WHERE ta.workspace_id = $1
     ORDER BY COALESCE(inbound_activity.last_inbound_at, outbound_activity.last_outbound_at, te.updated_at) DESC,
              te.created_at DESC`,
    [workspaceId],
  );
  return result.rows.map(normalizeTransportSessionRow);
}

export async function listTransportExternalUsers(params: {
  workspaceId: string;
  transportAccountId?: string;
}): Promise<TransportExternalUserSummary[]> {
  const values: any[] = [params.workspaceId, "user"];
  const filters = [`ta.workspace_id = $1`, `ta.address_type = $2`];
  if (params.transportAccountId) {
    values.push(params.transportAccountId);
    filters.push(`ta.transport_account_id = $${values.length}`);
  }

  const result = await query(
    `SELECT ta.id,
            ta.workspace_id,
            ta.transport_account_id,
            ta.transport_kind,
            ta.external_id,
            ta.display_name,
            ta.metadata,
            ta.created_at,
            ta.updated_at,
            account.display_name AS account_display_name,
            linked_user.id AS linked_user_id,
            linked_user.name AS linked_user_name,
            activity.last_seen_at,
            COALESCE(
              jsonb_agg(
                DISTINCT jsonb_build_object(
                  'conversationId', c.id,
                  'conversationTitle', c.title,
                  'endpointId', te.id,
                  'endpointType', te.endpoint_type,
                  'endpointExternalId', te.external_id,
                  'endpointDisplayName', te.display_name
                )
              ) FILTER (WHERE te.id IS NOT NULL),
              '[]'::jsonb
            ) AS sessions
     FROM transport_addresses ta
     JOIN transport_accounts account ON account.id = ta.transport_account_id
     LEFT JOIN users linked_user ON linked_user.id = ta.user_id
     LEFT JOIN conversation_participant_addresses cpa
       ON cpa.transport_address_id = ta.id
     LEFT JOIN conversation_members cm ON cm.id = cpa.conversation_member_id
     LEFT JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN conversation_transport_bindings ctb
       ON ctb.conversation_id = c.id
     LEFT JOIN transport_endpoints te ON te.id = ctb.transport_endpoint_id
     LEFT JOIN LATERAL (
       SELECT MAX(tml.created_at) AS last_seen_at
       FROM conversation_participant_addresses cpa_activity
       JOIN conversation_members cm_activity
         ON cm_activity.id = cpa_activity.conversation_member_id
       JOIN transport_message_links tml
         ON tml.conversation_id = cm_activity.conversation_id
       WHERE cpa_activity.transport_address_id = ta.id
     ) activity ON TRUE
     WHERE ${filters.join(" AND ")}
     GROUP BY ta.id,
              account.display_name,
              linked_user.id,
              linked_user.name,
              activity.last_seen_at
     ORDER BY COALESCE(activity.last_seen_at, ta.updated_at, ta.created_at) DESC,
              ta.created_at DESC`,
    values,
  );
  return result.rows.map(normalizeTransportExternalUserRow);
}

export async function createTransportAccount(params: {
  workspaceId: string;
  transportKind: TransportKind;
  accountKey: string;
  displayName: string;
  ownerScope?: TransportAccountOwnerScope;
  ownerUserId?: string | null;
  connectionMode: TransportConnectionMode;
  status?: "active" | "disabled" | "error";
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  assertSupportedConnectionMode(params.transportKind, params.connectionMode);
  const nextStatus = params.status || "active";
  assertTransportAccountConfiguration({
    transportKind: params.transportKind,
    connectionMode: params.connectionMode,
    status: nextStatus,
    credentials: params.credentials,
  });
  const ownerScope = params.ownerScope || "workspace";
  const ownerUserId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope,
    ownerUserId: ownerScope === "workspace" ? null : params.ownerUserId,
  });

  const result = await query(
    `INSERT INTO transport_accounts
       (id, workspace_id, transport_kind, account_key, display_name, owner_scope, owner_user_id, connection_mode, status, credentials, config, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.workspaceId,
      params.transportKind,
      params.accountKey.trim(),
      params.displayName.trim(),
      ownerScope,
      ownerUserId,
      params.connectionMode,
      nextStatus,
      JSON.stringify(params.credentials || {}),
      JSON.stringify(params.config || {}),
      JSON.stringify(params.metadata || {}),
    ],
  );

  return normalizeAccountRow(result.rows[0]);
}

export async function updateTransportAccount(params: {
  workspaceId: string;
  accountId: string;
  displayName?: string;
  ownerScope?: TransportAccountOwnerScope;
  ownerUserId?: string | null;
  connectionMode?: TransportConnectionMode;
  status?: "active" | "disabled" | "error";
  credentials?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  const existing = await loadTransportAccountRow(
    params.workspaceId,
    params.accountId,
  );
  if (!existing) {
    throw new Error("Transport account not found");
  }

  const nextConnectionMode =
    params.connectionMode ||
    (existing.connection_mode as TransportConnectionMode);
  assertSupportedConnectionMode(existing.transport_kind, nextConnectionMode);
  const nextStatus =
    params.status || (existing.status as "active" | "disabled" | "error");
  const nextCredentials = params.credentials
    ? params.credentials
    : parseJsonObject(existing.credentials);
  const nextOwnerScope =
    params.ownerScope ||
    (existing.owner_scope as TransportAccountOwnerScope | undefined) ||
    "workspace";
  const nextOwnerUserId =
    nextOwnerScope === "workspace"
      ? null
      : params.ownerUserId !== undefined
        ? params.ownerUserId
        : (existing.owner_user_id as string | null | undefined) || null;
  assertTransportAccountConfiguration({
    transportKind: existing.transport_kind as TransportKind,
    connectionMode: nextConnectionMode,
    status: nextStatus,
    credentials: nextCredentials,
  });
  const resolvedOwnerUserId = await assertTransportAccountOwner({
    workspaceId: params.workspaceId,
    ownerScope: nextOwnerScope,
    ownerUserId: nextOwnerUserId,
  });

  const result = await query(
    `UPDATE transport_accounts
     SET display_name = COALESCE($3, display_name),
         owner_scope = $4,
         owner_user_id = $5,
         connection_mode = $6,
         status = COALESCE($7, status),
         credentials = CASE WHEN $8::jsonb IS NULL THEN credentials ELSE $8::jsonb END,
         config = CASE WHEN $9::jsonb IS NULL THEN config ELSE $9::jsonb END,
         metadata = CASE WHEN $10::jsonb IS NULL THEN metadata ELSE $10::jsonb END,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2
     RETURNING *`,
    [
      params.workspaceId,
      params.accountId,
      params.displayName?.trim() || null,
      nextOwnerScope,
      resolvedOwnerUserId,
      nextConnectionMode,
      params.status || null,
      params.credentials ? JSON.stringify(params.credentials) : null,
      params.config ? JSON.stringify(params.config) : null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ],
  );

  return normalizeAccountRow(result.rows[0]);
}

export async function getConversationTransportBinding(params: {
  workspaceId: string;
  conversationId: string;
}) {
  const result = await query(
    `SELECT ctb.id AS binding_id,
            ctb.workspace_id,
            ctb.conversation_id,
            ctb.outbound_enabled,
            ctb.default_target_member_id,
            ctb.metadata AS binding_metadata,
            ctb.created_at AS binding_created_at,
            ctb.updated_at AS binding_updated_at,
            ta.id,
            ta.account_key,
            ta.display_name,
            ta.transport_kind,
            ta.owner_scope,
            ta.owner_user_id,
            ta.connection_mode,
            ta.status,
            ta.credentials,
            ta.config,
            ta.metadata,
            ta.created_at,
            ta.updated_at,
            te.id AS endpoint_id,
            te.transport_account_id,
            te.endpoint_type,
            te.external_id AS endpoint_external_id,
            te.parent_external_id,
            te.display_name AS endpoint_display_name,
            te.metadata AS endpoint_metadata,
            te.created_at AS endpoint_created_at,
            te.updated_at AS endpoint_updated_at
     FROM conversation_transport_bindings ctb
     JOIN transport_accounts ta ON ta.id = ctb.transport_account_id
     JOIN transport_endpoints te ON te.id = ctb.transport_endpoint_id
     WHERE ctb.workspace_id = $1
       AND ctb.conversation_id = $2
     LIMIT $3`,
    [params.workspaceId, params.conversationId, 1],
  );

  return result.rows[0] ? normalizeBindingRow(result.rows[0]) : null;
}

export async function findConversationTransportBindingByEndpoint(params: {
  transportAccountId: string;
  endpointType: TransportEndpointType;
  endpointExternalId: string;
}) {
  const result = await query(
    `SELECT ctb.id AS binding_id,
            ctb.workspace_id,
            ctb.conversation_id,
            ctb.outbound_enabled,
            ctb.default_target_member_id,
            ctb.metadata AS binding_metadata,
            ctb.created_at AS binding_created_at,
            ctb.updated_at AS binding_updated_at,
            ta.id,
            ta.account_key,
            ta.display_name,
            ta.transport_kind,
            ta.owner_scope,
            ta.owner_user_id,
            ta.connection_mode,
            ta.status,
            ta.credentials,
            ta.config,
            ta.metadata,
            ta.created_at,
            ta.updated_at,
            te.id AS endpoint_id,
            te.transport_account_id,
            te.endpoint_type,
            te.external_id AS endpoint_external_id,
            te.parent_external_id,
            te.display_name AS endpoint_display_name,
            te.metadata AS endpoint_metadata,
            te.created_at AS endpoint_created_at,
            te.updated_at AS endpoint_updated_at
     FROM conversation_transport_bindings ctb
     JOIN transport_accounts ta ON ta.id = ctb.transport_account_id
     JOIN transport_endpoints te ON te.id = ctb.transport_endpoint_id
     WHERE ctb.transport_account_id = $1
       AND te.endpoint_type = $2
       AND te.external_id = $3
     LIMIT $4`,
    [
      params.transportAccountId,
      params.endpointType,
      params.endpointExternalId.trim(),
      1,
    ],
  );

  return result.rows[0] ? normalizeBindingRow(result.rows[0]) : null;
}

export async function upsertConversationTransportBinding(params: {
  workspaceId: string;
  conversationId: string;
  transportAccountId: string;
  endpointType: TransportEndpointType;
  endpointExternalId: string;
  parentExternalId?: string;
  endpointDisplayName?: string;
  outboundEnabled?: boolean;
  defaultTargetParticipantId?: string;
  metadata?: Record<string, unknown>;
}) {
  const account = await loadTransportAccountRow(
    params.workspaceId,
    params.transportAccountId,
  );
  if (!account) {
    throw new Error("Transport account not found");
  }

  assertSupportedEndpointType(account.transport_kind, params.endpointType);
  await assertConversationMembers({
    conversationId: params.conversationId,
    memberIds: [params.defaultTargetParticipantId].filter(
      (memberId): memberId is string => Boolean(memberId),
    ),
  });
  await assertConversationMemberType({
    conversationId: params.conversationId,
    memberId: params.defaultTargetParticipantId,
    allowedTypes: ["actor"],
    label: "Default inbound target",
  });

  await transaction(async (client) => {
    const endpointResult = await client.query(
      `INSERT INTO transport_endpoints
         (id, transport_account_id, endpoint_type, external_id, parent_external_id, display_name, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (transport_account_id, endpoint_type, external_id)
       DO UPDATE SET
         parent_external_id = EXCLUDED.parent_external_id,
         display_name = COALESCE(EXCLUDED.display_name, transport_endpoints.display_name),
         metadata = transport_endpoints.metadata || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id`,
      [
        uuidv4(),
        params.transportAccountId,
        params.endpointType,
        params.endpointExternalId.trim(),
        params.parentExternalId?.trim() || null,
        params.endpointDisplayName?.trim() || null,
        JSON.stringify(params.metadata || {}),
      ],
    );
    const endpointId = endpointResult.rows[0]?.id as string;

    await client.query(
      `INSERT INTO conversation_transport_bindings
         (id, workspace_id, conversation_id, transport_account_id, transport_endpoint_id, outbound_enabled, default_target_member_id, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (conversation_id)
       DO UPDATE SET
         transport_account_id = EXCLUDED.transport_account_id,
         transport_endpoint_id = EXCLUDED.transport_endpoint_id,
         outbound_enabled = EXCLUDED.outbound_enabled,
         default_target_member_id = EXCLUDED.default_target_member_id,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        uuidv4(),
        params.workspaceId,
        params.conversationId,
        params.transportAccountId,
        endpointId,
        params.outboundEnabled ?? true,
        params.defaultTargetParticipantId || null,
        JSON.stringify(params.metadata || {}),
      ],
    );
  });

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  });
}

export async function updateConversationTransportSettings(params: {
  workspaceId: string;
  conversationId: string;
  outboundEnabled?: boolean;
  defaultTargetParticipantId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const existing = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  });
  if (!existing) {
    throw new Error("Transport session not found for this conversation");
  }

  await assertConversationMembers({
    conversationId: params.conversationId,
    memberIds: [params.defaultTargetParticipantId].filter(
      (memberId): memberId is string => Boolean(memberId),
    ),
  });
  await assertConversationMemberType({
    conversationId: params.conversationId,
    memberId: params.defaultTargetParticipantId,
    allowedTypes: ["actor"],
    label: "Default inbound target",
  });

  await query(
    `UPDATE conversation_transport_bindings
     SET outbound_enabled = CASE WHEN $3 THEN $4 ELSE outbound_enabled END,
         default_target_member_id = CASE
           WHEN $5 THEN $6::uuid
           ELSE default_target_member_id
         END,
         metadata = CASE
           WHEN $7 THEN metadata || $8::jsonb
           ELSE metadata
         END,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND conversation_id = $2`,
    [
      params.workspaceId,
      params.conversationId,
      params.outboundEnabled !== undefined,
      params.outboundEnabled ?? false,
      params.defaultTargetParticipantId !== undefined,
      params.defaultTargetParticipantId ?? null,
      params.metadata !== undefined,
      JSON.stringify(params.metadata || {}),
    ],
  );

  return getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  });
}

export async function updateTransportSessionSettings(params: {
  workspaceId: string;
  transportEndpointId: string;
  outboundEnabled?: boolean;
  defaultTargetParticipantId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const result = await query(
    `SELECT conversation_id
     FROM conversation_transport_bindings
     WHERE workspace_id = $1
       AND transport_endpoint_id = $2
     LIMIT $3`,
    [params.workspaceId, params.transportEndpointId, 1],
  );
  const conversationId = result.rows[0]?.conversation_id as string | undefined;
  if (!conversationId) {
    throw new Error("Transport session not found");
  }

  await updateConversationTransportSettings({
    workspaceId: params.workspaceId,
    conversationId,
    outboundEnabled: params.outboundEnabled,
    defaultTargetParticipantId: params.defaultTargetParticipantId,
    metadata: params.metadata,
  });

  const updatedSessions = await listTransportSessions(params.workspaceId);
  return (
    updatedSessions.find(
      (session) => session.id === params.transportEndpointId,
    ) || null
  );
}

export async function deleteConversationTransportBinding(params: {
  workspaceId: string;
  conversationId: string;
}) {
  const result = await query(
    `DELETE FROM conversation_transport_bindings
     WHERE workspace_id = $1
       AND conversation_id = $2
     RETURNING id`,
    [params.workspaceId, params.conversationId],
  );
  return Boolean(result.rows[0]);
}

export async function ensureTransportAddress(params: {
  workspaceId: string;
  transportAccountId: string;
  transportKind: TransportKind;
  addressType?: "user" | "bot" | "system";
  externalId: string;
  displayName?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}) {
  const result = await query(
    `INSERT INTO transport_addresses
       (id, workspace_id, transport_account_id, transport_kind, address_type, external_id, display_name, user_id, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (transport_account_id, address_type, external_id)
     DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, transport_addresses.display_name),
       user_id = COALESCE(EXCLUDED.user_id, transport_addresses.user_id),
       metadata = transport_addresses.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      uuidv4(),
      params.workspaceId,
      params.transportAccountId,
      params.transportKind,
      params.addressType || "user",
      params.externalId.trim(),
      params.displayName?.trim() || null,
      params.userId || null,
      JSON.stringify(params.metadata || {}),
    ],
  );
  return result.rows[0] ?? null;
}

export async function getTransportAddressByExternalId(params: {
  transportAccountId: string;
  externalId: string;
  addressType?: "user" | "bot" | "system";
}) {
  const result = await query(
    `SELECT *
     FROM transport_addresses
     WHERE transport_account_id = $1
       AND address_type = $2
       AND external_id = $3
     LIMIT $4`,
    [
      params.transportAccountId,
      params.addressType || "user",
      params.externalId.trim(),
      1,
    ],
  );
  return result.rows[0] ?? null;
}

export async function getTransportAddressById(transportAddressId: string) {
  const result = await query(
    `SELECT *
     FROM transport_addresses
     WHERE id = $1
     LIMIT $2`,
    [transportAddressId, 1],
  );
  return result.rows[0] ?? null;
}

export async function getPrimaryTransportAddressForParticipant(params: {
  conversationMemberId: string;
  transportAccountId?: string;
}) {
  const values: any[] = [params.conversationMemberId];
  let extra = "";
  if (params.transportAccountId) {
    values.push(params.transportAccountId);
    extra = `AND ta.transport_account_id = $${values.length}`;
  }
  values.push(1);
  const result = await query(
    `SELECT ta.*
     FROM conversation_participant_addresses cpa
     JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
     WHERE cpa.conversation_member_id = $1
       ${extra}
     ORDER BY cpa.is_primary DESC, cpa.created_at ASC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function getReachableTransportAddressForParticipant(params: {
  conversationMemberId: string;
  transportAccountId: string;
}) {
  const result = await query(
    `SELECT candidate.*
     FROM (
       SELECT ta.*,
              TRUE AS is_attached,
              cpa.is_primary,
              cpa.created_at AS binding_created_at
       FROM conversation_participant_addresses cpa
       JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
       WHERE cpa.conversation_member_id = $1
         AND ta.transport_account_id = $2

       UNION ALL

       SELECT ta.*,
              FALSE AS is_attached,
              FALSE AS is_primary,
              ta.created_at AS binding_created_at
       FROM conversation_members cm
       JOIN transport_addresses ta
         ON ta.user_id = cm.user_id
        AND ta.address_type = 'user'
       WHERE cm.id = $1
         AND cm.user_id IS NOT NULL
         AND ta.transport_account_id = $2
     ) candidate
     ORDER BY candidate.is_attached DESC,
              candidate.is_primary DESC,
              candidate.binding_created_at ASC
     LIMIT $3`,
    [params.conversationMemberId, params.transportAccountId, 1],
  );
  return result.rows[0] ?? null;
}

async function removeConversationParticipantTransportAddress(params: {
  conversationMemberId: string;
  transportAddressId: string;
}) {
  await query(
    `DELETE FROM conversation_participant_addresses
     WHERE conversation_member_id = $1
       AND transport_address_id = $2`,
    [params.conversationMemberId, params.transportAddressId],
  );
}

async function archiveConversationMemberIfOrphaned(
  conversationMemberId: string,
) {
  const result = await query(
    `SELECT cm.member_type,
            cm.state,
            EXISTS (
              SELECT 1
              FROM conversation_participant_addresses cpa
              WHERE cpa.conversation_member_id = cm.id
            ) AS has_addresses
     FROM conversation_members cm
     WHERE cm.id = $1
     LIMIT $2`,
    [conversationMemberId, 1],
  );
  const row = result.rows[0];
  if (!row) return;
  if (
    row.member_type !== "external" ||
    row.state !== "active" ||
    row.has_addresses
  ) {
    return;
  }

  await query(
    `UPDATE conversation_members
     SET state = 'left',
         left_at = COALESCE(left_at, NOW()),
         metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [conversationMemberId, JSON.stringify({ retiredByTransportLink: true })],
  );
}

export async function syncTransportAddressConversationMember(params: {
  conversationId: string;
  transportAddressId: string;
  userId?: string | null;
  displayName?: string;
  recordJoinEvent?: boolean;
}) {
  const address = await getTransportAddressById(params.transportAddressId);
  if (!address) {
    throw new Error("Transport external user not found");
  }

  const desiredMember = params.userId
    ? (
        await activateConversationParticipant({
          workspaceId: address.workspace_id,
          conversationId: params.conversationId,
          memberType: "user",
          userId: params.userId,
          recordJoinEvent: params.recordJoinEvent,
        })
      ).member
    : (
        await activateConversationParticipant({
          workspaceId: address.workspace_id,
          conversationId: params.conversationId,
          memberType: "external",
          displayName:
            params.displayName ||
            address.display_name ||
            address.external_id ||
            "External user",
          metadata: {
            externalUserKey: `${address.transport_kind}:${address.external_id}`,
          },
          recordJoinEvent: params.recordJoinEvent,
        })
      ).member;

  await ensureConversationParticipantTransportAddress({
    conversationMemberId: desiredMember.id,
    transportAddressId: address.id,
    isPrimary: true,
  });

  const attachedMembers = await query(
    `SELECT cm.id, cm.member_type
     FROM conversation_participant_addresses cpa
     JOIN conversation_members cm ON cm.id = cpa.conversation_member_id
     WHERE cpa.transport_address_id = $1
       AND cm.conversation_id = $2
       AND cm.id <> $3`,
    [address.id, params.conversationId, desiredMember.id],
  );

  for (const row of attachedMembers.rows) {
    await removeConversationParticipantTransportAddress({
      conversationMemberId: row.id,
      transportAddressId: address.id,
    });
    await archiveConversationMemberIfOrphaned(row.id);
  }

  return desiredMember;
}

async function listConversationIdsForTransportAddress(
  transportAddressId: string,
) {
  const result = await query(
    `SELECT DISTINCT cm.conversation_id
     FROM conversation_participant_addresses cpa
     JOIN conversation_members cm ON cm.id = cpa.conversation_member_id
     WHERE cpa.transport_address_id = $1`,
    [transportAddressId],
  );
  return result.rows
    .map((row) => row.conversation_id as string)
    .filter(Boolean);
}

async function syncTransportAddressLinkedUserMemberships(params: {
  transportAddressId: string;
  userId?: string | null;
}) {
  const conversationIds = await listConversationIdsForTransportAddress(
    params.transportAddressId,
  );
  for (const conversationId of conversationIds) {
    await syncTransportAddressConversationMember({
      conversationId,
      transportAddressId: params.transportAddressId,
      userId: params.userId || null,
      recordJoinEvent: false,
    });
  }
}

async function loadConversationExternalMemberPrimaryAddress(params: {
  workspaceId: string;
  conversationId: string;
  conversationMemberId: string;
}) {
  const result = await query(
    `SELECT cm.id AS conversation_member_id,
            primary_address.id AS transport_address_id
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN LATERAL (
       SELECT ta.id
       FROM conversation_participant_addresses cpa
       JOIN transport_addresses ta ON ta.id = cpa.transport_address_id
       WHERE cpa.conversation_member_id = cm.id
       ORDER BY cpa.is_primary DESC, cpa.created_at ASC
       LIMIT 1
     ) primary_address ON TRUE
     WHERE c.workspace_id = $1
       AND cm.conversation_id = $2
       AND cm.id = $3
       AND cm.member_type = 'external'
     LIMIT $4`,
    [params.workspaceId, params.conversationId, params.conversationMemberId, 1],
  );
  return result.rows[0] ?? null;
}

async function assertWorkspaceMember(params: {
  workspaceId: string;
  userId: string;
}) {
  const result = await query(
    `SELECT 1
     FROM workspace_members
     WHERE workspace_id = $1
       AND user_id = $2
     LIMIT $3`,
    [params.workspaceId, params.userId, 1],
  );
  return Boolean(result.rows[0]);
}

export async function setConversationExternalMemberLinkedUser(params: {
  workspaceId: string;
  conversationId: string;
  conversationMemberId: string;
  userId?: string | null;
}) {
  const memberAddress = await loadConversationExternalMemberPrimaryAddress({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    conversationMemberId: params.conversationMemberId,
  });
  if (!memberAddress) {
    throw new Error("External participant not found in this conversation");
  }
  if (!memberAddress.transport_address_id) {
    throw new Error("External participant does not have a transport address");
  }

  return setTransportAddressLinkedUser({
    workspaceId: params.workspaceId,
    transportAddressId: memberAddress.transport_address_id as string,
    userId: params.userId,
  });
}

export async function setTransportAddressLinkedUser(params: {
  workspaceId: string;
  transportAddressId: string;
  userId?: string | null;
}) {
  const nextUserId = params.userId || null;
  if (nextUserId) {
    const isWorkspaceMember = await assertWorkspaceMember({
      workspaceId: params.workspaceId,
      userId: nextUserId,
    });
    if (!isWorkspaceMember) {
      throw new Error("Workspace user not found");
    }
  }

  const result = await query(
    `UPDATE transport_addresses
     SET user_id = $3,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2
       AND address_type = 'user'
     RETURNING *`,
    [params.workspaceId, params.transportAddressId, nextUserId],
  );
  if (!result.rows[0]) {
    throw new Error("Transport external user not found");
  }

  await syncTransportAddressLinkedUserMemberships({
    transportAddressId: params.transportAddressId,
    userId: nextUserId,
  });

  return result.rows[0] ?? null;
}

export async function ensureConversationParticipantTransportAddress(params: {
  conversationMemberId: string;
  transportAddressId: string;
  isPrimary?: boolean;
  metadata?: Record<string, unknown>;
}) {
  if (params.isPrimary) {
    await query(
      `UPDATE conversation_participant_addresses
       SET is_primary = FALSE,
           updated_at = NOW()
       WHERE conversation_member_id = $1`,
      [params.conversationMemberId],
    );
  }

  const result = await query(
    `INSERT INTO conversation_participant_addresses
       (conversation_member_id, transport_address_id, is_primary, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (conversation_member_id, transport_address_id)
     DO UPDATE SET
       is_primary = CASE
         WHEN EXCLUDED.is_primary THEN TRUE
         ELSE conversation_participant_addresses.is_primary
       END,
       metadata = conversation_participant_addresses.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      params.conversationMemberId,
      params.transportAddressId,
      params.isPrimary ?? false,
      JSON.stringify(params.metadata || {}),
    ],
  );
  return result.rows[0] ?? null;
}

export async function updateTransportAddressMetadata(params: {
  transportAddressId: string;
  metadata: Record<string, unknown>;
}) {
  const result = await query(
    `UPDATE transport_addresses
     SET metadata = metadata || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [params.transportAddressId, JSON.stringify(params.metadata || {})],
  );
  return result.rows[0] ?? null;
}

export async function updateTransportEndpointMetadata(params: {
  endpointId: string;
  metadata: Record<string, unknown>;
}) {
  const result = await query(
    `UPDATE transport_endpoints
     SET metadata = metadata || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [params.endpointId, JSON.stringify(params.metadata || {})],
  );
  return result.rows[0] ?? null;
}

export async function queueConversationTransportProjection(params: {
  workspaceId: string;
  conversationId: string;
  itemId: string;
  direction?: "inbound" | "outbound";
  externalMessageId?: string;
  metadata?: Record<string, unknown>;
}) {
  const direction = params.direction || "outbound";
  const binding = await getConversationTransportBinding({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
  });
  if (!binding) {
    return null;
  }
  if (direction === "outbound" && !binding.outboundEnabled) {
    return null;
  }

  const result = await query(
    `INSERT INTO transport_message_links
       (id, workspace_id, conversation_id, item_id, transport_account_id, transport_endpoint_id, transport_kind, direction, delivery_status, external_message_id, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, NOW(), NOW())
     ON CONFLICT (item_id, transport_endpoint_id, direction)
     DO UPDATE SET
       external_message_id = COALESCE(EXCLUDED.external_message_id, transport_message_links.external_message_id),
       metadata = transport_message_links.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      uuidv4(),
      params.workspaceId,
      params.conversationId,
      params.itemId,
      binding.account.id,
      binding.endpoint.id,
      binding.transportKind,
      direction,
      params.externalMessageId || null,
      JSON.stringify({
        bindingId: binding.id,
        endpointType: binding.endpoint.endpointType,
        endpointExternalId: binding.endpoint.externalId,
        ...(params.metadata || {}),
      }),
    ],
  );

  const link = result.rows[0] ?? null;
  if (link && direction === "outbound") {
    await enqueueTransportDeliveryJobs([link.id]).catch((error) => {
      console.error(
        `[im] Failed to enqueue transport delivery job for link ${link.id}:`,
        error,
      );
    });
  }

  return link;
}

export async function findTransportMessageLinkByExternalMessage(params: {
  transportAccountId: string;
  transportEndpointId?: string;
  externalMessageId: string;
  direction: "inbound" | "outbound";
}) {
  const values: any[] = [
    params.transportAccountId,
    params.externalMessageId.trim(),
    params.direction,
  ];
  const endpointFilter = params.transportEndpointId
    ? `AND transport_endpoint_id = $4`
    : "";
  if (params.transportEndpointId) {
    values.push(params.transportEndpointId);
  }
  const result = await query(
    `SELECT *
     FROM transport_message_links
     WHERE transport_account_id = $1
       AND external_message_id = $2
       AND direction = $3
       ${endpointFilter}
     LIMIT 1`,
    values,
  );
  return result.rows[0]
    ? normalizeTransportMessageLinkRow(result.rows[0])
    : null;
}

export async function updateTransportMessageLinkStatus(params: {
  linkId: string;
  status: TransportDeliveryStatus;
  externalMessageId?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}) {
  const result = await query(
    `UPDATE transport_message_links
     SET delivery_status = $2::varchar,
         external_message_id = COALESCE($3, external_message_id),
         metadata = metadata || $4::jsonb,
         delivered_at = CASE
           WHEN $2::varchar = 'sent' THEN COALESCE(delivered_at, NOW())
           ELSE delivered_at
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      params.linkId,
      params.status,
      params.externalMessageId || null,
      JSON.stringify({
        ...(params.metadata || {}),
        ...(params.error ? { lastError: params.error } : {}),
      }),
    ],
  );
  return result.rows[0]
    ? normalizeTransportMessageLinkRow(result.rows[0])
    : null;
}

export async function loadTransportMessageLinkForDelivery(linkId: string) {
  const result = await query(
    `SELECT tml.*,
            ta.workspace_id AS account_workspace_id,
            ta.account_key,
            ta.display_name AS account_display_name,
            ta.owner_scope,
            ta.owner_user_id,
            ta.connection_mode,
            ta.status AS account_status,
            ta.credentials,
            ta.config,
            ta.metadata AS account_metadata,
            ta.created_at AS account_created_at,
            ta.updated_at AS account_updated_at,
            te.endpoint_type,
            te.external_id AS endpoint_external_id,
            te.parent_external_id,
            te.display_name AS endpoint_display_name,
            te.metadata AS endpoint_metadata,
            te.created_at AS endpoint_created_at,
            te.updated_at AS endpoint_updated_at,
            ci.metadata AS item_metadata
     FROM transport_message_links tml
     JOIN transport_accounts ta ON ta.id = tml.transport_account_id
     JOIN transport_endpoints te ON te.id = tml.transport_endpoint_id
     JOIN conversation_items ci ON ci.id = tml.item_id
     WHERE tml.id = $1
     LIMIT $2`,
    [linkId, 1],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    ...normalizeTransportMessageLinkRow(row),
    account: normalizeAccountRow({
      id: row.transport_account_id,
      workspace_id: row.account_workspace_id,
      transport_kind: row.transport_kind,
      account_key: row.account_key,
      display_name: row.account_display_name,
      owner_scope: row.owner_scope,
      owner_user_id: row.owner_user_id,
      connection_mode: row.connection_mode,
      status: row.account_status,
      credentials: row.credentials,
      config: row.config,
      metadata: row.account_metadata,
      created_at: row.account_created_at,
      updated_at: row.account_updated_at,
    }),
    endpoint: normalizeEndpointRow(
      {
        endpoint_id: row.transport_endpoint_id,
        transport_account_id: row.transport_account_id,
        endpoint_type: row.endpoint_type,
        endpoint_external_id: row.endpoint_external_id,
        parent_external_id: row.parent_external_id,
        endpoint_display_name: row.endpoint_display_name,
        endpoint_metadata: row.endpoint_metadata,
        endpoint_created_at: row.endpoint_created_at,
        endpoint_updated_at: row.endpoint_updated_at,
      },
      row.transport_kind,
    ),
    itemMetadata: parseJsonObject(row.item_metadata),
  };
}
