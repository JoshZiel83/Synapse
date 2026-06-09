import Fastify from "fastify"
import cors from "@fastify/cors"
import cookie from "@fastify/cookie"
import websocket from "@fastify/websocket"
import multipart from "@fastify/multipart"
import { ZodError } from "zod"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { config } from "./config/index.js"
import { createLogger } from "./infrastructure/logger/index.js"
import {
  assertRequiredSchema,
  closeDatabasePool,
  testConnection,
  testRequiredSchema,
} from "./infrastructure/database/index.js"
import {
  shutdownRedisConnections,
  testRedisConnection,
} from "./infrastructure/redis/index.js"
import {
  initEventBus,
  startRealtimeEventOutboxDispatcher,
  shutdownEventBus,
} from "./infrastructure/events/index.js"
import { auditMiddleware } from "./infrastructure/middleware/audit.js"
import { beginShutdown } from "./infrastructure/shutdown/state.js"
import { withTimeout } from "./infrastructure/async/index.js"
import { ensureStorageDir } from "./infrastructure/storage/index.js"
import {
  setupWebSocket,
  shutdownWebSockets,
} from "./infrastructure/websocket/index.js"

// Module imports
import authModule from "./modules/auth/index.js"
import workspaceModule from "./modules/workspace/index.js"
import organizationModule from "./modules/organization/index.js"
import skillsModule from "./modules/skills/index.js"
import chatModule from "./modules/chat/index.js"
import relationshipModule from "./modules/relationship/index.js"
import remoteAgentsModule from "./modules/remote-agents/index.js"
import automationModule from "./modules/automation/index.js"
import filesModule from "./modules/files/index.js"
import memoryModule from "./modules/memory/index.js"
import mcpPluginsModule from "./modules/mcp-plugins/index.js"
import devicesModule from "./modules/devices/index.js"
import runtimeAuthorizationsModule from "./modules/runtime-authorizations/index.js"
import modelGroupsModule from "./modules/model-groups/index.js"
import platformModule from "./modules/platform/index.js"
import auditModule from "./modules/audit/index.js"
import imModule from "./modules/im/index.js"
import installerModule from "./modules/installer/index.js"
import {
  startTransportRuntimeManager,
  stopTransportRuntimeManager,
} from "./modules/im/runtime.js"
import { initBuiltinRegistry } from "./modules/mcp-plugins/builtin/index.js"
import {
  initInstanceManagerListeners,
  shutdownAllInstances,
} from "./modules/mcp-plugins/instance-manager.js"
import { recoverInterruptedExecutions } from "./modules/execution/service.js"
import {
  recoverFailedSandboxMounts,
  reconcileSandboxes,
} from "./modules/sandbox/index.js"
import { registerActorStateCallableToolPlugins } from "./modules/ai/tools.js"
import { registerActorFileToolPlugins } from "./modules/ai/file-tools.js"
import { registerCallableToolPlugins } from "./modules/ai/session-tools.js"
import { startSessionThinkingWorker } from "./workers/session-thinking.js"
import {
  ensureAutomationSchedulerJob,
  startAutomationSchedulerWorker,
} from "./workers/automation-scheduler.js"
import { startAutomationExecutionWorker } from "./workers/automation-execution.js"
import { startImTransportDeliveryWorker } from "./workers/im-transport-delivery.js"
import {
  startTaskProjectionWorker,
  stopTaskProjectionWorker,
} from "./workers/task-projection.js"
import {
  startDeviceTaskSweeper,
  stopDeviceTaskSweeper,
} from "./workers/device-task-sweeper.js"
import {
  startTransportOutboxSweeper,
  stopTransportOutboxSweeper,
} from "./workers/outbox-sweeper.js"
import { installActorStatusHooks } from "./modules/im/integration/actor-status-hooks.js"
import { startMemoryIndexingWorker } from "./workers/memory-indexing.js"
import { startFileParsingWorker } from "./workers/file-parsing.js"
import {
  ensureRemoteAgentDeliveryRetryJob,
  startRemoteAgentDeliveryRetryWorker,
} from "./workers/remote-agent-delivery-retry.js"
import { shutdownAllWorkers } from "./workers/registry.js"
import { shutdownQueues } from "./workers/queues.js"
import {
  startChatDedupCounterLogger,
  stopChatDedupCounterLogger,
} from "./modules/chat/observability.js"
import {
  getMemoryEmbeddingRuntimeHealth,
  shutdownMemoryEmbeddingRuntime,
  warmMemoryEmbeddingRuntime,
} from "./modules/memory/embedding-runtime.js"

const log = createLogger("server")

function isMalformedUuidDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === "22P02" &&
    typeof candidate.message === "string" &&
    /invalid input syntax for type uuid/i.test(candidate.message)
  )
}

