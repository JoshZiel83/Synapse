import { redis } from '../../infrastructure/redis/index.js';
import { query } from '../../infrastructure/database/index.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import {
  nowISO,
  type ActorRuntimePhase,
  type ActorRuntimeState,
  type ActorRuntimeWakeup,
  type SessionWakeupSourceType,
  type SessionWakeupStatus,
} from '@synapse/shared';
import { getSession, updateSessionStatus } from './service.js';

function runtimeHashKey(groupId: string) {
  return `runtime:group:${groupId}`;
}

function runtimeSequenceKey(groupId: string) {
  return `runtime:group:${groupId}:seq`;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function mapWakeupRow(row: any): ActorRuntimeWakeup {
  const metadata = parseMetadata(row.metadata);
  return {
    wakeupId: row.id,
    sourceType: row.source_type,
    sourceItemId: row.source_item_id || undefined,
    sourceSessionId: row.source_session_id || undefined,
    sourceMemberType: row.source_member_type || undefined,
    sourceMemberId: row.source_member_id || undefined,
    sourceName: row.source_name || undefined,
    summary: row.summary,
    reasonText: row.reason_text || undefined,
    status: row.status,
    activationKind: typeof metadata.activationKind === 'string' ? metadata.activationKind : undefined,
    delivery: typeof metadata.delivery === 'string' ? metadata.delivery : undefined,
    createdAt: row.created_at,
    attachedAt: row.attached_at || undefined,
  };
}

function wakeupPriority(status: SessionWakeupStatus) {
  switch (status) {
    case 'attached':
      return 2;
    case 'pending':
      return 1;
    default:
      return 0;
  }
}

function dedupeRuntimeWakeups(wakeups: ActorRuntimeWakeup[]) {
  const deduped = new Map<string, ActorRuntimeWakeup>();

  for (const wakeup of wakeups) {
    const key = [
      wakeup.sourceType,
      wakeup.sourceMemberType || '',
      wakeup.sourceMemberId || '',
      wakeup.sourceSessionId || '',
      wakeup.activationKind || '',
      wakeup.delivery || '',
    ].join(':');
    const current = deduped.get(key);

    if (!current) {
      deduped.set(key, wakeup);
      continue;
    }

    const nextPriority = wakeupPriority(wakeup.status);
    const currentPriority = wakeupPriority(current.status);
    if (
      nextPriority > currentPriority
      || (nextPriority === currentPriority && new Date(wakeup.createdAt).getTime() >= new Date(current.createdAt).getTime())
    ) {
      deduped.set(key, wakeup);
    }
  }

  return Array.from(deduped.values()).sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
}

async function loadRuntimeWakeups(sessionId: string, statuses: SessionWakeupStatus[] = ['pending', 'attached']) {
  const result = await query(
    `SELECT *
     FROM session_wakeups
     WHERE session_id = $1
       AND status = ANY($2)
     ORDER BY created_at ASC`,
    [sessionId, statuses],
  );

  return result.rows.map(mapWakeupRow);
}

export async function getGroupRuntimeMap(groupIds: string[]) {
  if (groupIds.length === 0) return {} as Record<string, Record<string, ActorRuntimeState>>;

  const pipeline = redis.pipeline();
  for (const groupId of groupIds) {
    pipeline.hgetall(runtimeHashKey(groupId));
  }

  const responses = await pipeline.exec();
  const runtimeMap: Record<string, Record<string, ActorRuntimeState>> = {};

  for (let index = 0; index < groupIds.length; index++) {
    const groupId = groupIds[index]!;
    const [, rawMap] = responses?.[index] || [];
    const parsed: Record<string, ActorRuntimeState> = {};
    for (const [actorId, rawValue] of Object.entries((rawMap || {}) as Record<string, string>)) {
      try {
        parsed[actorId] = JSON.parse(rawValue);
      } catch {
        // ignore malformed cache entry
      }
    }
    runtimeMap[groupId] = parsed;
  }

  const sessionResult = await query(
    `SELECT s.id, s.actor_id, s.conversation_id AS group_id
     FROM sessions s
     JOIN conversations c ON c.id = s.conversation_id
     WHERE s.conversation_id = ANY($1)
       AND c.kind = 'group'`,
    [groupIds],
  );

  const missingSessions = sessionResult.rows.filter((row) => !runtimeMap[row.group_id]?.[row.actor_id]);
  if (missingSessions.length === 0) {
    return runtimeMap;
  }

  const hydratedSnapshots = await Promise.all(
    missingSessions.map(async (row) => {
      const snapshot = await buildSessionRuntimeSnapshot(row.id);
      return snapshot ? { groupId: row.group_id as string, snapshot } : null;
    }),
  );

  const hydratePipeline = redis.pipeline();
  for (const entry of hydratedSnapshots) {
    if (!entry) continue;
    runtimeMap[entry.groupId] = runtimeMap[entry.groupId] || {};
    runtimeMap[entry.groupId]![entry.snapshot.actorId] = entry.snapshot;
    hydratePipeline.hset(runtimeHashKey(entry.groupId), entry.snapshot.actorId, JSON.stringify(entry.snapshot));
  }
  await hydratePipeline.exec();

  return runtimeMap;
}

export async function buildSessionRuntimeSnapshot(
  sessionId: string,
  overrides: Partial<Pick<ActorRuntimeState, 'laneState' | 'health' | 'phase' | 'statusText' | 'currentTurnId' | 'lastError'>> = {},
): Promise<ActorRuntimeState | null> {
  const session = await getSession(sessionId);
  if (!session || !session.group_id) return null;

  const rawWakeups = await loadRuntimeWakeups(sessionId, ['pending', 'attached']);
  const activeWakeups = dedupeRuntimeWakeups(rawWakeups);
  const pendingWakeupCount = rawWakeups.filter((wakeup) => wakeup.status === 'pending').length;
  const latestWakeupAt = rawWakeups.length > 0 ? rawWakeups[rawWakeups.length - 1]!.createdAt : undefined;
  const lastError = overrides.lastError
    || (session.error_message
      ? {
          message: session.error_message as string,
          at: session.updated_at || nowISO(),
        }
      : undefined);

  const laneState = overrides.laneState || session.status;
  const phase = overrides.phase
    || (laneState === 'running'
      ? 'thinking'
      : laneState === 'blocked'
        ? 'error'
        : 'idle');
  const health = overrides.health || (lastError ? 'error' : 'ok');

  return {
    groupId: session.group_id,
    sessionId: session.id,
    actorId: session.actor_id,
    actorName: session.actor_name || 'Unknown',
    laneState,
    health,
    phase,
    statusText: overrides.statusText,
    currentTurnId: overrides.currentTurnId,
    pendingWakeupCount,
    activeWakeups,
    latestWakeupAt,
    lastError,
    updatedAt: nowISO(),
  };
}

export async function publishSessionRuntime(
  workspaceId: string,
  sessionId: string,
  overrides: Partial<Pick<ActorRuntimeState, 'laneState' | 'health' | 'phase' | 'statusText' | 'currentTurnId' | 'lastError'>> = {},
) {
  const snapshot = await buildSessionRuntimeSnapshot(sessionId, overrides);
  if (!snapshot) return null;

  await redis.hset(runtimeHashKey(snapshot.groupId), snapshot.actorId, JSON.stringify(snapshot));
  const runtimeSeq = await redis.incr(runtimeSequenceKey(snapshot.groupId));
  await emitEvent({
    type: 'chat.runtime.updated',
    workspaceId,
    payload: {
      conversationId: snapshot.groupId,
      runtimeSeq,
      snapshot,
    },
    timestamp: nowISO(),
  });
  await emitEvent({
    type: 'group.actor.runtime.updated',
    workspaceId,
    payload: snapshot as unknown as Record<string, unknown>,
    timestamp: nowISO(),
  });

  return snapshot;
}

export async function removeSessionRuntime(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session?.group_id) return;
  await redis.hdel(runtimeHashKey(session.group_id), session.actor_id);
}

