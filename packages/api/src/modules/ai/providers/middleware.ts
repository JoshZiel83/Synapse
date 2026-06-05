/**
 * Cross-cutting middleware for wrapped language models.
 *
 * Composed via wrapLanguageModel({ model, middleware: [traceMiddleware] }).
 * Today this is a thin debug-trace pass-through; it is the seam where future
 * concerns (Anthropic prompt-cache defaults, retry shaping, redaction) attach
 * without touching the canonical layer or the per-call site.
 */
import type { LanguageModelMiddleware } from "ai"
import { createLogger } from "../../../infrastructure/logger/index.js"

const log = createLogger("ai.sdk")

/**
 * Debug-level trace of each generate call: model id + param shape on the way in,
 * finish reason + token counts on the way out. No-op at info level and above.
 */
export const traceMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate, model, params }) => {
    const start = Date.now()
    log.debug(
      {
        modelId: model.modelId,
        provider: model.provider,
        toolCount: Array.isArray(params.tools) ? params.tools.length : 0,
      },
      "[ai.sdk] doGenerate start"
    )
    try {
      const result = await doGenerate()
      log.debug(
        {
          modelId: model.modelId,
          finishReason: result.finishReason,
          latencyMs: Date.now() - start,
        },
        "[ai.sdk] doGenerate done"
      )
      return result
    } catch (err: any) {
      log.debug(
        {
          modelId: model.modelId,
          err: err?.message,
          latencyMs: Date.now() - start,
        },
        "[ai.sdk] doGenerate error"
      )
      throw err
    }
  },
}

export const defaultMiddleware: LanguageModelMiddleware[] = [traceMiddleware]
