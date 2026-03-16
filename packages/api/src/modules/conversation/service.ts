import { query, transaction } from '../../infrastructure/database/index.js';
import { v4 as uuidv4 } from 'uuid';
import type {
  ConversationEntityRef,
  ConversationFeedEventItem,
  ConversationFeedEventPayloadMap,
  ConversationFeedEventType,
  ConversationFeedItem,
  ConversationFeedMessageItem,
  ConversationEventContextPolicy,
  ConversationEventTimelinePolicy,
} from '@synapse/shared/types';
import { extractText } from '@synapse/shared';
import { buildNormalizedMessageContent } from './message-content.js';
import { itemPartsToCanonicalContentBlocks } from './message-content.js';
import {
  getConversationEventSpec,
  renderConversationEventTimelineBlocks,
} from './event-registry.js';

export type ConversationKind = 'group' | 'direct' | 'a2a_virtual';
export type ItemScope = 'shared' | 'private';
export type ItemSurface = 'visible' | 'internal';
export type ItemType = 'message' | 'event' | 'summary' | 'control';
export type ItemRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ItemPartInput {
  type: 'text' | 'file_ref' | 'json';
  text?: string;
  fileId?: string;
  json?: unknown;
  mimeType?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationItemParams {
  workspaceId: string;
  conversationId: string;
  sessionId?: string;
  turnId?: string;
  clientMessageId?: string;
  scope: ItemScope;
  surface: ItemSurface;
  itemType: ItemType;
  subtype: string;
  role: ItemRole;
  authorMemberId?: string;
  bundleId?: string;
  replyToItemId?: string;
  causedByItemId?: string;
  eventPayload?: Record<string, unknown>;
  eventTimelinePolicy?: ConversationEventTimelinePolicy;
  eventContextPolicy?: ConversationEventContextPolicy;
  metadata?: Record<string, unknown>;
  parts?: ItemPartInput[];
  targetMemberIds?: string[];
  contextTargetMemberIds?: string[];
}

export interface CreateConversationEventParams<
  T extends ConversationFeedEventType = ConversationFeedEventType,
> {
  workspaceId: string;
  conversationId: string;
  sessionId?: string;
  turnId?: string;
  eventType: T;
  authorMemberId?: string;
  metadata?: Record<string, unknown>;
  eventPayload?: ConversationFeedEventPayloadMap[T];
  timelinePolicy?: ConversationEventTimelinePolicy;
  contextPolicy?: ConversationEventContextPolicy;
  targetMemberIds?: string[];
  contextTargetMemberIds?: string[];
}

export async function createConversation(params: {
  workspaceId: string;
  kind: ConversationKind;
  title?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}) {
  const result = await query(
    `INSERT INTO conversations (id, workspace_id, kind, title, created_by, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [
      uuidv4(),
      params.workspaceId,
      params.kind,
      params.title || null,
      params.createdBy || null,
      JSON.stringify(params.metadata || {}),
    ],
  );

  return result.rows[0];
}

export async function getConversation(conversationId: string) {
  const result = await query(
    `SELECT * FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return result.rows[0] ?? null;
}

export async function ensureConversationMember(params: {
  conversationId: string;
  memberType: 'actor' | 'user' | 'remote_agent' | 'system';
  actorId?: string;
  userId?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}) {
  const { conversationId, memberType, actorId, userId, displayName, metadata = {} } = params;
  let existing;

  if (memberType === 'actor') {
    existing = await query(
      `SELECT * FROM conversation_members
       WHERE conversation_id = $1 AND actor_id = $2
       LIMIT 1`,
      [conversationId, actorId || null],
    );
  } else if (memberType === 'user') {
    existing = await query(
      `SELECT * FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
      [conversationId, userId || null],
    );
  } else {
    existing = await query(
      `SELECT * FROM conversation_members
       WHERE conversation_id = $1
         AND member_type = $2
         AND COALESCE(display_name, '') = COALESCE($3, '')
       LIMIT 1`,
      [conversationId, memberType, displayName || null],
    );
  }

  if (existing.rows[0]) {
    if (existing.rows[0].state !== 'active') {
      const revived = await query(
        `UPDATE conversation_members
         SET state = 'active', left_at = NULL, metadata = metadata || $2::jsonb
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id, JSON.stringify(metadata)],
      );
      return revived.rows[0];
    }
    return existing.rows[0];
  }

  const result = await query(
    `INSERT INTO conversation_members
       (id, conversation_id, member_type, actor_id, user_id, display_name, state, metadata, joined_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NOW())
     RETURNING *`,
    [
      uuidv4(),
      conversationId,
      memberType,
      actorId || null,
      userId || null,
      displayName || null,
      JSON.stringify(metadata),
    ],
  );

  return result.rows[0];
}

