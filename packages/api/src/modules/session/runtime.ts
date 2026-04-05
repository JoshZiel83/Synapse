import { redis } from '../../infrastructure/redis/index.js';
import { query } from '../../infrastructure/database/index.js';
import {
  db,
  type TableInsert,
} from '../../infrastructure/database/kysely.js';
import { emitEvent } from '../../infrastructure/events/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';
import {
  isThreadConversationKind,
  nowISO,
  THREAD_CONVERSATION_KINDS,
  type ActorRuntimePhase,
  type ActorRuntimeState,
  type ActorRuntimeWakeup,
  type SessionTrigger,
  type SessionWakeupSourceType,
  type SessionWakeupStatus,
} from '@synapse/shared';
import { sql } from 'kysely';
import { getSession, updateSessionStatus } from './service.js';

function runtimeHashKey(conversationId: string) {
  return `runtime:conversation:${conversationId}`;
}

function runtimeSequenceKey(conversationId: string) {
  return `runtime:conversation:${conversationId}:seq`;
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

function mapWakeupSourceTypeToTrigger(sourceType: SessionWakeupSourceType): SessionTrigger {
  return sourceType;
}

function mapWakeupRow(row: any): ActorRuntimeWakeup {
  const metadata = parseMetadata(row.metadata);
  return {
    wakeupId: row.id,
    sourceType: row.source_type,
    sourceItemId: row.source_item_id || undefined,
    sourceSessionId: row.source_session_id || undefined,
    sourceParticipantType: row.source_participant_type || undefined,
    sourceParticipantId: row.source_participant_id || undefined,
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
      wakeup.sourceParticipantType || '',
      wakeup.sourceParticipantId || '',
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
  const rows = await db
    .selectFrom('session_wakeups')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('status', 'in', statuses)
    .orderBy('created_at', 'asc')
    .execute();

  return rows.map(mapWakeupRow);
}

export async function getConversationRuntimeMap(conversationIds: string[]) {
  if (conversationIds.length === 0) {
    return {} as Record<string, Record<string, ActorRuntimeState>>;
  }

  const pipeline = redis.pipeline();
  for (const conversationId of conversationIds) {
    pipeline.hgetall(runtimeHashKey(conversationId));
  }

  const responses = await pipeline.exec();
  const runtimeMap: Record<string, Record<string, ActorRuntimeState>> = {};

  for (let index = 0; index < conversationIds.length; index++) {
    const conversationId = conversationIds[index]!;
    const [, rawMap] = responses?.[index] || [];
    const parsed: Record<string, ActorRuntimeState> = {};
    for (const [actorId, rawValue] of Object.entries((rawMap || {}) as Record<string, string>)) {
      try {
        parsed[actorId] = JSON.parse(rawValue);
      } catch {
        // ignore malformed cache entry
      }
    }
    runtimeMap[conversationId] = parsed;
  }

  const sessionResult = await db
    .selectFrom('sessions as s')
    .innerJoin('conversations as c', 'c.id', 's.conversation_id')
    .select(['s.id', 's.actor_id', 's.conversation_id'])
    .where('s.conversation_id', 'in', conversationIds)
    .where('c.kind', 'in', [...THREAD_CONVERSATION_KINDS])
    .execute();

  const missingSessions = sessionResult.filter(
    (row) => !runtimeMap[row.conversation_id]?.[row.actor_id],
  );
  if (missingSessions.length === 0) {
    return runtimeMap;
  }

  const hydratedSnapshots = await Promise.all(
    missingSessions.map(async (row) => {
      const snapshot = await buildSessionRuntimeSnapshot(row.id);
      return snapshot
        ? { conversationId: row.conversation_id as string, snapshot }
        : null;
    }),
  );

  const hydratePipeline = redis.pipeline();
  for (const entry of hydratedSnapshots) {
    if (!entry) continue;
    runtimeMap[entry.conversationId] = runtimeMap[entry.conversationId] || {};
    runtimeMap[entry.conversationId]![entry.snapshot.actorId] = entry.snapshot;
    hydratePipeline.hset(
      runtimeHashKey(entry.conversationId),
      entry.snapshot.actorId,
      JSON.stringify(entry.snapshot),
    );
  }
  await hydratePipeline.exec();

  return runtimeMap;
}

export async function buildSessionRuntimeSnapshot(
  sessionId: string,
  overrides: Partial<Pick<ActorRuntimeState, 'laneState' | 'health' | 'phase' | 'statusText' | 'currentTurnId' | 'lastError'>> = {},
): Promise<ActorRuntimeState | null> {
  const session = await getSession(sessionId);
  if (!session || !isThreadConversationKind(session.conversation_kind)) return null;

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
    conversationId: session.conversation_id,
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

  await redis.hset(
    runtimeHashKey(snapshot.conversationId),
    snapshot.actorId,
    JSON.stringify(snapshot),
  );
  const runtimeSeq = await redis.incr(runtimeSequenceKey(snapshot.conversationId));
  await emitEvent({
    type: 'runtime.updated',
    workspaceId,
    payload: {
      conversationId: snapshot.conversationId,
      runtimeSeq,
      snapshot,
    },
    timestamp: nowISO(),
  });

  return snapshot;
}

export async function removeSessionRuntime(sessionId: string) {
  const session = await getSession(sessionId);
  if (!session || !isThreadConversationKind(session.conversation_kind)) return;
  await redis.hdel(runtimeHashKey(session.conversation_id), session.actor_id);
}

export async function enqueueSessionWakeup(params: {
  sessionId: string;
  actorId: string;
  workspaceId: string;
  sourceType: SessionWakeupSourceType;
  sourceItemId?: string;
  sourceSessionId?: string;
  sourceParticipantType?: 'workspace_member' | 'actor' | 'external' | 'system';
  sourceParticipantId?: string;
  sourceName?: string;
  summary: string;
  reasonText?: string;
  automationExecutionId?: string;
  automationOccurrenceId?: string;
  metadata?: Record<string, unknown>;
  trigger?: SessionTrigger;
}) {
  const session = await getSession(params.sessionId);
  if (!session) {
    throw new Error(`Session ${params.sessionId} not found`);
  }
  if (session.status === 'closed') {
    throw new Error(`Session ${params.sessionId} is closed`);
  }

  let created: any;
  let reusedExistingWakeup = false;

  if (params.sourceItemId) {
    const insertResult = await query(
      `
        INSERT INTO session_wakeups (
          id,
          session_id,
          source_type,
          source_item_id,
          source_session_id,
          source_participant_type,
          source_participant_id,
          source_name,
          summary,
          reason_text,
          automation_execution_id,
          automation_occurrence_id,
          status,
          metadata
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13::jsonb
        )
        ON CONFLICT (session_id, source_type, source_item_id)
        WHERE source_item_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `,
      [
        crypto.randomUUID(),
        params.sessionId,
        params.sourceType,
        params.sourceItemId,
        params.sourceSessionId || null,
        params.sourceParticipantType || null,
        params.sourceParticipantId || null,
        params.sourceName || null,
        params.summary,
        params.reasonText || null,
        params.automationExecutionId || null,
        params.automationOccurrenceId || null,
        JSON.stringify(params.metadata || {}),
      ],
    );
    created = insertResult.rows[0];

    if (!created) {
      const existing = await query(
        `
          SELECT *
          FROM session_wakeups
          WHERE session_id = $1
            AND source_type = $2
            AND source_item_id = $3
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [params.sessionId, params.sourceType, params.sourceItemId],
      );
      created = existing.rows[0];
      reusedExistingWakeup = Boolean(created);
    }
  } else {
    created = await db
      .insertInto('session_wakeups')
      .values({
        id: crypto.randomUUID(),
        session_id: params.sessionId,
        source_type: params.sourceType,
        source_item_id: null,
        source_session_id: params.sourceSessionId || null,
        source_participant_type: params.sourceParticipantType || null,
        source_participant_id: params.sourceParticipantId || null,
        source_name: params.sourceName || null,
        summary: params.summary,
        reason_text: params.reasonText || null,
        automation_execution_id: params.automationExecutionId || null,
        automation_occurrence_id: params.automationOccurrenceId || null,
        status: 'pending',
        metadata: (params.metadata || {}) as TableInsert<'session_wakeups'>['metadata'],
      })
      .returningAll()
      .executeTakeFirst();
  }
  if (!created) {
    throw new Error('Failed to enqueue session wakeup');
  }

  if (reusedExistingWakeup) {
    return created;
  }

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
      trigger: params.trigger || mapWakeupSourceTypeToTrigger(params.sourceType),
    });
  }

  return created;
}

export async function attachPendingWakeupsToTurn(sessionId: string, turnId: string) {
  const rows = await db
    .updateTable('session_wakeups')
    .set({
      status: 'attached',
      turn_id: turnId,
      attached_at: sql`NOW()`,
    })
    .where('session_id', '=', sessionId)
    .where('status', '=', 'pending')
    .returningAll()
    .execute();

  return rows.map(mapWakeupRow);
}

export async function markTurnWakeupsProcessed(turnId: string) {
  await db
    .updateTable('session_wakeups')
    .set({
      status: 'processed',
      processed_at: sql`NOW()`,
    })
    .where('turn_id', '=', turnId)
    .where('status', '=', 'attached')
    .execute();
}

export async function markTurnWakeupsDropped(turnId: string) {
  await db
    .updateTable('session_wakeups')
    .set({
      status: 'dropped',
      processed_at: sql`NOW()`,
    })
    .where('turn_id', '=', turnId)
    .where('status', '=', 'attached')
    .execute();
}

export async function getPendingWakeupCount(sessionId: string) {
  const row = await db
    .selectFrom('session_wakeups')
    .select(({ fn }) => fn.count<number>('id').as('count'))
    .where('session_id', '=', sessionId)
    .where('status', '=', 'pending')
    .executeTakeFirst();

  return Number(row?.count || 0);
}

export async function getPendingWakeups(sessionId: string) {
  const rows = await db
    .selectFrom('session_wakeups')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('status', '=', 'pending')
    .orderBy('created_at', 'asc')
    .execute();

  return rows.map(mapWakeupRow);
}
