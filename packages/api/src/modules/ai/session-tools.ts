import { AsyncLocalStorage } from 'node:async_hooks';
import { registerToolPlugin } from './tool-plugins.js';
import { query } from '../../infrastructure/database/index.js';
import { getSession } from '../session/service.js';
import { sendGroupMessage, addActorToGroup, sleepActor } from '../group/service.js';

/**
 * Register callable tool plugins.
 * Callable tools return results to the model for further reasoning.
 * Their `resolve(ctx)` determines availability per-session.
 */
export function registerCallableToolPlugins(): void {
  // ============ send_to (callable) ============
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
      const allMembers = await query(
        `SELECT gm.actor_id, gm.user_id, a.name as actor_name, a.title as actor_title, u.name as user_name
         FROM group_members gm
         LEFT JOIN actors a ON a.id = gm.actor_id
         LEFT JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1`,
        [session.group_id]
      );

      const memberMap = new Map<string, { type: 'actor' | 'user'; id: string; name: string }>();
      for (const m of allMembers.rows) {
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
      description: 'Invite a new actor to join the current group. The actor will be added as a member and can be messaged via send_to.',
      parameters: {
        type: 'object',
        properties: {
          actorName: { type: 'string', description: 'Name of the actor to invite' },
          reason: { type: 'string', description: 'Reason for inviting / initial instruction for the actor' },
        },
        required: ['actorName', 'reason'],
      },
    },
    resolve: (ctx) => ({
      active: !!ctx.groupId,
      definition: {
        name: 'invite_actor',
        description: 'Invite a new actor to join the current group. The actor will be added as a member and can be messaged via send_to.',
        parameters: {
          type: 'object',
          properties: {
            actorName: { type: 'string', description: 'Name of the actor to invite' },
            reason: { type: 'string', description: 'Reason for inviting / initial instruction for the actor' },
          },
          required: ['actorName', 'reason'],
        },
      },
    }),
    execute: async (input) => {
      const { actorName, reason } = input as { actorName: string; reason: string };
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session || !session.group_id) {
        return JSON.stringify({ error: 'Current session is not in a group' });
      }

      const actorResult = await query(
        'SELECT id, name, title FROM actors WHERE workspace_id = $1 AND name ILIKE $2 AND is_active = true',
        [session.workspace_id, actorName]
      );

      if (actorResult.rows.length === 0) {
        return JSON.stringify({ error: `Actor "${actorName}" not found in workspace` });
      }

      const targetActor = actorResult.rows[0];

      try {
        const inviterResult = await query('SELECT name FROM actors WHERE id = $1', [context.actorId]);
        const inviterName = inviterResult.rows[0]?.name || 'Unknown';

        await addActorToGroup(session.group_id, targetActor.id, inviterName);

        await sendGroupMessage({
          groupId: session.group_id,
          senderType: 'actor',
          senderActorId: context.actorId,
          senderSessionId: context.sessionId,
          targetActorIds: [targetActor.id],
          content: reason,
        });

        return JSON.stringify({
          success: true,
          actorName: targetActor.name,
          actorTitle: targetActor.title,
          message: `${targetActor.name} has been invited to the group and notified.`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Failed to invite: ${err.message}` });
      }
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
    execute: async (_input) => {
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available' });
      }

      const session = await getSession(context.sessionId);
      if (!session) {
        return JSON.stringify({ error: 'Session not found' });
      }

      await sleepActor(context.sessionId);

      return JSON.stringify({
        success: true,
        message: 'Entering sleep mode. You will be woken up when someone messages you.',
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
