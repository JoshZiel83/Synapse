import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../infrastructure/middleware/auth.js';
import { a2aAuthMiddleware, a2aRateLimitMiddleware } from './middleware.js';
import {
  createA2AApp, listA2AApps, getA2AAppById, updateA2AApp, deleteA2AApp,
  regenerateApiKey, setAppActors, getAppActors, createA2ATask, getA2ATask,
  listA2ATasks,
} from './service.js';
import { generateAgentCard, generateMultiAgentCard } from './actor-card.js';
import { buildTaskResponse } from './protocol.js';
import {
  getSession, getSessionMessages, addSessionMessage,
  updateSessionStatus, cancelSession, createSession,
} from '../session/service.js';
import { query } from '../../infrastructure/database/index.js';
import { sessionThinkingQueue } from '../../workers/queues.js';

// ============ Management Routes (JWT auth) ============

export async function a2aManagementController(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // List apps
  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/workspaces/:workspaceId/a2a/apps',
    async (request, reply) => {
      const apps = await listA2AApps(request.params.workspaceId);
      // Attach actors for each app
      const appsWithActors = await Promise.all(apps.map(async (a) => {
        const actors = await getAppActors(a.id);
        return { ...a, actors };
      }));
      return reply.send({ apps: appsWithActors });
    }
  );

  // Create app
  app.post<{ Params: { workspaceId: string }; Body: any }>(
    '/api/v1/workspaces/:workspaceId/a2a/apps',
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1).max(255),
        description: z.string().max(2000).optional(),
        actorIds: z.array(z.string().uuid()).min(1),
        rateLimitRpm: z.number().int().min(1).max(10000).optional(),
      });
      const body = schema.parse(request.body);
      const userId = (request as any).user!.userId;

      const { app: a2aApp, apiKey } = await createA2AApp({
        workspaceId: request.params.workspaceId,
        name: body.name,
        description: body.description,
        actorIds: body.actorIds,
        rateLimitRpm: body.rateLimitRpm,
        createdBy: userId,
      });

      const actors = await getAppActors(a2aApp.id);
      return reply.status(201).send({ app: { ...a2aApp, actors }, apiKey });
    }
  );

  // Get app
  app.get<{ Params: { workspaceId: string; appId: string } }>(
    '/api/v1/workspaces/:workspaceId/a2a/apps/:appId',
    async (request, reply) => {
      const a2aApp = await getA2AAppById(request.params.appId);
      if (!a2aApp || a2aApp.workspaceId !== request.params.workspaceId) {
        return reply.status(404).send({ error: 'App not found' });
      }
      const actors = await getAppActors(a2aApp.id);
      return reply.send({ app: { ...a2aApp, actors } });
    }
  );

  // Update app
  app.put<{ Params: { workspaceId: string; appId: string }; Body: any }>(
    '/api/v1/workspaces/:workspaceId/a2a/apps/:appId',
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(2000).optional(),
        rateLimitRpm: z.number().int().min(1).max(10000).optional(),
        isActive: z.boolean().optional(),
        actorIds: z.array(z.string().uuid()).optional(),
      });
      const body = schema.parse(request.body);

      const { actorIds, ...updates } = body;
      const updated = await updateA2AApp(request.params.appId, updates);
      if (!updated) return reply.status(404).send({ error: 'App not found' });

      if (actorIds) {
        await setAppActors(request.params.appId, actorIds);
      }

      const actors = await getAppActors(updated.id);
      return reply.send({ app: { ...updated, actors } });
    }
  );

  // Delete app
  app.delete<{ Params: { workspaceId: string; appId: string } }>(
    '/api/v1/workspaces/:workspaceId/a2a/apps/:appId',
    async (request, reply) => {
      const deleted = await deleteA2AApp(request.params.appId);
      if (!deleted) return reply.status(404).send({ error: 'App not found' });
      return reply.status(204).send();
    }
  );

  // Regenerate API key
  app.post<{ Params: { workspaceId: string; appId: string } }>(
    '/api/v1/workspaces/:workspaceId/a2a/apps/:appId/regenerate-key',
    async (request, reply) => {
      const result = await regenerateApiKey(request.params.appId);
      if (!result) return reply.status(404).send({ error: 'App not found' });
      return reply.send(result);
    }
  );
}

// ============ Protocol Routes (API Key auth) ============

export async function a2aProtocolController(app: FastifyInstance) {
  // Agent Card — no auth needed (discovery endpoint)
  app.get<{ Params: { appId: string } }>(
    '/a2a/:appId/.well-known/agent.json',
    async (request, reply) => {
      const a2aApp = await getA2AAppById(request.params.appId);
      if (!a2aApp || !a2aApp.isActive) {
        return reply.status(404).send({ error: 'App not found' });
      }

      const actors = await getAppActors(a2aApp.id);
      const baseUrl = `${request.protocol}://${request.hostname}`;

      let card;
      if (actors.length === 1) {
        card = generateAgentCard(actors[0], a2aApp.id, baseUrl);
      } else {
        card = generateMultiAgentCard(actors, a2aApp.name, a2aApp.description, a2aApp.id, baseUrl);
      }

      return reply.send(card);
    }
  );

  // JSON-RPC 2.0 endpoint — requires API key
  app.post<{ Params: { appId: string } }>(
    '/a2a/:appId',
    { preHandler: [a2aAuthMiddleware, a2aRateLimitMiddleware] },
    async (request, reply) => {
      const body = request.body as any;

      // Validate JSON-RPC envelope
      if (!body || body.jsonrpc !== '2.0' || !body.method || body.id === undefined) {
        return reply.status(400).send({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
          id: body?.id ?? null,
        });
      }

      const a2aApp = (request as any).a2aApp;
      const workspaceId = (request as any).a2aWorkspaceId;

      // Verify appId matches authenticated app
      if (a2aApp.id !== request.params.appId) {
        return reply.status(403).send({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'API key does not match app' },
          id: body.id,
        });
      }

      try {
        let result;
        switch (body.method) {
          case 'message/send':
            result = await handleMessageSend(a2aApp, workspaceId, body.params, body.id);
            break;
          case 'tasks/get':
            result = await handleTasksGet(a2aApp, body.params, body.id);
            break;
          case 'tasks/cancel':
            result = await handleTasksCancel(a2aApp, body.params, body.id);
            break;
          case 'tasks/list':
            result = await handleTasksList(a2aApp, body.params, body.id);
            break;
          default:
            return reply.send({
              jsonrpc: '2.0',
              error: { code: -32601, message: `Method not found: ${body.method}` },
              id: body.id,
            });
        }
        return reply.send({ jsonrpc: '2.0', result, id: body.id });
      } catch (err: any) {
        return reply.send({
          jsonrpc: '2.0',
          error: { code: -32000, message: err.message },
          id: body.id,
        });
      }
    }
  );
}

