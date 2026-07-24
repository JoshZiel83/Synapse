import { z } from "zod"

/**
 * Declarative runtime-tuning config (memory recall/ranking + realtime-outbox
 * dispatcher knobs). These are non-secret performance/algorithm parameters that
 * a developer iterates on — nested and bounded, so they read far better as a
 * validated JSON object than as a wall of flat SCREAMING_SNAKE env vars.
 *
 * This schema is the single source of truth for:
 *   - the generated JSON Schema (schemas/runtime-tuning.schema.json) that gives
 *     editor autocomplete + validation, and
 *   - runtime-tuning-bootstrap.ts, which validates an operator's
 *     runtime-tuning.json and injects its values into process.env (set-if-absent)
 *     so the central config schema in config/index.ts reads them unchanged.
 *
 * Every field is OPTIONAL and generation-friendly (plain bounds, no
 * z.preprocess/z.coerce). This schema declares NO .default(): the runtime default
 * for an omitted knob is applied solely by the central config schema
 * (config/index.ts), so the coercion/bounds/fallback stay single-sourced. (The
 * default VALUES are additionally echoed in prose in each .describe() and in the
 * .example file for discoverability — documentation kept in sync by hand.)
 * strictObject at every level so a misspelled knob is rejected loudly (and the
 * generated schema carries additionalProperties:false, flagging typos in-editor).
 */
export const runtimeTuningSchema = z.strictObject({
  memory: z
    .strictObject({
      recallLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "How many memories a recall returns to the model. Default 6."
        ),
      searchCandidateLimit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Candidate pool size fetched before ranking/MMR trims to the recall limit. Default 40."
        ),
      recallTopK: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Override for the reranker's top-K; when unset it follows recallLimit. Default: recallLimit."
        ),
      indexQueueConcurrency: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Concurrent memory-indexing (embedding) jobs. Default 2."),
      mmrLambda: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "MMR diversity weight in [0,1]: higher favors relevance, lower favors diversity. Default 0.8."
        ),
      mmrCandidateMultiplier: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "MMR considers mmrCandidateMultiplier × recall-limit candidates. Default 4."
        ),
      summaryDecayHalfLifeDays: z
        .number()
        .positive()
        .optional()
        .describe(
          "Half-life (days) of the recency decay applied to summary relevance. Default 30."
        ),
      summaryDecayFloor: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Lower bound in [0,1] the recency-decay multiplier never drops below. Default 0.35."
        ),
    })
    .optional()
    .describe("Semantic-memory recall + ranking knobs."),
  realtimeOutbox: z
    .strictObject({
      batchSize: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Rows the realtime-outbox dispatcher claims per poll. Default 100."
        ),
      pollMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Dispatcher poll interval in ms. Default 500."),
      retentionHours: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Hours dispatched outbox rows are kept for debugging before GC (0 = delete on dispatch). Default 24."
        ),
      gcIntervalMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "How often the dispatcher runs its GC sweep, in ms. Default 60000."
        ),
      processingTimeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "How long a row may sit in 'processing' before it is treated as abandoned and reclaimed, in ms. Must exceed worst-case publish latency. Default 30000."
        ),
    })
    .optional()
    .describe("Realtime event-outbox dispatcher knobs."),
})

export type RuntimeTuning = z.infer<typeof runtimeTuningSchema>

/**
 * Binds each tuning field to the env var the central config schema reads. The
 * bootstrap injects `String(value)` under `env` (set-if-absent), so the existing
 * env vars remain the override layer and the single source of coercion/bounds.
 */
export const RUNTIME_TUNING_ENV_BINDINGS = [
  { section: "memory", key: "recallLimit", env: "MEMORY_RECALL_LIMIT" },
  {
    section: "memory",
    key: "searchCandidateLimit",
    env: "MEMORY_SEARCH_CANDIDATE_LIMIT",
  },
  { section: "memory", key: "recallTopK", env: "MEMORY_RECALL_TOP_K" },
  {
    section: "memory",
    key: "indexQueueConcurrency",
    env: "MEMORY_INDEX_QUEUE_CONCURRENCY",
  },
  { section: "memory", key: "mmrLambda", env: "MEMORY_MMR_LAMBDA" },
  {
    section: "memory",
    key: "mmrCandidateMultiplier",
    env: "MEMORY_MMR_CANDIDATE_MULTIPLIER",
  },
  {
    section: "memory",
    key: "summaryDecayHalfLifeDays",
    env: "MEMORY_SUMMARY_DECAY_HALF_LIFE_DAYS",
  },
  {
    section: "memory",
    key: "summaryDecayFloor",
    env: "MEMORY_SUMMARY_DECAY_FLOOR",
  },
  {
    section: "realtimeOutbox",
    key: "batchSize",
    env: "REALTIME_OUTBOX_BATCH_SIZE",
  },
  { section: "realtimeOutbox", key: "pollMs", env: "REALTIME_OUTBOX_POLL_MS" },
  {
    section: "realtimeOutbox",
    key: "retentionHours",
    env: "REALTIME_OUTBOX_RETENTION_HOURS",
  },
  {
    section: "realtimeOutbox",
    key: "gcIntervalMs",
    env: "REALTIME_OUTBOX_GC_INTERVAL_MS",
  },
  {
    section: "realtimeOutbox",
    key: "processingTimeoutMs",
    env: "REALTIME_OUTBOX_PROCESSING_TIMEOUT_MS",
  },
] as const

/**
 * Flatten a validated tuning document to the `{ env, value }` overrides it
 * specifies (only keys the operator actually set — omitted knobs keep the
 * central schema's default).
 */
export function runtimeTuningEnvOverrides(
  tuning: RuntimeTuning
): Array<{ env: string; value: string }> {
  const out: Array<{ env: string; value: string }> = []
  for (const binding of RUNTIME_TUNING_ENV_BINDINGS) {
    const section = tuning[binding.section]
    if (!section) continue
    const value = (section as Record<string, unknown>)[binding.key]
    if (value === undefined) continue
    out.push({ env: binding.env, value: String(value) })
  }
  return out
}
