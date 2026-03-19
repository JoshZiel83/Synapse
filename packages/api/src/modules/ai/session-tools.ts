import { AsyncLocalStorage } from 'node:async_hooks';
import {
  normalizeActorDocs,
  summarizeActorForRole,
  type ActorDoc,
} from '@synapse/shared';
import { registerToolPlugin } from './tool-plugins.js';
import { query } from '../../infrastructure/database/index.js';
import { getSession } from '../session/service.js';
import { sendGroupMessage, addMembersToGroup, getGroupMembers } from '../group/service.js';
import { runMemorySearch } from '../memory/service.js';
import { readVisibleSkill } from '../skills/service.js';

type InviteableActor = {
  id: string;
  name: string;
  title?: string;
  role?: string;
  summary?: string;
};

function parseActorDocs(value: unknown): ActorDoc[] {
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? normalizeActorDocs(parsed as ActorDoc[]) : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? normalizeActorDocs(value as ActorDoc[]) : [];
}

function isGroupVisibleDoc(doc: ActorDoc): boolean {
  return doc.visibility === 'always' || doc.visibility === 'group_only';
}

function summarizeInviteableActor(row: {
  title?: string | null;
  role?: string | null;
  actor_docs?: unknown;
}): string | undefined {
  const docs = parseActorDocs(row.actor_docs).filter(isGroupVisibleDoc);
  const summary = summarizeActorForRole(
    docs,
    row.title || row.role || 'Actor',
  )
    .replace(/\s+/g, ' ')
    .trim();

  return summary || undefined;
}

function formatInviteableActor(actor: InviteableActor): string {
  const title = actor.title || actor.role || 'Actor';
  return `${actor.name} (${title}) [${actor.id}]${actor.summary ? ` - ${actor.summary}` : ''}`;
}

async function listInviteableActors(params: {
  workspaceId: string;
  groupId: string;
  actorId: string;
}): Promise<InviteableActor[]> {
  const result = await query(
    `SELECT a.id,
            a.name,
            a.title,
            a.role,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'key', avd.doc_key,
                    'title', avd.title,
                    'visibility', avd.visibility,
                    'priority', avd.priority,
                    'content', avd.content_blocks
                  )
                  ORDER BY avd.priority DESC, avd.created_at ASC
                )
                FROM actor_version_docs avd
                WHERE avd.actor_version_id = current_version.id
              ),
              '[]'::jsonb
            ) AS actor_docs
     FROM actors a
     LEFT JOIN actor_versions current_version
       ON current_version.actor_id = a.id
      AND current_version.version = a.current_version
     WHERE a.workspace_id = $1
       AND a.is_active = true
       AND a.id <> $3
       AND NOT EXISTS (
         SELECT 1
         FROM conversation_members cm
         WHERE cm.conversation_id = $2
           AND cm.actor_id = a.id
           AND cm.state = 'active'
       )
     ORDER BY a.name ASC, a.id ASC`,
    [params.workspaceId, params.groupId, params.actorId],
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    title: (row.title as string | null) || undefined,
    role: (row.role as string | null) || undefined,
    summary: summarizeInviteableActor(row),
  }));
}

function buildInviteActorDefinition(candidates: InviteableActor[]) {
  const candidateDirectory = candidates
    .map((candidate) => `\`${candidate.id}\`: ${formatInviteableActor(candidate)}`)
    .join('; ');

  return {
    name: 'invite_actor',
    description:
      'Invite one or more new actors to join the current group. ' +
      'Only the listed actors can be invited right now. ' +
      `Available invite candidates: ${candidateDirectory}`,
    parameters: {
      type: 'object',
      properties: {
        actorIds: {
          type: 'array',
          description: 'One or more actor IDs from the available invite candidate list.',
          items: { type: 'string', enum: candidates.map((candidate) => candidate.id) },
          minItems: 1,
          uniqueItems: true,
        },
        reason: {
          type: 'string',
          description: 'Shared reason and initial instruction sent to every invited actor.',
        },
      },
      required: ['actorIds', 'reason'],
    },
  };
}

