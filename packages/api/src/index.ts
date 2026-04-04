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
  startRealtimeEventOutboxDispatcher,
  shutdownEventBus,
} from "./infrastructure/events/index.js";
import { auditMiddleware } from "./infrastructure/middleware/audit.js";
import { beginShutdown } from "./infrastructure/shutdown/state.js";
import { ensureStorageDir } from "./infrastructure/storage/index.js";
import {
  closeAuthzClient,
  initializeAuthz,
  testAuthzConnection,
} from "./infrastructure/authz/index.js";
import {
  setupWebSocket,
  shutdownWebSockets,
} from "./infrastructure/websocket/index.js";

// Module imports
import authModule from "./modules/auth/index.js";
import workspaceModule from "./modules/workspace/index.js";
import organizationModule from "./modules/organization/index.js";
import skillsModule from "./modules/skills/index.js";
import chatModule from "./modules/chat/index.js";
import relationshipModule from "./modules/relationship/index.js";
import automationModule from "./modules/automation/index.js";
import filesModule from "./modules/files/index.js";
import memoryModule from "./modules/memory/index.js";
import mcpPluginsModule from "./modules/mcp-plugins/index.js";
import modelGroupsModule from "./modules/model-groups/index.js";
import platformModule from "./modules/platform/index.js";
import auditModule from "./modules/audit/index.js";
import imModule from "./modules/im/index.js";
import {
  startTransportRuntimeManager,
  stopTransportRuntimeManager,
} from "./modules/im/runtime.js";
import { syncConfiguredPlatformAdmins } from "./modules/platform/admin-service.js";
import { initBuiltinRegistry } from "./modules/mcp-plugins/builtin/index.js";
import {
  initRelayManager,
  shutdownAllRelays,
} from "./modules/mcp-plugins/relay-manager.js";
import {
  initInstanceManagerListeners,
  shutdownAllInstances,
} from "./modules/mcp-plugins/instance-manager.js";
import { recoverInterruptedExecutions } from "./modules/execution/service.js";
import { registerActionToolPlugins } from "./modules/ai/tools.js";
import { registerActorFileToolPlugins } from "./modules/ai/file-tools.js";
import { registerCallableToolPlugins } from "./modules/ai/session-tools.js";
import { startSessionThinkingWorker } from "./workers/session-thinking.js";
import { ensureAutomationSchedulerJob, startAutomationSchedulerWorker } from "./workers/automation-scheduler.js";
import { startAutomationExecutionWorker } from "./workers/automation-execution.js";
import { startImTransportDeliveryWorker } from "./workers/im-transport-delivery.js";
import { startMemoryIndexingWorker } from "./workers/memory-indexing.js";
import { startFileParsingWorker } from "./workers/file-parsing.js";
import { shutdownAllWorkers } from "./workers/registry.js";
import { shutdownQueues } from "./workers/queues.js";
import {
  getMemoryEmbeddingRuntimeHealth,
  shutdownMemoryEmbeddingRuntime,
  warmMemoryEmbeddingRuntime,
} from "./modules/memory/embedding-runtime.js";