export async function enqueueSessionWakeup(params: {
  sessionId: string;
  actorId: string;
  workspaceId: string;
  sourceType: SessionWakeupSourceType;
  sourceItemId?: string;
  sourceSessionId?: string;
  sourceMemberType?: 'user' | 'actor' | 'system';
  sourceMemberId?: string;
  sourceName?: string;
  summary: string;
  reasonText?: string;
  automationExecutionId?: string;
  automationOccurrenceId?: string;
  metadata?: Record<string, unknown>;
  trigger?: string;
}) {
  const session = await getSession(params.sessionId);
  if (!session) {
    throw new Error(`Session ${params.sessionId} not found`);
  }
  if (session.status === 'closed') {
    throw new Error(`Session ${params.sessionId} is closed`);
  }

  const result = await query(
    `INSERT INTO session_wakeups
       (id, session_id, source_type, source_item_id, source_session_id, source_member_type, source_member_id,
        source_name, summary, reason_text, automation_execution_id, automation_occurrence_id, status, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, NOW())
     RETURNING *`,
    [
      crypto.randomUUID(),
      params.sessionId,
      params.sourceType,
      params.sourceItemId || null,
      params.sourceSessionId || null,
      params.sourceMemberType || null,
      params.sourceMemberId || null,
      params.sourceName || null,
      params.summary,
      params.reasonText || null,
      params.automationExecutionId || null,
      params.automationOccurrenceId || null,
      JSON.stringify(params.metadata || {}),
    ],
  );

  if (session.status === 'idle' || session.status === 'blocked') {
    await updateSessionStatus(params.sessionId, 'queued', { errorMessage: null });
  }

  await publishSessionRuntime(params.workspaceId, params.sessionId, {
    laneState: session.status === 'running' ? 'running' : 'queued',
    health: session.status === 'blocked' ? 'ok' : undefined,
  });

  if (session.status !== 'running') {
    await sessionThinkingQueue.add('think', {
      sessionId: params.sessionId,
      actorId: params.actorId,
      workspaceId: params.workspaceId,
      trigger: params.trigger || params.sourceType,
    });
  }

  return result.rows[0];
}

