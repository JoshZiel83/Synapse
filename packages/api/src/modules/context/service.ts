import { query } from '../../infrastructure/database/index.js';
import type {
  CanonicalArchiveFrame,
  CanonicalArchivePoint,
  CanonicalContextItem,
  ProviderContextWindow,
} from '@synapse/shared';
import { itemPartsToCanonicalBlocks } from '../ai/context-builder.js';

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseJsonArray<T>(value: unknown): T[] | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    return value as T[];
  }
  return undefined;
}

async function ensureConversationContextState(conversationId: string) {
  await query(
    `INSERT INTO conversation_context_states (conversation_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (conversation_id) DO NOTHING`,
    [conversationId],
  );
}

async function ensureSessionContextState(sessionId: string) {
  await query(
    `INSERT INTO session_context_states (session_id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId],
  );
}

async function loadArchivePoint(archivePointId: string): Promise<CanonicalArchivePoint | null> {
  const pointResult = await query(
    `SELECT *
     FROM context_archive_points
     WHERE id = $1
     LIMIT 1`,
    [archivePointId],
  );

  const point = pointResult.rows[0];
  if (!point) return null;

  const framesResult = await query(
    `SELECT caf.*,
            cap.id AS part_id,
            cap.ordinal AS part_ordinal,
            cap.part_type,
            cap.text_value,
            cap.file_id,
            cap.json_value,
            cap.mime_type,
            cap.name,
            cap.metadata AS part_metadata,
            f.original_name,
            f.stored_name,
            f.mime_type AS file_mime_type,
            f.size_bytes
     FROM context_archive_frames caf
     LEFT JOIN context_archive_frame_parts cap ON cap.archive_frame_id = caf.id
     LEFT JOIN files f ON f.id = cap.file_id
     WHERE caf.archive_point_id = $1
     ORDER BY caf.ordinal ASC, cap.ordinal ASC`,
    [archivePointId],
  );

  const frameMap = new Map<string, { row: any; parts: any[] }>();
  for (const row of framesResult.rows) {
    if (!frameMap.has(row.id)) {
      frameMap.set(row.id, { row, parts: [] });
    }
    if (row.part_id) {
      frameMap.get(row.id)!.parts.push({
        part_type: row.part_type,
        text_value: row.text_value,
        file_id: row.file_id,
        json_value: row.json_value,
        mime_type: row.mime_type,
        name: row.name,
        metadata: row.part_metadata,
        original_name: row.original_name,
        stored_name: row.stored_name,
        file_mime_type: row.file_mime_type,
        size_bytes: row.size_bytes,
      });
    }
  }

  const frames: CanonicalArchiveFrame[] = Array.from(frameMap.values()).map(({ row, parts }) => ({
    frameId: row.id,
    role: row.role,
    frameType: row.frame_type,
    parts: parts.length > 0 ? itemPartsToCanonicalBlocks(parts) : undefined,
    toolCalls: parseJsonArray(row.tool_calls),
    toolResults: parseJsonArray(row.tool_results),
    sourceItemIds: Array.isArray(row.source_item_ids) ? row.source_item_ids : undefined,
    metadata: parseJsonObject(row.metadata),
  }));

  return {
    archivePointId: point.id,
    chainScope: point.chain_scope,
    conversationId: point.conversation_id,
    sessionId: point.session_id || undefined,
    parentArchivePointId: point.parent_archive_point_id || undefined,
    coversUntilSequence: Number(point.covers_until_sequence || 0),
    frames,
    metadata: parseJsonObject(point.metadata),
    createdAt: point.created_at?.toISOString?.() || point.created_at,
  };
}

async function loadActiveSharedArchivePoint(conversationId: string): Promise<CanonicalArchivePoint | null> {
  await ensureConversationContextState(conversationId);
  const result = await query(
    `SELECT active_shared_archive_point_id
     FROM conversation_context_states
     WHERE conversation_id = $1`,
    [conversationId],
  );
  const archivePointId = result.rows[0]?.active_shared_archive_point_id;
  return archivePointId ? loadArchivePoint(archivePointId) : null;
}

async function loadActivePrivateArchivePoint(sessionId?: string): Promise<CanonicalArchivePoint | null> {
  if (!sessionId) return null;
  await ensureSessionContextState(sessionId);
  const result = await query(
    `SELECT active_private_archive_point_id
     FROM session_context_states
     WHERE session_id = $1`,
    [sessionId],
  );
  const archivePointId = result.rows[0]?.active_private_archive_point_id;
  return archivePointId ? loadArchivePoint(archivePointId) : null;
}

function isCoveredByArchive(item: CanonicalContextItem, coversUntilSequence: number) {
  return typeof item.sequence === 'number' && item.sequence <= coversUntilSequence;
}

export async function buildProviderContextWindow(params: {
  conversationId: string;
  sessionId?: string;
  items: CanonicalContextItem[];
}): Promise<ProviderContextWindow> {
  const [sharedArchivePoint, privateArchivePoint] = await Promise.all([
    loadActiveSharedArchivePoint(params.conversationId),
    loadActivePrivateArchivePoint(params.sessionId),
  ]);

  const sharedCoverage = sharedArchivePoint?.coversUntilSequence ?? 0;
  const privateCoverage = privateArchivePoint?.coversUntilSequence ?? 0;

  const sharedTailItems: CanonicalContextItem[] = [];
  const privateTailItems: CanonicalContextItem[] = [];
  const orderedTailItems: CanonicalContextItem[] = [];

  for (const item of params.items) {
    const covered = item.scope === 'shared'
      ? isCoveredByArchive(item, sharedCoverage)
      : isCoveredByArchive(item, privateCoverage);

    if (covered) continue;

    if (item.scope === 'shared') {
      sharedTailItems.push(item);
    } else {
      privateTailItems.push(item);
    }
    orderedTailItems.push(item);
  }

  return {
    sharedArchivePoint,
    sharedTailItems,
    privateArchivePoint,
    privateTailItems,
    orderedTailItems,
  };
}

export function buildAdHocProviderContextWindow(items: CanonicalContextItem[]): ProviderContextWindow {
  return {
    sharedArchivePoint: null,
    sharedTailItems: items,
    privateArchivePoint: null,
    privateTailItems: [],
    orderedTailItems: items,
  };
}
