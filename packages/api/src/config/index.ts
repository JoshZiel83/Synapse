// Load .env FIRST (before the logger or this schema read process.env). This is
// a side-effect import and is intentionally placed above the others.
import "../infrastructure/env-bootstrap.js"
import { resolve } from "node:path"
import { z } from "zod"

import { createLogger } from "../infrastructure/logger/index.js"

const log = createLogger("config")

/**
 * Validated environment schema.
 *
 * Every value the app reads from process.env goes through here so that:
 *   - numbers are real numbers in sane ranges (a typo'd PORT=abc fails at
 *     startup instead of becoming NaN deep in the request path),
 *   - defaults live in exactly one place,
 *   - a misconfiguration is reported as one aggregated, readable error.
 *
 * Defaults are preserved exactly from the previous hand-rolled config so this
 * is a behaviour-preserving change — we validate and coerce, we do not newly
 * require values that used to be optional.
 *
 * `withDefault(schema, def)` reproduces the old `process.env.X || "def"`
 * semantics precisely: a MISSING *or EMPTY* var falls back to the default
 * before coercion+validation (a bare zod .default()/.prefault() would let an
 * empty string through to coercion and turn "" into NaN/0).
 */
function withDefault<T extends z.ZodType>(schema: T, def: string) {
  return z.preprocess((v) => (v === undefined || v === "" ? def : v), schema)
}

const port = z.coerce.number().int().min(1).max(65535)
const positiveInt = z.coerce.number().int().positive()
const nonNegativeInt = z.coerce.number().int().min(0)
const unitFloat = z.coerce.number().min(0).max(1)
const positiveFloat = z.coerce.number().positive()

/**
 * An optional positive int that treats a MISSING *or EMPTY* var as "unset"
 * (undefined) rather than coercing "" → 0 → validation failure. Matches the
 * old `process.env.X ? parseInt(X) : fallback` semantics for optional knobs.
 */
function optionalPositiveInt() {
  return z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : v),
    positiveInt.optional()
  )
}

