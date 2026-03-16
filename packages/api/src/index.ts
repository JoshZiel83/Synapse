import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { config } from "./config/index.js";
import {
  assertRequiredSchema,
  closeDatabasePool,
  testConnection,
  testRequiredSchema,
} from "./infrastructure/database/index.js";
import {
  shutdownRedisConnections,
  testRedisConnection,
} from "./infrastructure/redis/index.js";
import {
  initEventBus,
  shutdownEventBus,
} from "./infrastructure/events/index.js";
import {
  setupWebSocket,
  shutdownWebSockets,
} from "./infrastructure/websocket/index.js";
import { auditMiddleware } from "./infrastructure/middleware/audit.js";
import { beginShutdown } from "./infrastructure/shutdown/state.js";
import { ensureStorageDir } from "./infrastructure/storage/index.js";
import {
  closeAuthzClient,
  initializeAuthz,
  testAuthzConnection,
} from "./infrastructure/authz/index.js";

// Module imports
import authModule from "./modules/auth/index.js";
import workspaceModule from "./modules/workspace/index.js";
import organizationModule from "./modules/organization/index.js";
import workEngineModule from "./modules/work-engine/index.js";
import communicationModule from "./modules/communication/index.js";
import memoryModule from "./modules/memory/index.js";
import capabilitiesModule from "./modules/capabilities/index.js";
import skillsModule from "./modules/skills/index.js";
import secretaryModule from "./modules/secretary/index.js";
import sessionModule from "./modules/session/index.js";
import auditQueryModule from "./modules/audit/index.js";
import standingOrdersModule from "./modules/standing-orders/index.js";
import modelGroupsModule from "./modules/model-groups/index.js";
import groupModule from "./modules/group/index.js";
import mcpPluginsModule from "./modules/mcp-plugins/index.js";
import filesModule from "./modules/files/index.js";
import a2aModule from "./modules/a2a/index.js";
import platformModule from "./modules/platform/index.js";
import { syncConfiguredPlatformAdmins } from "./modules/platform/admin-service.js";
import { seedPlatformDefaultGroup } from "./modules/model-groups/service.js";
import { seedBuiltinMcpPlugins } from "./modules/mcp-plugins/service.js";
import { seedBuiltinActorTemplates } from "./modules/organization/service.js";
import { initBuiltinRegistry } from "./modules/mcp-plugins/builtin/index.js";
import {
  initInstanceManagerListeners,
  shutdownAllInstances,
} from "./modules/mcp-plugins/instance-manager.js";
import {
  initRelayManager,
  shutdownAllRelays,
} from "./modules/mcp-plugins/relay-manager.js";
import { recoverInterruptedExecutions } from "./modules/execution/service.js";
import { registerActionToolPlugins } from "./modules/ai/tools.js";
import { registerCallableToolPlugins } from "./modules/ai/session-tools.js";

// Workers
import { startActorThinkingWorker } from "./workers/actor-thinking.js";
import { startSessionThinkingWorker } from "./workers/session-thinking.js";
import { startSessionTimeoutWorker } from "./workers/session-timeout.js";
import { startStandingOrdersWorker } from "./workers/standing-orders.js";
import { shutdownAllWorkers } from "./workers/registry.js";
import { shutdownQueues } from "./workers/queues.js";