export async function getConversationMember(params: {
  conversationId: string;
  actorId?: string;
  userId?: string;
}) {
  const { conversationId, actorId, userId } = params;
  let result;
  if (actorId) {
    result = await query(
      `SELECT * FROM conversation_members
       WHERE conversation_id = $1 AND actor_id = $2
       LIMIT 1`,
      [conversationId, actorId],
    );
  } else if (userId) {
    result = await query(
      `SELECT * FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2
       LIMIT 1`,
      [conversationId, userId],
    );
  } else {
    return null;
  }
  return result.rows[0] ?? null;
}

export async function listConversationMembers(conversationId: string) {
  const result = await query(
    `SELECT cm.*,
            a.name AS actor_name,
            a.title AS actor_title,
            a.role AS actor_role,
            u.name AS user_name
     FROM conversation_members cm
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1
     ORDER BY cm.joined_at ASC`,
    [conversationId],
  );
  return result.rows;
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))];
}

async function resolveEventTimelineTargets(params: {
  conversationId: string;
  timelinePolicy: ConversationEventTimelinePolicy;
  explicitTargetMemberIds?: string[];
}) {
  if (params.timelinePolicy === 'none' || params.timelinePolicy === 'all_members') {
    return [];
  }

  const members = await listConversationMembers(params.conversationId);
  if (params.timelinePolicy === 'targeted_members') {
    return uniqueIds(params.explicitTargetMemberIds || []);
  }

  if (params.timelinePolicy === 'users_only') {
    return uniqueIds(
      members
        .filter((member: any) => member.state === 'active' && member.user_id)
        .map((member: any) => member.id),
    );
  }

  if (params.timelinePolicy === 'actors_only') {
    return uniqueIds(
      members
        .filter((member: any) => member.state === 'active' && member.actor_id)
        .map((member: any) => member.id),
    );
  }

  return [];
}

async function resolveEventContextTargets(params: {
  conversationId: string;
  contextPolicy: ConversationEventContextPolicy;
  explicitContextTargetMemberIds?: string[];
}) {
  if (params.contextPolicy === 'none') {
    return [];
  }

  const members = await listConversationMembers(params.conversationId);
  if (params.contextPolicy === 'shared') {
    return uniqueIds(
      members
        .filter((member: any) => member.state === 'active' && member.actor_id)
        .map((member: any) => member.id),
    );
  }

  const explicitTargets = uniqueIds(params.explicitContextTargetMemberIds || []);
  if (explicitTargets.length === 0) {
    return [];
  }

  const activeActorTargets = new Set(
    members
      .filter((member: any) => member.state === 'active' && member.actor_id)
      .map((member: any) => member.id),
  );

  return explicitTargets.filter((targetMemberId) => activeActorTargets.has(targetMemberId));
}