async function main() {
  const app = Fastify({
    logger: {
      transport:
        config.nodeEnv === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  })

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      try {
        ;(request as any).rawBody = body
        const trimmed = typeof body === "string" ? body.trim() : ""
        done(null, trimmed ? JSON.parse(trimmed) : {})
      } catch (error) {
        done(error as Error, undefined)
      }
    }
  )

  app.setErrorHandler((error, request, reply) => {
    if (isMalformedUuidDatabaseError(error)) {
      return reply.status(400).send({
        error: "Invalid request",
        code: "invalid_request",
      })
    }

    // Centralized ZodError → 400. Without this, per-transport
    // controllers (Feishu, Weixin, WeCom, QQ, DingTalk, …) each have
    // to wrap their `schema.parse()` in try/catch or the failure
    // becomes a 500. Stable `code: "invalid_request"` lets clients
    // discriminate validation errors from other 4xx codes; existing
    // WeCom integration tests already rely on this constant.
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "validation failed",
        code: "invalid_request",
        issues: error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        })),
      })
    }

    request.log.error(error)

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number" &&
      (error as { statusCode: number }).statusCode >= 400
        ? (error as { statusCode: number }).statusCode
        : 500

    return reply.status(statusCode).send({
      error:
        statusCode >= 500
          ? "Internal Server Error"
          : error.message || "Request failed",
      code:
        statusCode >= 500
          ? "internal_server_error"
          : typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "request_error",
    })
  })

  // Plugins
  await app.register(cors, { origin: true, credentials: true })
  await app.register(cookie)
  await app.register(websocket)
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } })

  // Ensure storage directory exists
  await ensureStorageDir()

  // Audit middleware
  auditMiddleware(app)

  // WebSocket routes and auth/session registry
  setupWebSocket(app)

  // Event bus backs websocket fanout and runtime notifications.
  await initEventBus()

  try {
    await assertRequiredSchema()
    log.info("Database schema preflight passed")
  } catch (err) {
    log.error({ err }, "Database schema preflight failed")
    process.exit(1)
  }

  await startRealtimeEventOutboxDispatcher()
  if (process.env.CHAT_DEDUP_LOGGER === "1") {
    startChatDedupCounterLogger()
  }

  // NOTE: startup config-email -> super_admin auto-grant was intentionally
  // removed. Granting super_admin merely because a registering user's email
  // matches PLATFORM_ADMIN_EMAILS is a privilege-escalation hole (it does not
  // prove email ownership, and email verification is not yet wired). Platform
  // admins are now provisioned only via seed / explicit bootstrap
  // (ensureSeedPlatformAdminForUser). Reintroduce a verified-email-gated grant
  // once email verification delivery exists.

  // Register modules
  await app.register(authModule)
  await app.register(workspaceModule)
  await app.register(organizationModule)
  await app.register(skillsModule)
  await app.register(chatModule)
  await app.register(relationshipModule)
  await app.register(remoteAgentsModule)
  await app.register(automationModule)
  await app.register(filesModule)
  await app.register(memoryModule)
  await app.register(mcpPluginsModule)
  await app.register(devicesModule)
  await app.register(runtimeAuthorizationsModule)
  await app.register(modelGroupsModule)
  await app.register(platformModule)
  await app.register(auditModule)
  await app.register(imModule)
  await app.register(installerModule)

  try {
    await initBuiltinRegistry()
    initInstanceManagerListeners()
  } catch (err) {
    log.error({ err }, "Failed to initialize MCP runtime")
    process.exit(1)
  }

  // Health check
  app.get("/api/v1/health", async () => {
    const [db, dbSchema, rds, memoryEmbeddings] = await Promise.all([
      testConnection(),
      testRequiredSchema(),
      testRedisConnection(),
      Promise.resolve(getMemoryEmbeddingRuntimeHealth()),
    ])
    return {
      status:
        db && dbSchema && rds && memoryEmbeddings.ready
          ? "healthy"
          : "degraded",
      services: {
        database: db,
        databaseSchema: dbSchema,
        redis: rds,
        memoryEmbeddings,
      },
      timestamp: nowIsoInstant(),
    }
  })

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host })
    log.info(`Synapse API running on http://${config.host}:${config.port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  try {
    const recovered = await recoverInterruptedExecutions({
      errorMessage:
        "Recovered after the previous worker stopped while this turn was still running.",
    })
    if (
      recovered.recoveredToolCalls > 0 ||
      recovered.recoveredTurns > 0 ||
      recovered.recoveredSessions > 0
    ) {
      log.warn(
        `Recovered interrupted executions (toolCalls=${recovered.recoveredToolCalls}, turns=${recovered.recoveredTurns}, sessions=${recovered.recoveredSessions})`
      )
    }
  } catch (err) {
    log.error({ err }, "Failed to recover interrupted executions")
  }

  // Recover sandbox mounts whose teardown commit failed earlier (live dirs were
  // preserved). Opt-in with the sandbox feature; best-effort.
  if (config.sandbox.enabled) {
    try {
      const r = await recoverFailedSandboxMounts()
      if (r.attempted > 0) {
        console.warn(
          `Recovered sandbox mounts (attempted=${r.attempted}, recovered=${r.recovered}, stillFailed=${r.stillFailed})`
        )
      }
    } catch (err) {
      console.error("Failed to recover sandbox mounts:", err)
    }
    // Tear down sandboxes left dangling by a crash (stale mounts + their
    // runtimes) and reap label-only docker orphans, so the next turn
    // re-provisions cleanly. Best-effort; runs after the commit-recovery above.
    try {
      await reconcileSandboxes()
    } catch (err) {
      console.error("Failed to reconcile sandboxes:", err)
    }
  }

  registerActorStateCallableToolPlugins()
  registerCallableToolPlugins()
  registerActorFileToolPlugins()
  await ensureAutomationSchedulerJob()
  startAutomationSchedulerWorker()
  startAutomationExecutionWorker()
  startSessionThinkingWorker()
  startImTransportDeliveryWorker()
  startTransportOutboxSweeper()
  startTaskProjectionWorker()
  startDeviceTaskSweeper()
  installActorStatusHooks()
  startMemoryIndexingWorker()
  startFileParsingWorker()
  await ensureRemoteAgentDeliveryRetryJob()
  startRemoteAgentDeliveryRetryWorker()
  void warmMemoryEmbeddingRuntime().catch((err) => {
    log.error({ err }, "Failed to warm memory embedding runtime")
  })
  if (config.im.runtimeManagerEnabled) {
    await startTransportRuntimeManager()
  } else {
    log.info("[im] Transport runtime manager disabled on this instance")
  }

  const waitWithTimeout = (
    label: string,
    promise: Promise<unknown>,
    ms: number
  ) => withTimeout(promise, ms, label)

  let shutdownStarted = false
  const gracefulShutdown = async (signal: string) => {
    if (shutdownStarted) return
    shutdownStarted = true
    beginShutdown()

    app.log.info({ signal }, "Starting graceful shutdown")

    const forceExitTimer = setTimeout(() => {
      app.log.error({ signal }, "Graceful shutdown timed out, forcing exit")
      process.exit(1)
    }, 15000)
    forceExitTimer.unref()

    try {
      app.server.closeIdleConnections?.()
      await waitWithTimeout(
        "websocket shutdown",
        shutdownWebSockets(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "WebSocket shutdown timed out")
      })
      await waitWithTimeout(
        "transport runtime shutdown",
        stopTransportRuntimeManager(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Transport runtime shutdown timed out")
      })
      await waitWithTimeout(
        "outbox sweeper shutdown",
        stopTransportOutboxSweeper(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Outbox sweeper shutdown timed out")
      })
      await waitWithTimeout(
        "task projection worker shutdown",
        stopTaskProjectionWorker(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Task projection worker shutdown timed out")
      })
      await waitWithTimeout(
        "device task sweeper shutdown",
        stopDeviceTaskSweeper(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Device task sweeper shutdown timed out")
      })
      await waitWithTimeout(
        "worker shutdown",
        shutdownAllWorkers(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Worker shutdown timed out")
      })
      await waitWithTimeout("queue shutdown", shutdownQueues(), 3000).catch(
        (err) => {
          app.log.error({ err }, "Queue shutdown timed out")
        }
      )
      await waitWithTimeout(
        "memory embedding runtime shutdown",
        shutdownMemoryEmbeddingRuntime(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Memory embedding runtime shutdown timed out")
      })
      await waitWithTimeout(
        "event bus shutdown",
        shutdownEventBus(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Event bus shutdown timed out")
      })
      stopChatDedupCounterLogger()
      await waitWithTimeout(
        "plugin instance shutdown",
        shutdownAllInstances(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Plugin instance shutdown timed out")
      })
      await waitWithTimeout("fastify close", app.close(), 5000).catch((err) => {
        app.log.error({ err }, "Fastify close timed out")
        app.server.closeAllConnections?.()
      })
      await waitWithTimeout(
        "database pool shutdown",
        closeDatabasePool(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Database pool shutdown timed out")
      })
      await waitWithTimeout(
        "redis shutdown",
        shutdownRedisConnections(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Redis shutdown timed out")
      })
      app.log.info({ signal }, "Graceful shutdown completed")
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, "Graceful shutdown failed")
      process.exit(1)
    } finally {
      clearTimeout(forceExitTimer)
    }
  }

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM").catch(() => {})
  })
  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT").catch(() => {})
  })
}

main()