// ============ JSON-RPC Method Handlers ============

async function handleMessageSend(a2aApp: any, workspaceId: string, params: any, rpcId: any) {
  if (!params?.message) {
    throw new Error('Missing message parameter');
  }

  const message = params.message;
  // Extract text from parts
  const textParts = (message.parts || [])
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text);

  if (textParts.length === 0) {
    throw new Error('Message must contain at least one text part');
  }

  const content = textParts.join('\n');
  const contextId = params.contextId;

  // Get app actors to determine target
  const actors = await getAppActors(a2aApp.id);
  if (actors.length === 0) {
    throw new Error('No actors configured for this app');
  }

  // Select target actor: use first actor, or match by skill if specified
  let targetActor = actors[0];
  if (params.targetActorName) {
    const found = actors.find((a: any) => a.name === params.targetActorName);
    if (found) targetActor = found;
  }

  // Check for existing task with this contextId
  if (contextId) {
    const existingTasks = await query(
      `SELECT t.id, t.session_id FROM a2a_tasks t
       WHERE t.app_id = $1 AND t.context_id = $2
       ORDER BY t.created_at DESC LIMIT 1`,
      [a2aApp.id, contextId]
    );

    if (existingTasks.rows.length > 0) {
      // Add message to existing session
      const existingTask = existingTasks.rows[0];
      const session = await getSession(existingTask.session_id);
      if (session && !['completed', 'failed', 'cancelled', 'timed_out'].includes(session.status)) {
        await addSessionMessage({
          sessionId: existingTask.session_id,
          workspaceId,
          role: 'user',
          content,
        });

        // Resume if sleeping
        if (session.status === 'sleeping') {
          await updateSessionStatus(existingTask.session_id, 'active');
          await sessionThinkingQueue.add('think', {
            sessionId: existingTask.session_id,
            actorId: session.actor_id,
            workspaceId,
            trigger: 'a2a_message',
          });
        }

        return buildTaskResponse(existingTask.id, existingTask.session_id, contextId);
      }
    }
  }

  // Create new session
  const session = await createSession({
    workspaceId,
    actorId: targetActor.id,
    channelType: 'api',
    trigger: 'api_call',
    metadata: { a2aAppId: a2aApp.id, contextId },
  });

  // Add the initial message
  await addSessionMessage({
    sessionId: session.id,
    workspaceId,
    role: 'user',
    content,
  });

  // Enqueue thinking
  await sessionThinkingQueue.add('think', {
    sessionId: session.id,
    actorId: targetActor.id,
    workspaceId,
    trigger: 'api_call',
  });

  // Create A2A task mapping
  const taskId = await createA2ATask(a2aApp.id, session.id, contextId);

  // If blocking requested, wait for completion
  if (params.blocking) {
    const result = await waitForSession(session.id, params.timeout || 60);
    return buildTaskResponse(taskId, session.id, contextId);
  }

  return buildTaskResponse(taskId, session.id, contextId);
}

async function handleTasksGet(a2aApp: any, params: any, rpcId: any) {
  if (!params?.id) {
    throw new Error('Missing task id');
  }

  const task = await getA2ATask(params.id);
  if (!task || task.app_id !== a2aApp.id) {
    throw new Error('Task not found');
  }

  return buildTaskResponse(task.id, task.session_id, task.context_id, params.historyLength > 0);
}

async function handleTasksCancel(a2aApp: any, params: any, rpcId: any) {
  if (!params?.id) {
    throw new Error('Missing task id');
  }

  const task = await getA2ATask(params.id);
  if (!task || task.app_id !== a2aApp.id) {
    throw new Error('Task not found');
  }

  await cancelSession(task.session_id);
  return buildTaskResponse(task.id, task.session_id, task.context_id);
}

async function handleTasksList(a2aApp: any, params: any, rpcId: any) {
  const limit = params?.limit || 50;
  const offset = params?.offset || 0;
  const tasks = await listA2ATasks(a2aApp.id, limit, offset);

  return {
    tasks: await Promise.all(tasks.map(async (t: any) =>
      buildTaskResponse(t.id, t.session_id, t.context_id)
    )),
  };
}

// ============ Helpers ============

async function waitForSession(sessionId: string, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  const poll = 1000; // 1 second polling

  while (Date.now() < deadline) {
    const session = await getSession(sessionId);
    if (!session) break;
    // sleeping = actor finished its turn (auto-slept after responding)
    if (['completed', 'failed', 'cancelled', 'timed_out', 'sleeping'].includes(session.status)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, poll));
  }
}
