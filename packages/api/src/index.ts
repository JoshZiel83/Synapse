// Tracing/instrumentation MUST initialize before anything that creates HTTP
// servers or clients, so this is the very first import (its module body sets up
// OpenTelemetry + optional Sentry as a side effect). It also exports the Fastify
// OpenTelemetry plugin registered below.
import {
  fastifyOtelInstrumentation,
  setupSentryErrorHandler,
  shutdownTelemetry,
} from "./instrumentation.js"
import { randomUUID } from "node:crypto"
import Fastify, { type FastifyBaseLogger } from "fastify"
import cors from "@fastify/cors"
import cookie from "@fastify/cookie"
import websocket from "@fastify/websocket"
import multipart from "@fastify/multipart"
import rateLimit from "@fastify/rate-limit"
import { ZodError } from "zod"
import { nowIsoInstant } from "@synapse/shared/datetime"
import { config } from "./config/index.js"
import { createLogger, logger } from "./infrastructure/logger/index.js"
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
import serverTiming from "./infrastructure/observability/server-timing.js"
import { beginShutdown } from "./infrastructure/shutdown/state.js"
import { withTimeout } from "./infrastructure/async/index.js"
import { ensureStorageDir } from "./infrastructure/storage/index.js"
import {
  setupWebSocket,
  shutdownWebSockets,
} from "./infrastructure/websocket/index.js"
import { parseJsonBodyWithRawCapture } from "./infrastructure/http/json-body-parser.js"

// Module imports
import authModule from "./modules/auth/index.js"
import workspaceModule from "./modules/workspace/index.js"
import workspaceResourcesModule from "./modules/workspace-resources/index.js"
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
import imModule from "./modules/im/index.js"
import installerModule from "./modules/installer/index.js"
import logsModule from "./modules/logs/index.js"
import reportsModule from "./modules/reports/index.js"
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
  startDocExtractionSweeper,
  stopDocExtractionSweeper,
} from "./workers/doc-extraction-sweeper.js"
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
  getEmbeddingHealth,
  warmEmbeddingProvider,
} from "./modules/embedding/index.js"
import { assertEmbeddingSpaceConsistent } from "./modules/memory/embedding-space-guard.js"

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
  // Single shared pino instance (infrastructure/logger): app logs and request
  // logs are now one logger, so level/format never drift. Fastify-compatible
  // req/res/err serializers + pino-pretty-in-dev are baked into the instance
  // (passing an instance bypasses Fastify's own serializer injection).
  // Cast to FastifyBaseLogger so Fastify's `Logger` generic resolves to the
  // default (not the concrete pino Logger type) — otherwise `app` would not be
  // assignable to helpers typed as FastifyInstance<…, FastifyBaseLogger>.
  const app = Fastify({
    logger: logger as FastifyBaseLogger,
    // Stable per-request id. We do NOT derive it from the active span: Fastify
    // calls genReqId before @fastify/otel's onRequest span exists, so a
    // span-derived id would never match. Correlation across logs/traces is via
    // the trace_id that the pino mixin adds to every in-handler log line.
    genReqId: () => randomUUID(),
  })

  // Fastify route/handler/hook spans (OpenTelemetry). MUST be registered before
  // routes so it can intercept their definitions.
  await app.register(fastifyOtelInstrumentation.plugin())

  // Sentry's Fastify error handler — Fastify v4 requires explicit setup or route
  // errors never reach Sentry. No-op when SENTRY_DSN is unset.
  setupSentryErrorHandler(app)

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    parseJsonBodyWithRawCapture
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

    const code = (() => {
      if (statusCode >= 500) {
        return "internal_server_error"
      }
      if (typeof (error as { code?: unknown }).code === "string") {
        return (error as { code: string }).code
      }
      return "request_error"
    })()

    return reply.status(statusCode).send({
      error:
        statusCode >= 500
          ? "Internal Server Error"
          : error.message || "Request failed",
      code,
    })
  })

  // Plugins
  await app.register(cors, {
    origin: true,
    credentials: true,
    // Let cross-origin JS read the trace-id headers (same-origin can already).
    exposedHeaders: ["server-timing", "traceresponse"],
  })
  await app.register(cookie)
  await app.register(websocket)
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } })
  // Opt-in per-route rate limiting: global:false means a route enables it via
  // its config.rateLimit (POST /api/v1/logs, /api/v1/reports). Key by the
  // nginx-set X-Real-IP — NOT the leftmost X-Forwarded-For token, which is
  // client-spoofable (nginx APPENDS its peer to the right of any client XFF, so
  // the left token is attacker-controlled and an unauthenticated endpoint like
  // /api/v1/reports could rotate it to evade the cap). nginx sets X-Real-IP to
  // $remote_addr and proxies /api/ straight to the api, so it is the true client
  // IP here; fall back to req.ip if the header is absent (direct in-network hit).
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => {
      const realIp = req.headers["x-real-ip"]
      const real = Array.isArray(realIp) ? realIp[0] : realIp
      return real?.trim() || req.ip
    },
  })

  // Ensure storage directory exists
  await ensureStorageDir()

  // Server-Timing response header (per-request timing + gated trace_id -> RUM).
  await app.register(serverTiming)

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

  // Fail LOUD if the active embedding provider's dimension/space doesn't match the
  // pgvector columns + existing memory (a corrupting swap or an un-migrated DDL).
  // Skipped for provider=none. See docs/embedding-abstraction-layer-plan §5.
  try {
    await assertEmbeddingSpaceConsistent()
  } catch (err) {
    log.error({ err }, "Embedding space preflight failed")
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
  await app.register(workspaceResourcesModule)
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
  await app.register(logsModule)
  await app.register(reportsModule)
  await app.register(platformModule)
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
    const [db, dbSchema, rds] = await Promise.all([
      testConnection(),
      testRequiredSchema(),
      testRedisConnection(),
    ])
    return {
      status: db && dbSchema && rds ? "healthy" : "degraded",
      services: {
        database: db,
        databaseSchema: dbSchema,
        redis: rds,
        // Informational only — memory degrades to lexical-only when embedding is
        // down, so it must NOT pin /health to degraded. Non-blocking snapshot (no
        // synchronous provider round-trip).
        embedding: getEmbeddingHealth(),
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
  startDocExtractionSweeper()
  await ensureRemoteAgentDeliveryRetryJob()
  startRemoteAgentDeliveryRetryWorker()
  void warmEmbeddingProvider().catch((err) => {
    log.error({ err }, "Failed to warm embedding provider")
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
        "doc-extraction sweeper shutdown",
        stopDocExtractionSweeper(),
        3000
      ).catch((err) => {
        app.log.error({ err }, "Doc-extraction sweeper shutdown timed out")
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
      // Flush + close telemetry last so buffered spans/Sentry events from the
      // shutdown path are not lost.
      await waitWithTimeout("telemetry flush", shutdownTelemetry(), 3000).catch(
        (err) => {
          app.log.error({ err }, "Telemetry flush timed out")
        }
      )
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