async function main() {
  const app = Fastify({
    logger: {
      transport:
        config.nodeEnv === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    try {
      (request as any).rawBody = body;
      const trimmed = typeof body === "string" ? body.trim() : "";
      done(null, trimmed ? JSON.parse(trimmed) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
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

  // WebSocket routes and auth/session registry
  setupWebSocket(app);

  // Event bus backs websocket fanout and runtime notifications.
  await initEventBus();

  try {
    await assertRequiredSchema();
    console.log("Database schema preflight passed");
  } catch (err) {
    console.error("Database schema preflight failed:", err);
    process.exit(1);
  }

  await startRealtimeEventOutboxDispatcher();

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
  await app.register(skillsModule);
  await app.register(chatModule);
  await app.register(relationshipModule);
  await app.register(automationModule);
  await app.register(filesModule);
  await app.register(memoryModule);
  await app.register(mcpPluginsModule);
  await app.register(modelGroupsModule);
  await app.register(platformModule);
  await app.register(auditModule);
  await app.register(imModule);

  try {
    await initBuiltinRegistry();
    initInstanceManagerListeners();
    await initRelayManager();
  } catch (err) {
    console.error("Failed to initialize MCP runtime:", err);
    process.exit(1);
  }

  // Health check
  app.get("/api/v1/health", async () => {
    const [db, dbSchema, rds, authz, memoryEmbeddings] = await Promise.all([
      testConnection(),
      testRequiredSchema(),
      testRedisConnection(),
      testAuthzConnection(),
      Promise.resolve(getMemoryEmbeddingRuntimeHealth()),
    ]);
    return {
      status: db && dbSchema && rds && authz && memoryEmbeddings.ready ? "healthy" : "degraded",
      services: {
        database: db,
        databaseSchema: dbSchema,
        redis: rds,
        authz,
        memoryEmbeddings,
      },
      authzEnabled: config.authz.enabled,
      timestamp: new Date().toISOString(),
    };
  });

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`Synapse API running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  try {
    const recovered = await recoverInterruptedExecutions({
      errorMessage:
        "Recovered after the previous worker stopped while this turn was still running.",
    });
    if (
      recovered.recoveredToolCalls > 0 ||
      recovered.recoveredTurns > 0 ||
      recovered.recoveredSessions > 0
    ) {
      console.warn(
        `Recovered interrupted executions (toolCalls=${recovered.recoveredToolCalls}, turns=${recovered.recoveredTurns}, sessions=${recovered.recoveredSessions})`,
      );
    }
  } catch (err) {
    console.error("Failed to recover interrupted executions:", err);
  }

  registerActionToolPlugins();
  registerCallableToolPlugins();
  registerActorFileToolPlugins();
  await ensureAutomationSchedulerJob();
  startAutomationSchedulerWorker();
  startAutomationExecutionWorker();
  startSessionThinkingWorker();
  startImTransportDeliveryWorker();
  startMemoryIndexingWorker();
  startFileParsingWorker();
  void warmMemoryEmbeddingRuntime().catch((err) => {
    console.error("Failed to warm memory embedding runtime:", err);
  });
  if (config.im.runtimeManagerEnabled) {
    await startTransportRuntimeManager();
  } else {
    console.log("[im] Transport runtime manager disabled on this instance");
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
      app.server.closeIdleConnections?.();
      await waitWithTimeout(
        "websocket shutdown",
        shutdownWebSockets(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "WebSocket shutdown timed out");
      });
      await waitWithTimeout(
        "transport runtime shutdown",
        stopTransportRuntimeManager(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Transport runtime shutdown timed out");
      });
      await waitWithTimeout(
        "worker shutdown",
        shutdownAllWorkers(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Worker shutdown timed out");
      });
      await waitWithTimeout(
        "queue shutdown",
        shutdownQueues(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Queue shutdown timed out");
      });
      await waitWithTimeout(
        "memory embedding runtime shutdown",
        shutdownMemoryEmbeddingRuntime(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Memory embedding runtime shutdown timed out");
      });
      await waitWithTimeout(
        "event bus shutdown",
        shutdownEventBus(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Event bus shutdown timed out");
      });
      await waitWithTimeout(
        "plugin instance shutdown",
        shutdownAllInstances(),
        3000,
      ).catch((err) => {
        app.log.error({ err }, "Plugin instance shutdown timed out");
      });
      await waitWithTimeout("relay runtime shutdown", shutdownAllRelays(), 3000)
        .catch((err) => {
          app.log.error({ err }, "Relay runtime shutdown timed out");
        });
      await waitWithTimeout("fastify close", app.close(), 5000).catch((err) => {
        app.log.error({ err }, "Fastify close timed out");
        app.server.closeAllConnections?.();
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
