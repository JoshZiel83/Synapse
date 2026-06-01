import pino from "pino"

/**
 * Process-wide structured logger.
 *
 * Fastify owns its own request-scoped logger (configured in index.ts); this
 * is the logger for everything that runs OUTSIDE a request — module-load-time
 * config/crypto validation, workers, queue processors, IM connectors, and any
 * service code that previously reached for `console.*`.
 *
 * It deliberately mirrors the Fastify logger config (pino-pretty in dev, raw
 * JSON in prod) so a single log stream stays consistent across both halves.
 *
 * LOG_LEVEL overrides the level; default is "debug" in development and "info"
 * otherwise. We read process.env directly (not the typed config) because the
 * config module itself logs through this logger during validation, so this
 * must have no dependency on config.
 */
const isDev = (process.env.NODE_ENV || "development") === "development"

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
})

/**
 * Create a child logger tagged with a module/scope name so log lines are
 * attributable (e.g. `logger.info()` in the crypto module shows scope=crypto).
 */
export function createLogger(scope: string) {
  return logger.child({ scope })
}