async function main() {
  const app = Fastify({
    logger: {
      transport:
        config.nodeEnv === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  // Plugins
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // Ensure storage directory exists
  await ensureStorageDir();

  // Audit middleware
  auditMiddleware(app);

  // WebSocket
  setupWebSocket(app);

  // Initialize event bus
  await initEventBus();

  try {
    await assertRequiredSchema();
    console.log("Database schema preflight passed");
  } catch (err) {
    console.error("Database schema preflight failed:", err);
    process.exit(1);
  }

  // Initialize SpiceDB schema and replay pending relationship writes
  try {
    const authz = await initializeAuthz();
    if (authz.enabled) {
      console.log(
        `SpiceDB initialized (schemaUpdated=${authz.schemaUpdated}, drainedOutboxEntries=${authz.drainedOutboxEntries})`,
      );
    } else {
      console.warn("SpiceDB authorization is disabled");
    }
  } catch (err) {
    console.error("Failed to initialize SpiceDB authorization:", err);
    process.exit(1);
  }

  try {
    const platformAdmins = await syncConfiguredPlatformAdmins();
    console.log(
      `Platform admins synchronized (configuredEmails=${platformAdmins.configuredEmailCount}, matchedUsers=${platformAdmins.matchedUserCount}, platformAdmins=${platformAdmins.platformAdminCount})`,
    );
  } catch (err) {
    console.error("Failed to synchronize platform admins:", err);
    process.exit(1);
  }

  // Register modules
  await app.register(authModule);
  await app.register(workspaceModule);
  await app.register(organizationModule);
  await app.register(workEngineModule);
  await app.register(communicationModule);
  await app.register(memoryModule);
  await app.register(capabilitiesModule);
  await app.register(skillsModule);
  await app.register(secretaryModule);
  await app.register(sessionModule);
  await app.register(auditQueryModule);
  await app.register(standingOrdersModule);
  await app.register(modelGroupsModule);
  await app.register(groupModule);
  await app.register(mcpPluginsModule);
  await app.register(filesModule);
  await app.register(a2aModule);
  await app.register(platformModule);

  // Seed platform default model group
  try {
    await seedPlatformDefaultGroup();
    console.log("Platform default model group seeded");
  } catch (err) {
    console.error("Failed to seed platform default model group:", err);
  }

  // Seed MCP builtin plugins and init registry
  try {
    await seedBuiltinMcpPlugins();
    await seedBuiltinActorTemplates();
    await initBuiltinRegistry();
    initInstanceManagerListeners();
    await initRelayManager();
    const recovered = await recoverInterruptedExecutions();
    if (recovered.recoveredToolCalls > 0 || recovered.recoveredTurns > 0) {
      console.warn(
        "[startup-recovery] Recovered interrupted execution state",
        recovered,
      );
    }
    console.log("MCP plugins and actor templates seeded; registry initialized");
  } catch (err) {
    console.error("Failed to seed builtin marketplace packages:", err);
  }

  // Health check
  app.get("/api/v1/health", async () => {
    const [db, dbSchema, rds, authz] = await Promise.all([
      testConnection(),
      testRequiredSchema(),
      testRedisConnection(),
      testAuthzConnection(),
    ]);
    return {
      status: db && dbSchema && rds && authz ? "healthy" : "degraded",
      services: { database: db, databaseSchema: dbSchema, redis: rds, authz },
      authzEnabled: config.authz.enabled,
      timestamp: new Date().toISOString(),
    };
  });

  // Register builtin tool plugins (action + callable)
  registerActionToolPlugins();
  registerCallableToolPlugins();

  // Start workers
  startActorThinkingWorker();
  startSessionThinkingWorker();
  startSessionTimeoutWorker();
  startStandingOrdersWorker();
  console.log(
    "Workers started (including session-thinking and session-timeout)",
  );

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Synapse API running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const waitWithTimeout = async (
    label: string,
    promise: Promise<unknown>,
    ms: number,
  ) => {
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let shutdownStarted = false;
  const gracefulShutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    beginShutdown();

    app.log.info({ signal }, "Starting graceful shutdown");

    const forceExitTimer = setTimeout(() => {
      app.log.error({ signal }, "Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 15000);
    forceExitTimer.unref();

    try {
      await shutdownAllRelays().catch((err) =>
        app.log.error({ err }, "Failed to shutdown relay connections"),
      );
      await shutdownWebSockets().catch((err) =>
        app.log.error({ err }, "Failed to shutdown websocket clients"),
      );
      await waitWithTimeout(
        "instance shutdown",
        shutdownAllInstances(),
        5000,
      ).catch((err) => {
        app.log.error({ err }, "MCP instance shutdown timed out");
      });
      app.server.closeIdleConnections?.();
      await waitWithTimeout("fastify close", app.close(), 5000).catch((err) => {
        app.log.error({ err }, "Fastify close timed out");
        app.server.closeAllConnections?.();
      });
      await waitWithTimeout(
        "worker shutdown",
        shutdownAllWorkers(),
        5000,
      ).catch((err) => {
        app.log.error({ err }, "Worker shutdown timed out");
      });
      await waitWithTimeout("queue shutdown", shutdownQueues(), 5000).catch(
        (err) => {
          app.log.error({ err }, "Queue shutdown timed out");
        },
      );
      await waitWithTimeout(
        "event bus shutdown",
        shutdownEventBus(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Event bus shutdown timed out");
      });
      await waitWithTimeout("authz shutdown", closeAuthzClient(), 3000).catch(
        (err) => {
          app.log.error({ err }, "Authz shutdown timed out");
        },
      );
      await waitWithTimeout(
        "database pool shutdown",
        closeDatabasePool(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Database pool shutdown timed out");
      });
      await waitWithTimeout(
        "redis shutdown",
        shutdownRedisConnections(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Redis shutdown timed out");
      });
      app.log.info({ signal }, "Graceful shutdown completed");
      process.exit(0);
    } catch (err) {
      app.log.error({ err, signal }, "Graceful shutdown failed");
      process.exit(1);
    } finally {
      clearTimeout(forceExitTimer);
    }
  };

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM").catch(() => {});
  });
  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT").catch(() => {});
  });
}

main();