/**
 * Register callable tool plugins.
 * Callable tools return results to the model for further reasoning.
 * Their `resolve(ctx)` determines availability per-session.
 */
export function registerCallableToolPlugins(): void {
  // ============ send_to (callable) ============
  registerToolPlugin({
    name: 'read_skill',
    kind: 'callable',
    definition: {
      name: 'read_skill',
      description: 'Read the description or an attachment of an installed skill package on demand. Use when a listed skill clearly matches the task and you need its detailed instructions or referenced text resources.',
      parameters: {
        type: 'object',
        properties: {
          skillName: { type: 'string', description: 'The installed skill name/slug to read.' },
          path: { type: 'string', description: 'Optional relative attachment path inside the skill package. Omit it to read the skill description.' },
        },
        required: ['skillName'],
      },
    },
    resolve: (ctx) => {
      const availableSkills = ctx.availableSkills || [];
      if (availableSkills.length === 0) {
        return { active: false, definition: null as any };
      }
      const skillNames: string[] = Array.from(new Set(availableSkills.map((skill) => skill.slug)));
      const skillList = availableSkills
        .map((skill) => `\`${skill.slug}\`: ${skill.description}`)
        .join('; ');
      return {
        active: true,
        definition: {
          name: 'read_skill',
          description: `Read the contents of an installed skill package. Available skills: ${skillList}`,
          parameters: {
            type: 'object',
            properties: {
              skillName: {
                type: 'string',
                description: 'The installed skill name/slug to read.',
                enum: skillNames,
              },
              path: {
                type: 'string',
                description: 'Optional relative attachment path inside the skill package, for example references/checklist.md. Omit it to read the skill description.',
              },
            },
            required: ['skillName'],
          },
        },
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        return JSON.stringify({ error: 'Session not found' });
      }

      const skillName = String((input as any).skillName || '').trim();
      const path = typeof (input as any).path === 'string' ? String((input as any).path).trim() : undefined;
      if (!skillName) {
        return JSON.stringify({ error: 'skillName is required' });
      }

      try {
        const result = await readVisibleSkill({
          workspaceId: context.workspaceId,
          actorId: context.actorId,
          conversationId: session.conversation_id,
          skillName,
          assetPath: path || undefined,
        });

        return [
          `Skill: ${result.skill.name}`,
          `Slug: ${result.skill.slug}`,
          `Version: ${result.skill.version}`,
          `Path: ${result.asset.path}`,
          '',
          result.asset.textContent || '',
        ].join('\n');
      } catch (err: any) {
        return JSON.stringify({ error: err.message || 'Failed to read skill' });
      }
    },
  });

  registerToolPlugin({
    name: 'send_to',
    kind: 'callable',
    definition: {
      name: 'send_to',
      description: 'Send a message to one or more members in the current group by name.',
      parameters: {
        type: 'object',
        properties: {
          recipients: {
            type: 'array',
            description: 'Member names to send to.',
            items: { type: 'string' },
          },
          message: { type: 'string', description: 'The message content' },
        },
        required: ['recipients', 'message'],
      },
    },
    resolve: (ctx) => {
      if (!ctx.groupId || !ctx.groupMembers?.length) {
        return { active: false, definition: null as any };
      }
      const otherMembers = ctx.groupMembers.filter(m =>
        m.type === 'user' || m.id !== ctx.actorId
      );
      if (otherMembers.length === 0) {
        return { active: false, definition: null as any };
      }
      const recipientNames = otherMembers.map(m => m.name);
      const rosterDesc = otherMembers.map(m =>
        m.type === 'user'
          ? `"${m.name}" (user)`
          : `"${m.name}" (actor${m.title ? ', ' + m.title : ''})`
      ).join(', ');
      return {
        active: true,
        definition: {
          name: 'send_to',
          description: `Send a message to one or more members in the current group. Available recipients: ${rosterDesc}.`,
          parameters: {
            type: 'object',
            properties: {
              recipients: {
                type: 'array',
                description: 'One or more member names to send the message to.',
                items: { type: 'string', enum: recipientNames },
              },
              message: { type: 'string', description: 'The message content' },
            },
            required: ['recipients', 'message'],
          },
        },
      };
    },
    execute: async (input) => {
      const rawRecipients = (input as any).recipients;
      const message = (input as any).message as string;

      let recipientNames: string[];
      if (Array.isArray(rawRecipients)) {
        recipientNames = rawRecipients;
      } else if (typeof rawRecipients === 'string') {
        recipientNames = [rawRecipients];
      } else {
        return JSON.stringify({ error: 'recipients must be an array of member names' });
      }

      if (recipientNames.length === 0) {
        return JSON.stringify({ error: 'recipients must contain at least one member name' });
      }

      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session || !session.group_id) {
        return JSON.stringify({ error: 'Current session is not in a group' });
      }

      // Load all current group members (excluding self)
      const allMembers = await getGroupMembers(session.group_id);

      const memberMap = new Map<string, { type: 'actor' | 'user'; id: string; name: string }>();
      for (const m of allMembers) {
        if (m.actor_id && m.actor_id !== context.actorId) {
          memberMap.set(m.actor_name.toLowerCase(), { type: 'actor', id: m.actor_id, name: m.actor_name });
        }
        if (m.user_id) {
          memberMap.set(m.user_name.toLowerCase(), { type: 'user', id: m.user_id, name: m.user_name });
        }
      }

      const targetActorIds: string[] = [];
      const targetUserIds: string[] = [];
      const resolved: string[] = [];
      const errors: string[] = [];

      for (const name of recipientNames) {
        const member = memberMap.get(name.toLowerCase());
        if (!member) {
          let bestMatch: { name: string; dist: number } | null = null;
          for (const [key, val] of memberMap) {
            const dist = levenshtein(name.toLowerCase(), key);
            if (dist <= 2 && (!bestMatch || dist < bestMatch.dist)) {
              bestMatch = { name: val.name, dist };
            }
          }
          if (bestMatch) {
            errors.push(`"${name}" not found. Did you mean "${bestMatch.name}"?`);
          } else {
            errors.push(`"${name}" is not a member of this group.`);
          }
          continue;
        }
        if (member.type === 'actor') targetActorIds.push(member.id);
        else targetUserIds.push(member.id);
        resolved.push(member.name);
      }

      if (resolved.length === 0) {
        const available = Array.from(memberMap.values()).map((m) => `${m.name} (${m.type})`);
        return JSON.stringify({
          error: 'No valid recipients found.',
          details: errors,
          availableMembers: available,
        });
      }

      const isCoordination = targetUserIds.length === 0;

      await sendGroupMessage({
        groupId: session.group_id,
        senderType: 'actor',
        senderActorId: context.actorId,
        senderSessionId: context.sessionId,
        targetActorIds,
        targetUserIds,
        content: message,
        metadata: isCoordination ? { coordination: true } : undefined,
      });

      const result: Record<string, unknown> = {
        success: true,
        sentTo: resolved,
        message: `Message sent to ${resolved.join(', ')}.`,
      };
      if (errors.length > 0) {
        result.warnings = errors;
      }
      return JSON.stringify(result);
    },
  });

  // ============ invite_actor (callable) ============
  registerToolPlugin({
    name: 'invite_actor',
    kind: 'callable',
    definition: {
      name: 'invite_actor',
      description: 'Invite one or more new actors to join the current group.',
      parameters: {
        type: 'object',
        properties: {
          actorIds: {
            type: 'array',
            description: 'Actor IDs to invite.',
            items: { type: 'string' },
          },
          reason: { type: 'string', description: 'Reason for inviting / initial instruction for the actor(s)' },
        },
        required: ['actorIds', 'reason'],
      },
    },
    resolve: async (
      ctx,
    ): Promise<{ active: boolean; definition: any }> => {
      if (!ctx.groupId) {
        return { active: false, definition: null as any };
      }

      const candidates = await listInviteableActors({
        workspaceId: ctx.workspaceId,
        groupId: ctx.groupId,
        actorId: ctx.actorId,
      });

      if (candidates.length === 0) {
        return { active: false, definition: null as any };
      }

      return {
        active: true,
        definition: buildInviteActorDefinition(candidates),
      };
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session || !session.group_id) {
        return JSON.stringify({ error: 'Current session is not in a group' });
      }

      const reason = typeof (input as any).reason === 'string'
        ? String((input as any).reason).trim()
        : '';
      if (!reason) {
        return JSON.stringify({ error: 'reason is required' });
      }

      const candidates = await listInviteableActors({
        workspaceId: session.workspace_id,
        groupId: session.group_id,
        actorId: context.actorId,
      });
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const candidatesByName = new Map<string, InviteableActor[]>();
      for (const candidate of candidates) {
        const key = candidate.name.trim().toLowerCase();
        const matches = candidatesByName.get(key) || [];
        matches.push(candidate);
        candidatesByName.set(key, matches);
      }

      const requestedActorIds = Array.isArray((input as any).actorIds)
        ? (input as any).actorIds
          .map((value: unknown) => String(value || '').trim())
          .filter(Boolean)
        : [];
      const fallbackNames = [
        typeof (input as any).actorName === 'string' ? String((input as any).actorName).trim() : '',
        ...(Array.isArray((input as any).actorNames)
          ? (input as any).actorNames.map((value: unknown) => String(value || '').trim())
          : []),
      ].filter(Boolean);

      const resolvedActors: InviteableActor[] = [];
      const resolutionErrors: string[] = [];

      for (const actorId of requestedActorIds) {
        const candidate = candidateById.get(actorId);
        if (!candidate) {
          resolutionErrors.push(`Actor ID "${actorId}" is not currently inviteable.`);
          continue;
        }
        resolvedActors.push(candidate);
      }

      for (const actorName of fallbackNames) {
        const matches = candidatesByName.get(actorName.toLowerCase()) || [];
        if (matches.length === 0) {
          resolutionErrors.push(`Actor "${actorName}" is not currently inviteable.`);
          continue;
        }
        if (matches.length > 1) {
          resolutionErrors.push(
            `Actor name "${actorName}" is ambiguous. Use actorIds instead: ${matches.map((candidate) => candidate.id).join(', ')}`,
          );
          continue;
        }
        resolvedActors.push(matches[0]!);
      }

      if (resolvedActors.length === 0) {
        return JSON.stringify({
          error: 'No inviteable actors were resolved.',
          details: resolutionErrors,
          availableCandidates: candidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            title: candidate.title || candidate.role || 'Actor',
            summary: candidate.summary,
          })),
        });
      }

      if (resolutionErrors.length > 0) {
        return JSON.stringify({
          error: 'Some requested actors are invalid or ambiguous.',
          details: resolutionErrors,
          availableCandidates: candidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            title: candidate.title || candidate.role || 'Actor',
            summary: candidate.summary,
          })),
        });
      }

      const uniqueActors = Array.from(
        new Map(resolvedActors.map((candidate) => [candidate.id, candidate])).values(),
      );

      try {
        const inviterMember = (await getGroupMembers(session.group_id))
          .find((member: any) => member.actor_id === context.actorId && member.state === 'active');
        const inviterName = inviterMember?.actor_name || 'Unknown';
        const addResult = await addMembersToGroup({
          groupId: session.group_id,
          workspaceId: session.workspace_id,
          actorIds: uniqueActors.map((candidate) => candidate.id),
          initiator: {
            memberType: 'actor',
            memberId: inviterMember?.id,
            actorId: context.actorId,
            name: inviterName,
          },
        });
        const invitedActorIds = new Set(
          (addResult.members || [])
            .filter((member: any) => member.type === 'actor' && member.actorId)
            .map((member: any) => member.actorId as string),
        );
        const invitedActors = uniqueActors.filter((candidate) => invitedActorIds.has(candidate.id));
        const skippedActors = uniqueActors
          .filter((candidate) => !invitedActorIds.has(candidate.id))
          .map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            reason: 'Actor already in group',
          }));

        if (invitedActors.length === 0) {
          return JSON.stringify({
            error: 'No new actors were invited.',
            skippedActors,
          });
        }

        await sendGroupMessage({
          groupId: session.group_id,
          senderType: 'actor',
          senderActorId: context.actorId,
          senderSessionId: context.sessionId,
          targetActorIds: invitedActors.map((candidate) => candidate.id),
          content: reason,
        });

        return JSON.stringify({
          success: true,
          invitedActors: invitedActors.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            title: candidate.title || candidate.role || 'Actor',
            summary: candidate.summary,
          })),
          skippedActors,
          message:
            invitedActors.length === 1
              ? `${invitedActors[0]!.name} has been invited to the group and notified.`
              : `${invitedActors.map((candidate) => candidate.name).join(', ')} have been invited to the group and notified.`,
        });
      } catch (err: any) {
        throw new Error(`Failed to invite actor(s): ${err.message}`);
      }
    },
  });

  // ============ memory_search (callable) ============
  registerToolPlugin({
    name: 'memory_search',
    kind: 'callable',
    definition: {
      name: 'memory_search',
      description: 'Search durable memories scoped to the current actor and conversation. Use when recalled memory is insufficient and you need deeper historical context.',
      parameters: {
        type: 'object',
        properties: {
          queryText: { type: 'string', description: 'What you want to search for in memory.' },
          limit: { type: 'string', description: 'Optional result limit from 1 to 10.' },
        },
        required: ['queryText'],
      },
    },
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        return JSON.stringify({ error: 'Session not found' });
      }

      const queryText = String((input as any).queryText || '').trim();
      const limit = Math.max(1, Math.min(10, parseInt(String((input as any).limit || '5'), 10) || 5));
      if (!queryText) {
        return JSON.stringify({ error: 'queryText is required' });
      }

      const result = await runMemorySearch(context.workspaceId, {
        queryText,
        actorId: context.actorId,
        conversationId: session.conversation_id,
        limit,
        metadata: {
          sessionId: context.sessionId,
          source: 'memory_search_tool',
        },
      });

      return JSON.stringify({
        success: true,
        runId: result.run.id,
        results: result.memories.map((memory) => ({
          id: memory.id,
          ownerScope: memory.ownerScope,
          category: memory.category,
          textDigest: memory.textDigest,
          tags: memory.tags,
          finalScore: Number(memory.finalScore.toFixed(4)),
          matchedTerms: memory.matchedTerms || [],
        })),
      });
    },
  });

  // ============ sleep (callable) ============
  registerToolPlugin({
    name: 'sleep',
    kind: 'callable',
    definition: {
      name: 'sleep',
      description: 'Enter idle/sleeping state after completing your current work. You will be woken up when someone sends you a message in the group.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Brief summary of what you accomplished before sleeping' },
        },
        required: ['summary'],
      },
    },
    resolve: (ctx) => ({
      active: !!ctx.groupId,
      definition: {
        name: 'sleep',
        description: 'Enter idle/sleeping state after completing your current work. You will be woken up when someone sends you a message in the group.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Brief summary of what you accomplished before sleeping' },
          },
          required: ['summary'],
        },
      },
    }),
    execute: async (input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        return JSON.stringify({ error: 'Session not found' });
      }

      const summary = typeof (input as any).summary === 'string'
        ? String((input as any).summary).trim()
        : '';

      return JSON.stringify({
        success: true,
        summary,
        message: 'Sleep requested. The session will return to idle after this turn completes.',
      });
    },
  });
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ============ Tool Execution Context ============
// Uses AsyncLocalStorage so each concurrent BullMQ job has its own context.

interface ToolExecutionContext {
  sessionId: string;
  actorId: string;
  workspaceId: string;
  userId?: string;
  turnId?: string;
  conversationId?: string;
}

const contextStorage = new AsyncLocalStorage<ToolExecutionContext>();

/**
 * Run `fn` with the given tool execution context bound via AsyncLocalStorage.
 */
export function runWithToolContext<T>(ctx: ToolExecutionContext, fn: () => T): T {
  return contextStorage.run(ctx, fn);
}

/** @deprecated Use runWithToolContext instead. Kept only as no-op for call sites that still call it. */
export function setToolExecutionContext(_ctx: ToolExecutionContext | null) {
  // no-op — context is now set via runWithToolContext / AsyncLocalStorage
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return contextStorage.getStore() ?? null;
}
