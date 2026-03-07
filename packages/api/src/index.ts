import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { config } from './config/index.js';
import { testConnection } from './infrastructure/database/index.js';
import { testRedisConnection } from './infrastructure/redis/index.js';
import { initEventBus } from './infrastructure/events/index.js';
import { setupWebSocket } from './infrastructure/websocket/index.js';
import { auditMiddleware } from './infrastructure/middleware/audit.js';

// Module imports
import authModule from './modules/auth/index.js';
import workspaceModule from './modules/workspace/index.js';
import organizationModule from './modules/organization/index.js';
import workEngineModule from './modules/work-engine/index.js';
import communicationModule from './modules/communication/index.js';
import memoryModule from './modules/memory/index.js';
import secretaryModule from './modules/secretary/index.js';
import auditQueryModule from './modules/audit/index.js';
import standingOrdersModule from './modules/standing-orders/index.js';
import modelGroupsModule from './modules/model-groups/index.js';
import { seedPlatformDefaultGroup } from './modules/model-groups/service.js';

// Workers
import { startActorThinkingWorker } from './workers/actor-thinking.js';
import { startMemoryArchivalWorker } from './workers/memory-archival.js';
import { startStandingOrdersWorker } from './workers/standing-orders.js';

async function main() {
  const app = Fastify({
    logger: {
      transport: config.nodeEnv === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // Plugins
  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: config.jwt.secret });
  await app.register(websocket);

  // Audit middleware
  auditMiddleware(app);

  // WebSocket
  setupWebSocket(app);

  // Initialize event bus
  await initEventBus();

  // Register modules
  await app.register(authModule);
  await app.register(workspaceModule);
  await app.register(organizationModule);
  await app.register(workEngineModule);
  await app.register(communicationModule);
  await app.register(memoryModule);
  await app.register(secretaryModule);
  await app.register(auditQueryModule);
  await app.register(standingOrdersModule);
  await app.register(modelGroupsModule);

  // Seed platform default model group
  try {
    await seedPlatformDefaultGroup();
    console.log('Platform default model group seeded');
  } catch (err) {
    console.error('Failed to seed platform default model group:', err);
  }

  // Health check
  app.get('/api/v1/health', async () => {
    const [db, rds] = await Promise.all([testConnection(), testRedisConnection()]);
    return {
      status: db && rds ? 'healthy' : 'degraded',
      services: { database: db, redis: rds },
      timestamp: new Date().toISOString(),
    };
  });

  // Start workers
  startActorThinkingWorker();
  startMemoryArchivalWorker();
  startStandingOrdersWorker();
  console.log('Workers started');

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Synapse API running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
