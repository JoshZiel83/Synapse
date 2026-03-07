import { registerCallableTool } from './callable-tools.js';
import { query } from '../../infrastructure/database/index.js';
import {
  createSessionAndEnqueue,
  getSession,
  getSessionMessages,
  createInterrupt,
} from '../session/service.js';

/**
 * Register session-aware callable tools: delegate and check_progress.
 * These tools return results to the model for further reasoning.
 */
export function registerSessionTools() {
  // ============ delegate (callable) ============
  registerCallableTool(
    {
      name: 'delegate',
      description: 'Delegate a task to a subordinate actor. Creates a child session for the subordinate. You can call this multiple times to delegate to multiple actors, then use the "wait" action tool to wait for them all.',
      parameters: {
        type: 'object',
        properties: {
          targetActorId: { type: 'string', description: 'The UUID of the subordinate actor to delegate to' },
          instruction: { type: 'string', description: 'Detailed instruction for the subordinate about what to do' },
          priority: { type: 'string', description: 'Priority: low, medium, high, urgent', enum: ['low', 'medium', 'high', 'urgent'] },
        },
        required: ['targetActorId', 'instruction'],
      },
    },
    async (input) => {
      const { targetActorId, instruction, priority } = input as {
        targetActorId: string;
        instruction: string;
        priority?: string;
      };

      // Get context from the callable tool execution context
      const context = getToolExecutionContext();
      if (!context) {
        return JSON.stringify({ error: 'No session context available for delegation' });
      }

      // Validate target actor exists and is a subordinate
      const actorResult = await query(
        'SELECT id, name, title, parent_id FROM actors WHERE id = $1 AND is_active = true',
        [targetActorId]
      );
      if (actorResult.rows.length === 0) {
        return JSON.stringify({ error: `Actor ${targetActorId} not found or inactive` });
      }
      const targetActor = actorResult.rows[0];

      // Get parent session details
      const parentSession = await getSession(context.sessionId);
      if (!parentSession) {
        return JSON.stringify({ error: 'Parent session not found' });
      }

      try {
        // Create child session
        const childSession = await createSessionAndEnqueue({
          workspaceId: context.workspaceId,
          actorId: targetActorId,
          channelType: 'internal_delegation',
          parentSessionId: context.sessionId,
          rootSessionId: parentSession.root_session_id || context.sessionId,
          depth: (parentSession.depth || 0) + 1,
          trigger: 'delegation',
          initialMessage: instruction,
          fromActorId: context.actorId,
          metadata: { priority: priority || 'medium' },
        });

        return JSON.stringify({
          sessionId: childSession.id,
          actorName: targetActor.name,
          actorTitle: targetActor.title,
          status: 'created',
          message: `已成功委派给 ${targetActor.name}。记住返回的sessionId，稍后可以使用 wait 工具等待结果。`,
        });
      } catch (err: any) {
        return JSON.stringify({ error: `Delegation failed: ${err.message}` });
      }
    }
  );

  // ============ check_progress (callable) ============
  registerCallableTool(
    {
      name: 'check_progress',
      description: 'Check the progress of a child session (delegated task). Also notifies the subordinate that you are checking on them.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID of the child session to check' },
        },
        required: ['sessionId'],
      },
    },
    async (input) => {
      const { sessionId: childSessionId } = input as { sessionId: string };
      const context = getToolExecutionContext();

      const childSession = await getSession(childSessionId);
      if (!childSession) {
        return JSON.stringify({ error: `Session ${childSessionId} not found` });
      }

      // Get actor name
      const actorResult = await query('SELECT name FROM actors WHERE id = $1', [childSession.actor_id]);
      const actorName = actorResult.rows[0]?.name || 'Unknown';

      // Get recent messages from the child session
      const messages = await getSessionMessages(childSessionId);
      const recentMessages = messages.slice(-5).map((m: any) => ({
        role: m.role,
        content: m.content.substring(0, 500),
        createdAt: m.created_at,
      }));

      // If child session is still active, inject an interrupt
      if (childSession.status === 'active' && context) {
        await createInterrupt({
          targetSessionId: childSessionId,
          type: 'progress_check',
          content: `上级正在检查你的进度。请在下一轮回复中汇报当前进展。`,
          fromSessionId: context.sessionId,
        });
      }

      return JSON.stringify({
        sessionId: childSessionId,
        actorName,
        status: childSession.status,
        depth: childSession.depth,
        createdAt: childSession.created_at,
        completedAt: childSession.completed_at,
        recentMessages,
        waitingFor: childSession.waiting_for,
      });
    }
  );
}

// ============ Tool Execution Context ============
// Used to pass session context to callable tools during execution

interface ToolExecutionContext {
  sessionId: string;
  actorId: string;
  workspaceId: string;
}

let currentContext: ToolExecutionContext | null = null;

export function setToolExecutionContext(ctx: ToolExecutionContext | null) {
  currentContext = ctx;
}

export function getToolExecutionContext(): ToolExecutionContext | null {
  return currentContext;
}
