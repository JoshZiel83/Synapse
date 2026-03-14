import type { SessionStatus, A2ATaskState, A2AMessage, A2ATaskResponse, A2APart } from '@synapse/shared';
import { getSession, getSessionMessages } from '../session/service.js';

export function sessionStatusToTaskState(status: SessionStatus): A2ATaskState {
  switch (status) {
    case 'queued':
    case 'running':
      return 'working';
    case 'blocked':
      return 'failed';
    case 'closed':
      return 'canceled';
    default:
      return 'submitted';
  }
}

export function buildA2AMessage(role: 'user' | 'agent', content: string): A2AMessage {
  return {
    role,
    parts: [{ type: 'text', text: content }],
  };
}

export async function buildTaskResponse(
  taskId: string,
  sessionId: string,
  contextId?: string,
  includeHistory = false,
): Promise<A2ATaskResponse> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // For A2A/direct sessions, idle means the actor finished its latest turn.
  let state = sessionStatusToTaskState(session.status);
  if (session.status === 'idle' && !session.group_id) {
    state = 'completed';
  }
  const messages = await getSessionMessages(sessionId);

  // Find the last assistant message for the status message
  const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === 'assistant');
  const statusMessage = lastAssistantMsg
    ? buildA2AMessage('agent', lastAssistantMsg.content)
    : undefined;

  const response: A2ATaskResponse = {
    id: taskId,
    contextId: contextId || undefined,
    status: {
      state,
      message: statusMessage,
      timestamp: session.updated_at || session.created_at,
    },
  };

  // If completed (or idle=completed for A2A), add the final result as an artifact
  if (state === 'completed' && lastAssistantMsg) {
    response.artifacts = [{
      parts: [{ type: 'text', text: lastAssistantMsg.content }],
      index: 0,
    }];
  }

  // Optionally include message history
  if (includeHistory) {
    response.history = messages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => buildA2AMessage(
        m.role === 'user' ? 'user' : 'agent',
        m.content,
      ));
  }

  return response;
}