const envSchema = z
  .object({
    PORT: withDefault(port, "3001"),
    HOST: withDefault(z.string().min(1), "0.0.0.0"),
    // Not an enum: deployments use values beyond development/production/test
    // (e.g. "staging"), and rejecting those would block startup. Consumers that
    // care about a specific mode compare the string themselves.
    NODE_ENV: withDefault(z.string().min(1), "development"),

    APP_BASE_URL: z.string().optional(),
    NEXT_PUBLIC_APP_URL: z.string().optional(),
    NEXT_PUBLIC_SITE_URL: z.string().optional(),

    PUBLIC_NPM_REGISTRY_URL: withDefault(z.string(), ""),

    DATABASE_URL: withDefault(
      z.string().min(1),
      "postgresql://synapse:password@localhost:5432/synapse"
    ),
    REDIS_URL: withDefault(z.string().min(1), "redis://localhost:6379"),

    REALTIME_OUTBOX_BATCH_SIZE: withDefault(positiveInt, "100"),
    REALTIME_OUTBOX_POLL_MS: withDefault(positiveInt, "500"),
    REALTIME_OUTBOX_RETENTION_HOURS: withDefault(nonNegativeInt, "24"),
    REALTIME_OUTBOX_GC_INTERVAL_MS: withDefault(positiveInt, "60000"),

    ASR_PROVIDER: withDefault(z.string().min(1), "volcengine"),
    VOLCENGINE_ASR_APP_ID: withDefault(z.string(), ""),
    VOLCENGINE_ASR_ACCESS_TOKEN: withDefault(z.string(), ""),
    VOLCENGINE_ASR_SECRET_KEY: withDefault(z.string(), ""),
    VOLCENGINE_ASR_RESOURCE_ID: withDefault(
      z.string().min(1),
      "volc.seedasr.sauc.duration"
    ),
    VOLCENGINE_ASR_WS_URL: withDefault(
      z.string().min(1),
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    ),
    VOLCENGINE_ASR_MAX_CONCURRENCY: withDefault(positiveInt, "3"),
    VOLCENGINE_ASR_CONNECT_TIMEOUT_MS: withDefault(positiveInt, "10000"),
    VOLCENGINE_ASR_IDLE_TIMEOUT_MS: withDefault(positiveInt, "15000"),

    IM_RUNTIME_MANAGER_ENABLED: z.string().optional(),

    SKILL_GITHUB_RAW_PROXY_PREFIXES: z.string().optional(),
    SKILL_CLAWHUB_DOWNLOAD_PROXY_ORIGINS: z.string().optional(),

    // Optional override for the declarative model-groups config file location.
    // Absolute paths are used as-is; relative paths resolve against the repo
    // root (NOT process.cwd()). Unset => the importer falls back to the repo's
    // packages/api/config/model-groups.yaml. The default is computed in the
    // importer (which can reach repo-paths), not here.
    MODEL_GROUPS_CONFIG_PATH: z.string().optional(),

    AUDIO_FALLBACK_PROVIDER: withDefault(z.string().min(1), "sherpa-onnx"),
    SHERPA_ONNX_CONFIG_JSON: withDefault(z.string(), ""),
    SHERPA_ONNX_TIMEOUT_MS: withDefault(positiveInt, "15000"),

    IMAGE_FALLBACK_PROVIDER: withDefault(z.string().min(1), "tesseract"),
    TESSERACT_LANGS: withDefault(z.string().min(1), "eng"),
    TESSERACT_LANG_PATH: withDefault(z.string(), ""),
    TESSERACT_CACHE_PATH: withDefault(
      z.string().min(1),
      "/tmp/synapse-tesseract-cache"
    ),
    TESSERACT_TIMEOUT_MS: withDefault(positiveInt, "20000"),

    MEMORY_RECALL_LIMIT: withDefault(positiveInt, "6"),
    MEMORY_SEARCH_CANDIDATE_LIMIT: withDefault(positiveInt, "40"),
    MEMORY_RECALL_TOP_K: optionalPositiveInt(),
    MEMORY_EMBEDDING_MODEL_ID: withDefault(
      z.string().min(1),
      "Xenova/multilingual-e5-small"
    ),
    MEMORY_MODEL_CACHE_DIR: z.string().optional(),
    MEMORY_EMBED_BATCH_SIZE: withDefault(positiveInt, "12"),
    MEMORY_INDEX_QUEUE_CONCURRENCY: withDefault(positiveInt, "2"),
    MEMORY_QUERY_EMBED_CACHE_TTL_SEC: withDefault(nonNegativeInt, "86400"),
    MEMORY_MMR_LAMBDA: withDefault(unitFloat, "0.8"),
    MEMORY_MMR_CANDIDATE_MULTIPLIER: withDefault(positiveInt, "4"),
    MEMORY_SUMMARY_DECAY_HALF_LIFE_DAYS: withDefault(positiveFloat, "30"),
    MEMORY_SUMMARY_DECAY_FLOOR: withDefault(unitFloat, "0.35"),
    MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD: z.string().optional(),

    PLATFORM_ADMIN_EMAILS: withDefault(z.string(), ""),

    // ===== Better Auth =====
    // Session signing secret. Falls back through AUTH_SECRET / APP_SECRET so a
    // single deployment secret can cover both BA and the legacy crypto layer.
    // All three are optional here (empty allowed) and resolved to the first
    // non-empty value below; production missing-secret is enforced in
    // superRefine (NOT via `??`, which would accept an empty string).
    BETTER_AUTH_SECRET: z.string().optional(),
    AUTH_SECRET: z.string().optional(),
    // Browser-facing public origin BA mounts under (redirect_uri + state/session
    // cookies bind to this). MUST be the origin users actually hit (proxies
    // /api/v1 -> API), not the internal API origin. Falls back to app.baseUrl.
    AUTH_TRUSTED_ORIGINS: withDefault(z.string(), ""),

    // ===== Feishu / Lark OAuth (genericOAuth provider) =====
    FEISHU_APP_ID: withDefault(z.string(), ""),
    FEISHU_APP_SECRET: withDefault(z.string(), ""),
    // "true" => Lark international (open.larksuite.com); else Feishu (open.feishu.cn).
    FEISHU_INTL: z.string().optional(),

    LOG_LEVEL: z.string().optional(),

    // Secret-at-rest master passphrase (crypto/index.ts). Required in production
    // so a missing key fails at STARTUP — not on the first encrypt/decrypt.
    MCP_ENCRYPTION_KEY: z.string().optional(),
    APP_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === "production" &&
      !env.MCP_ENCRYPTION_KEY &&
      !env.APP_SECRET
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["MCP_ENCRYPTION_KEY"],
        message:
          "MCP_ENCRYPTION_KEY (or APP_SECRET) is required in production to " +
          "encrypt sensitive plugin/IM credentials at rest",
      })
    }
    // Better Auth needs a stable signing secret in production. Resolve the same
    // first-non-empty fallback used below; "" must NOT count as a valid secret.
    if (env.NODE_ENV === "production") {
      const authSecret = firstNonEmpty([
        env.BETTER_AUTH_SECRET,
        env.AUTH_SECRET,
        env.APP_SECRET,
      ])
      if (!authSecret) {
        ctx.addIssue({
          code: "custom",
          path: ["BETTER_AUTH_SECRET"],
          message:
            "BETTER_AUTH_SECRET (or AUTH_SECRET / APP_SECRET) is required in " +
            "production to sign auth sessions",
        })
      }
    }
  })