export async function attachPendingWakeupsToTurn(sessionId: string, turnId: string) {
  const result = await query(
    `UPDATE session_wakeups
     SET status = 'attached',
         turn_id = $2,
         attached_at = NOW()
     WHERE session_id = $1
       AND status = 'pending'
     RETURNING *`,
    [sessionId, turnId],
  );

  return result.rows.map(mapWakeupRow);
}

export async function markTurnWakeupsProcessed(turnId: string) {
  await query(
    `UPDATE session_wakeups
     SET status = 'processed',
         processed_at = NOW()
     WHERE turn_id = $1
       AND status = 'attached'`,
    [turnId],
  );
}

export async function markTurnWakeupsDropped(turnId: string) {
  await query(
    `UPDATE session_wakeups
     SET status = 'dropped',
         processed_at = NOW()
     WHERE turn_id = $1
       AND status = 'attached'`,
    [turnId],
  );
}

export async function getPendingWakeupCount(sessionId: string) {
  const result = await query(
    `SELECT COUNT(*)::int AS count
     FROM session_wakeups
     WHERE session_id = $1
       AND status = 'pending'`,
    [sessionId],
  );

  return result.rows[0]?.count || 0;
}

export async function getPendingWakeups(sessionId: string) {
  const result = await query(
    `SELECT *
     FROM session_wakeups
     WHERE session_id = $1
       AND status = 'pending'
     ORDER BY created_at ASC`,
    [sessionId],
  );

  return result.rows.map(mapWakeupRow);
}