export async function createConversationItem(params: CreateConversationItemParams) {
  return transaction(async (client) => {
    const itemId = uuidv4();
    const itemResult = await client.query(
      `INSERT INTO conversation_items
         (id, conversation_id, session_id, turn_id, client_message_id, scope, surface, item_type, subtype, role,
          author_member_id, bundle_id, reply_to_item_id, caused_by_item_id, event_payload,
          event_timeline_policy, event_context_policy, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
       RETURNING *`,
      [
        itemId,
        params.conversationId,
        params.sessionId || null,
        params.turnId || null,
        params.clientMessageId || null,
        params.scope,
        params.surface,
        params.itemType,
        params.subtype,
        params.role,
        params.authorMemberId || null,
        params.bundleId || null,
        params.replyToItemId || null,
        params.causedByItemId || null,
        JSON.stringify(params.eventPayload || {}),
        params.eventTimelinePolicy || null,
        params.eventContextPolicy || null,
        JSON.stringify(params.metadata || {}),
      ],
    );

    if (params.parts && params.parts.length > 0) {
      let ordinal = 0;
      for (const part of params.parts) {
        await client.query(
          `INSERT INTO conversation_item_parts
             (id, item_id, ordinal, part_type, text_value, file_id, json_value, mime_type, name, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            uuidv4(),
            itemId,
            ordinal++,
            part.type,
            part.type === 'text' ? part.text || '' : null,
            part.type === 'file_ref' ? part.fileId || null : null,
            part.type === 'json' ? JSON.stringify(part.json ?? {}) : null,
            part.mimeType || null,
            part.name || null,
            JSON.stringify(part.metadata || {}),
          ],
        );
      }
    }

    if (params.targetMemberIds && params.targetMemberIds.length > 0) {
      for (const targetMemberId of params.targetMemberIds) {
        await client.query(
          `INSERT INTO conversation_item_targets (item_id, target_member_id, target_kind)
           VALUES ($1, $2, 'to')`,
          [itemId, targetMemberId],
        );
      }
    }

    if (params.contextTargetMemberIds && params.contextTargetMemberIds.length > 0) {
      for (const targetMemberId of params.contextTargetMemberIds) {
        await client.query(
          `INSERT INTO conversation_item_context_targets (item_id, target_member_id)
           VALUES ($1, $2)`,
          [itemId, targetMemberId],
        );
      }
    }

    await client.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [params.conversationId],
    );

    const item = itemResult.rows[0];
    let workspaceSequence: number | undefined;
    if (params.scope === 'shared' && params.surface === 'visible') {
      const feedResult = await client.query(
        `INSERT INTO realtime_feed_events
           (id, workspace_id, conversation_id, item_id, conversation_sequence, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING workspace_sequence`,
        [
          uuidv4(),
          params.workspaceId,
          params.conversationId,
          itemId,
          item.sequence,
        ],
      );
      workspaceSequence = Number(feedResult.rows[0]?.workspace_sequence);
    }

    return {
      ...item,
      workspace_sequence: workspaceSequence,
    };
  });
}

export async function createConversationEvent(params: CreateConversationEventParams) {
  const spec = getConversationEventSpec(params.eventType);
  const timelinePolicy = params.timelinePolicy || spec.timelinePolicy;
  const contextPolicy = params.contextPolicy || spec.contextPolicy;
  const eventPayload = params.eventPayload || {};

  const timelineTargetMemberIds = await resolveEventTimelineTargets({
    conversationId: params.conversationId,
    timelinePolicy,
    explicitTargetMemberIds: params.targetMemberIds,
  });
  const contextTargetMemberIds = await resolveEventContextTargets({
    conversationId: params.conversationId,
    contextPolicy,
    explicitContextTargetMemberIds: params.contextTargetMemberIds,
  });

  const normalizedTimeline = await buildNormalizedMessageContent({
    content: '',
    contentBlocks: renderConversationEventTimelineBlocks(params.eventType, eventPayload),
    metadata: params.metadata || {},
  });

  const item = await createConversationItem({
    workspaceId: params.workspaceId,
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    turnId: params.turnId,
    scope: 'shared',
    surface: timelinePolicy === 'none' ? 'internal' : 'visible',
    itemType: 'event',
    subtype: params.eventType,
    role: 'system',
    authorMemberId: params.authorMemberId,
    eventPayload,
    eventTimelinePolicy: timelinePolicy,
    eventContextPolicy: contextPolicy,
    metadata: params.metadata || {},
    parts: normalizedTimeline.parts,
    targetMemberIds: timelineTargetMemberIds,
    contextTargetMemberIds,
  });

  return {
    item,
    timelinePolicy,
    contextPolicy,
    timelineTargetMemberIds,
    contextTargetMemberIds,
    timelineContent: normalizedTimeline.normalizedContent,
    timelineContentBlocks: normalizedTimeline.contentBlocks,
    metadata: normalizedTimeline.normalizedMetadata,
    eventPayload,
  };
}

export async function markConversationRead(userId: string, conversationId: string, lastReadItemId?: string) {
  await query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_item_id, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, conversation_id)
     DO UPDATE SET last_read_item_id = EXCLUDED.last_read_item_id, last_read_at = NOW()`,
    [userId, conversationId, lastReadItemId || null],
  );
}

async function loadItemsWithRelations(itemRows: any[]) {
  if (itemRows.length === 0) return [];

  const itemIds = itemRows.map((row) => row.id);
  const feedEventsResult = await query(
    `SELECT item_id, workspace_sequence
     FROM realtime_feed_events
     WHERE item_id = ANY($1)`,
    [itemIds],
  );
  const partsResult = await query(
    `SELECT cip.*,
            f.original_name,
            f.stored_name,
            f.mime_type AS file_mime_type,
            f.size_bytes
     FROM conversation_item_parts cip
     LEFT JOIN files f ON f.id = cip.file_id
     WHERE cip.item_id = ANY($1)
     ORDER BY cip.item_id, cip.ordinal ASC`,
    [itemIds],
  );

  const targetsResult = await query(
    `SELECT cit.item_id,
            cit.target_kind,
            cm.id AS member_id,
            cm.member_type,
            cm.actor_id,
            cm.user_id,
            COALESCE(a.name, u.name, cm.display_name) AS member_name
     FROM conversation_item_targets cit
     JOIN conversation_members cm ON cm.id = cit.target_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cit.item_id = ANY($1)
     ORDER BY cit.item_id`,
    [itemIds],
  );

  const contextTargetsResult = await query(
    `SELECT cict.item_id,
            cm.id AS member_id,
            cm.member_type,
            cm.actor_id,
            cm.user_id,
            COALESCE(a.name, u.name, cm.display_name) AS member_name
     FROM conversation_item_context_targets cict
     JOIN conversation_members cm ON cm.id = cict.target_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cict.item_id = ANY($1)
     ORDER BY cict.item_id`,
    [itemIds],
  );

  const partsByItem = new Map<string, any[]>();
  for (const row of partsResult.rows) {
    if (!partsByItem.has(row.item_id)) partsByItem.set(row.item_id, []);
    partsByItem.get(row.item_id)!.push(row);
  }

  const targetsByItem = new Map<string, any[]>();
  for (const row of targetsResult.rows) {
    if (!targetsByItem.has(row.item_id)) targetsByItem.set(row.item_id, []);
    targetsByItem.get(row.item_id)!.push(row);
  }

  const contextTargetsByItem = new Map<string, any[]>();
  for (const row of contextTargetsResult.rows) {
    if (!contextTargetsByItem.has(row.item_id)) contextTargetsByItem.set(row.item_id, []);
    contextTargetsByItem.get(row.item_id)!.push(row);
  }

  const feedEventByItem = new Map<string, number>();
  for (const row of feedEventsResult.rows) {
    feedEventByItem.set(row.item_id, Number(row.workspace_sequence));
  }

  return itemRows.map((row) => ({
    ...row,
    workspace_sequence: feedEventByItem.get(row.id),
    parts: partsByItem.get(row.id) || [],
    targets: targetsByItem.get(row.id) || [],
    context_targets: contextTargetsByItem.get(row.id) || [],
  }));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {};
}

function mapEntityRef(row: any): ConversationEntityRef | undefined {
  if (!row) return undefined;
  const memberType = row.member_type || row.author_member_type;
  if (!memberType) return undefined;
  return {
    memberId: row.member_id || row.author_member_id || row.id,
    memberType,
    actorId: row.actor_id || row.author_actor_id || undefined,
    userId: row.user_id || row.author_user_id || undefined,
    name: row.member_name || row.author_name || undefined,
    title: row.title || row.actor_title || undefined,
    role: row.role || row.actor_role || undefined,
    avatarUrl: row.avatar_url || undefined,
    avatarEmoji: row.avatar_emoji || undefined,
  };
}

function mapTargets(rows: any[]): ConversationEntityRef[] {
  return rows
    .map((row) => mapEntityRef(row))
    .filter((row): row is ConversationEntityRef => Boolean(row));
}

function buildTextContentFromParts(parts: any[]) {
  return extractText(itemPartsToCanonicalContentBlocks(parts || []));
}

export function conversationItemRowToFeedItem(row: any): ConversationFeedItem {
  const author = mapEntityRef({
    author_member_id: row.author_member_id,
    author_member_type: row.author_member_type,
    author_actor_id: row.author_actor_id,
    author_user_id: row.author_user_id,
    author_name: row.author_name,
  });
  const base = {
    itemId: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    workspaceSequence: row.workspace_sequence ? Number(row.workspace_sequence) : undefined,
    sessionId: row.session_id || undefined,
    turnId: row.turn_id || undefined,
    author,
    createdAt: row.created_at,
  };

  if (row.item_type === 'event') {
    return {
      kind: 'event',
      ...base,
      causedByItemId: row.caused_by_item_id || undefined,
      eventType: row.subtype,
      payload: parseJsonObject(row.event_payload) as ConversationFeedEventItem['payload'],
      fallbackText: buildTextContentFromParts(row.parts || []),
    };
  }

  return {
    kind: 'message',
    ...base,
    role: row.role,
    targets: mapTargets(row.targets || []),
    content: buildTextContentFromParts(row.parts || []),
    contentBlocks: itemPartsToCanonicalContentBlocks(row.parts || []),
    metadata: parseJsonObject(row.metadata),
    clientMessageId: row.client_message_id || undefined,
  } satisfies ConversationFeedMessageItem;
}

export async function getConversationFeedItemById(itemId: string) {
  const result = await query(
    `SELECT ci.*,
            cm.member_type AS author_member_type,
            cm.actor_id AS author_actor_id,
            cm.user_id AS author_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.id = $1
     LIMIT 1`,
    [itemId],
  );
  const [item] = await loadItemsWithRelations(result.rows);
  return item ? conversationItemRowToFeedItem(item) : null;
}

export async function listWorkspaceFeedEventsAfter(params: {
  workspaceId: string;
  conversationIds: string[];
  afterSequence: number;
  limit?: number;
}) {
  if (params.conversationIds.length === 0) {
    return [] as Array<{ workspaceSequence: number; item: ConversationFeedItem }>;
  }

  const result = await query(
    `SELECT rfe.workspace_sequence,
            ci.*,
            cm.member_type AS author_member_type,
            cm.actor_id AS author_actor_id,
            cm.user_id AS author_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM realtime_feed_events rfe
     JOIN conversation_items ci ON ci.id = rfe.item_id
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE rfe.workspace_id = $1
       AND rfe.conversation_id = ANY($2)
       AND rfe.workspace_sequence > $3
     ORDER BY rfe.workspace_sequence ASC
     LIMIT $4`,
    [
      params.workspaceId,
      params.conversationIds,
      params.afterSequence,
      params.limit || 500,
    ],
  );

  const items = await loadItemsWithRelations(result.rows);
  return items.map((item) => ({
    workspaceSequence: Number(item.workspace_sequence || 0),
    item: conversationItemRowToFeedItem(item),
  }));
}

export async function getVisibleConversationItemsForMember(params: {
  conversationId: string;
  memberId: string;
  beforeSequence?: number;
  limit?: number;
}) {
  const { conversationId, memberId, beforeSequence, limit = 200 } = params;
  const values: any[] = [conversationId, memberId];
  let extra = '';
  if (beforeSequence !== undefined) {
    values.push(beforeSequence);
    extra += ` AND ci.sequence < $${values.length}`;
  }
  values.push(limit);

  const items = await query(
    `SELECT ci.*,
            c.kind AS conversation_kind,
            cm.member_type AS author_member_type,
            cm.actor_id AS author_actor_id,
            cm.user_id AS author_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     JOIN conversations c ON c.id = ci.conversation_id
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.conversation_id = $1
       AND ci.scope = 'shared'
       AND ci.surface = 'visible'
       AND (
         (c.kind = 'group' AND ci.item_type = 'message')
         OR ci.author_member_id = $2
         OR NOT EXISTS (SELECT 1 FROM conversation_item_targets cit0 WHERE cit0.item_id = ci.id)
         OR EXISTS (
           SELECT 1 FROM conversation_item_targets cit
           WHERE cit.item_id = ci.id AND cit.target_member_id = $2
         )
       )
       ${extra}
     ORDER BY ci.sequence DESC
     LIMIT $${values.length}`,
    values,
  );

  const loaded = await loadItemsWithRelations(items.rows);
  return loaded.reverse();
}

export async function getContextConversationItemsForMember(params: {
  conversationId: string;
  memberId: string;
  beforeSequence?: number;
  limit?: number;
}) {
  const { conversationId, memberId, beforeSequence, limit = 200 } = params;
  const values: any[] = [conversationId, memberId];
  let extra = '';
  if (beforeSequence !== undefined) {
    values.push(beforeSequence);
    extra += ` AND ci.sequence < $${values.length}`;
  }
  values.push(limit);

  const items = await query(
    `SELECT ci.*,
            c.kind AS conversation_kind,
            cm.member_type AS author_member_type,
            cm.actor_id AS author_actor_id,
            cm.user_id AS author_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     JOIN conversations c ON c.id = ci.conversation_id
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.conversation_id = $1
      AND ci.scope = 'shared'
       AND (
         (
           ci.surface = 'visible'
           AND (
             (c.kind = 'group' AND ci.item_type = 'message')
             OR ci.author_member_id = $2
             OR NOT EXISTS (SELECT 1 FROM conversation_item_targets cit0 WHERE cit0.item_id = ci.id)
             OR EXISTS (
               SELECT 1 FROM conversation_item_targets cit
               WHERE cit.item_id = ci.id AND cit.target_member_id = $2
             )
           )
         )
         OR EXISTS (
           SELECT 1 FROM conversation_item_context_targets cict
           WHERE cict.item_id = ci.id AND cict.target_member_id = $2
         )
       )
       ${extra}
     ORDER BY ci.sequence DESC
     LIMIT $${values.length}`,
    values,
  );

  const loaded = await loadItemsWithRelations(items.rows);
  return loaded.reverse();
}

export async function getPrivateSessionItems(sessionId: string) {
  const items = await query(
    `SELECT ci.*,
            cm.member_type AS author_member_type,
            cm.actor_id AS author_actor_id,
            cm.user_id AS author_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.session_id = $1
       AND ci.scope = 'private'
     ORDER BY ci.created_at ASC, ci.sequence ASC`,
    [sessionId],
  );

  return loadItemsWithRelations(items.rows);
}

export async function getLastVisibleConversationItem(conversationId: string) {
  const items = await query(
    `SELECT ci.*,
            cm.member_type AS author_member_type,
            cm.actor_id AS author_actor_id,
            cm.user_id AS author_user_id,
            COALESCE(a.name, u.name, cm.display_name) AS author_name
     FROM conversation_items ci
     LEFT JOIN conversation_members cm ON cm.id = ci.author_member_id
     LEFT JOIN actors a ON a.id = cm.actor_id
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE ci.conversation_id = $1
       AND ci.scope = 'shared'
       AND ci.surface = 'visible'
     ORDER BY ci.sequence DESC
     LIMIT 1`,
    [conversationId],
  );

  const [item] = await loadItemsWithRelations(items.rows);
  return item || null;
}

export async function listUserGroupConversations(workspaceId: string, userId: string) {
  const result = await query(
    `SELECT c.*,
            cr.last_read_at,
            (
              SELECT COUNT(*)::int
              FROM conversation_items ci
              JOIN conversation_members cm_u ON cm_u.conversation_id = c.id AND cm_u.user_id = $2
              WHERE ci.conversation_id = c.id
                AND ci.scope = 'shared'
                AND ci.surface = 'visible'
                AND ci.created_at > COALESCE(cr.last_read_at, '1970-01-01'::timestamptz)
            ) AS unread_count
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $2 AND cm.state = 'active'
     LEFT JOIN conversation_reads cr ON cr.conversation_id = c.id AND cr.user_id = $2
     WHERE c.workspace_id = $1
       AND c.kind = 'group'
     ORDER BY c.updated_at DESC, c.created_at DESC`,
    [workspaceId, userId],
  );

  return result.rows;
}