/**
 * First trim-non-empty string, or undefined. Used for secret fallback so a
 * present-but-empty env var (e.g. `BETTER_AUTH_SECRET=`) correctly falls through
 * to the next candidate instead of being treated as a valid empty secret (which
 * `a ?? b ?? c` would do).
 */
function firstNonEmpty(
  values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function loadEnvOrExit(): z.infer<typeof envSchema> {
  const parsed = envSchema.safeParse(process.env)
  if (parsed.success) return parsed.data

  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n")
  log.fatal(`Invalid environment configuration:\n${issues}`)
  // Configuration errors are unrecoverable — refuse to start with bad config
  // rather than limp along with NaN/undefined values deep in the request path.
  process.exit(1)
}

const env = loadEnvOrExit()

function splitList(value: string | undefined): string[] {
  return (value || "")
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export const config = {
  port: env.PORT,
  host: env.HOST,
  nodeEnv: env.NODE_ENV,
  app: {
    baseUrl:
      env.APP_BASE_URL ||
      env.NEXT_PUBLIC_APP_URL ||
      env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3001",
  },
  sandbox: {
    // Per-session file sandbox (device-runtime + content-addressed mounts).
    // Off by default: provisioning spawns a device-runtime child + requires the
    // fs-helper binary, so it stays opt-in until an environment is validated.
    enabled:
      (process.env.SYNAPSE_SANDBOX_ENABLED || "").toLowerCase() === "true",
  },
  remoteAgent: {
    // The npm registry URL embedded in the daemon install command shown
    // on the dashboard. This is the EXTERNAL-reachable URL the end
    // user's machine will hit — it must NOT be an internal/publish-side
    // address (e.g. http://verdaccio:4873 inside Docker/K8s). Kept
    // separate from the publish-side NPM_REGISTRY for exactly that
    // reason. Empty string = omit the --registry flag (user is expected
    // to have configured @synapse:registry in their own ~/.npmrc).
    npmRegistryUrl: env.PUBLIC_NPM_REGISTRY_URL,
  },
  database: {
    url: env.DATABASE_URL,
  },
  redis: {
    url: env.REDIS_URL,
  },
  realtime: {
    outboxBatchSize: env.REALTIME_OUTBOX_BATCH_SIZE,
    outboxPollMs: env.REALTIME_OUTBOX_POLL_MS,
    // How long to keep dispatched outbox rows for ops debugging
    // before GC sweeps them. Default 24h matches the plan's
    // verification window. Set to 0 to delete-on-dispatch (no debug
    // window). 'failed' rows are NEVER GC'd regardless of retention
    // because the dispatcher still retries them — see
    // gcRealtimeEventOutbox in infrastructure/events/index.ts.
    outboxRetentionHours: env.REALTIME_OUTBOX_RETENTION_HOURS,
    // How often the dispatcher loop runs the GC sweep. 1 minute is
    // fine — GC just trims stale rows; missing a window doesn't lose
    // events.
    outboxGcIntervalMs: env.REALTIME_OUTBOX_GC_INTERVAL_MS,
  },
  asr: {
    provider: env.ASR_PROVIDER,
    volcengine: {
      appId: env.VOLCENGINE_ASR_APP_ID,
      accessToken: env.VOLCENGINE_ASR_ACCESS_TOKEN,
      secretKey: env.VOLCENGINE_ASR_SECRET_KEY,
      resourceId: env.VOLCENGINE_ASR_RESOURCE_ID,
      wsUrl: env.VOLCENGINE_ASR_WS_URL,
      maxConcurrency: env.VOLCENGINE_ASR_MAX_CONCURRENCY,
      connectTimeoutMs: env.VOLCENGINE_ASR_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: env.VOLCENGINE_ASR_IDLE_TIMEOUT_MS,
    },
  },
  im: {
    runtimeManagerEnabled: env.IM_RUNTIME_MANAGER_ENABLED !== "false",
  },
  skills: {
    import: {
      githubRawProxyPrefixes: splitList(env.SKILL_GITHUB_RAW_PROXY_PREFIXES),
      clawhubDownloadProxyOrigins: splitList(
        env.SKILL_CLAWHUB_DOWNLOAD_PROXY_ORIGINS
      ),
    },
  },
  modelGroups: {
    // Optional override for the declarative config file. undefined => importer
    // uses the repo-default path. May be absolute or repo-root-relative.
    configPath: env.MODEL_GROUPS_CONFIG_PATH,
  },
  audioFallback: {
    provider: env.AUDIO_FALLBACK_PROVIDER,
    sherpaOnnxConfigJson: env.SHERPA_ONNX_CONFIG_JSON,
    timeoutMs: env.SHERPA_ONNX_TIMEOUT_MS,
  },
  imageFallback: {
    provider: env.IMAGE_FALLBACK_PROVIDER,
    tesseractLangs: env.TESSERACT_LANGS,
    tesseractLangPath: env.TESSERACT_LANG_PATH,
    tesseractCachePath: env.TESSERACT_CACHE_PATH,
    timeoutMs: env.TESSERACT_TIMEOUT_MS,
  },
  memory: {
    recallLimit: env.MEMORY_RECALL_LIMIT,
    searchCandidateLimit: env.MEMORY_SEARCH_CANDIDATE_LIMIT,
    topK: env.MEMORY_RECALL_TOP_K ?? env.MEMORY_RECALL_LIMIT,
    modelId: env.MEMORY_EMBEDDING_MODEL_ID,
    modelCacheDir:
      env.MEMORY_MODEL_CACHE_DIR ||
      resolve(process.cwd(), "storage/models/memory"),
    embedBatchSize: env.MEMORY_EMBED_BATCH_SIZE,
    indexQueueConcurrency: env.MEMORY_INDEX_QUEUE_CONCURRENCY,
    queryEmbedCacheTtlSec: env.MEMORY_QUERY_EMBED_CACHE_TTL_SEC,
    mmrLambda: env.MEMORY_MMR_LAMBDA,
    mmrCandidateMultiplier: env.MEMORY_MMR_CANDIDATE_MULTIPLIER,
    summaryDecayHalfLifeDays: env.MEMORY_SUMMARY_DECAY_HALF_LIFE_DAYS,
    summaryDecayFloor: env.MEMORY_SUMMARY_DECAY_FLOOR,
    allowRuntimeModelDownload:
      env.MEMORY_ALLOW_RUNTIME_MODEL_DOWNLOAD === "true",
  },
  platform: {
    adminEmails: env.PLATFORM_ADMIN_EMAILS.split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },
  auth: {
    // Session signing secret: first non-empty of the three candidates. In
    // development a deterministic dev secret is used so local sessions survive
    // restarts; production missing-secret is rejected at startup (superRefine).
    secret:
      firstNonEmpty([
        env.BETTER_AUTH_SECRET,
        env.AUTH_SECRET,
        env.APP_SECRET,
      ]) ?? "dev-insecure-better-auth-secret",
    // Public browser origin BA mounts under (drives OAuth redirect_uri + the
    // origin where session/state cookies land). Defaults to app.baseUrl.
    baseUrl:
      env.APP_BASE_URL ||
      env.NEXT_PUBLIC_APP_URL ||
      env.NEXT_PUBLIC_SITE_URL ||
      "http://localhost:3001",
    trustedOrigins: splitList(env.AUTH_TRUSTED_ORIGINS),
  },
  feishu: {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    intl: env.FEISHU_INTL === "true",
  },
} as const
