import type { FastifyInstance } from 'fastify';
import { sessionController } from './controller.js';

export default async function sessionModule(app: FastifyInstance) {
  app.register(sessionController, { prefix: '/api/v1' });
}

export {
  createSession,
  getSession,
  getSessionsByActor,
  getSessionMessages,
  addSessionMessage,
  updateSessionStatus,
  consumeInterrupts,
  createInterrupt,
  getSessionTree,
  createSessionAndEnqueue,
  cancelSession,
  getActiveSessionCount,
  getMaxConcurrentSessions,
} from './service.js';

export { onSessionCompleted, resumeSession } from './completion.js';
